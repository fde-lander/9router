// Read side of the user-editable model capability overrides.
//
// The file is the source of truth; the only thing held in memory is a parsed
// copy dropped as soon as the file's mtime changes. getCapabilitiesForModel is
// synchronous and runs per request, so the hot path is one stat (~1us) and the
// parse only reruns after the file is edited.
//
// A parse failure KEEPS the last good cache and logs a loud error: a typo in
// the YAML must never silently drop every override the user configured.
//
// The matching rules live in ./modelOverrideMatch.js, which has no imports so
// the browser can use the same logic. This file owns only the file I/O.

import fs from "node:fs";
import path from "node:path";
import { parseYAML } from "confbox";
import { DATA_DIR } from "@/lib/dataDir.js";
import { matchOverride, validateEntry } from "./modelOverrideMatch.js";

export const OVERRIDES_FILE = path.join(DATA_DIR, "model-overrides.yaml");

const EMPTY = [];
let cache = EMPTY;
let cachedMtime = -1;
let lastGoodCount = 0;

function load() {
  let mtime;
  try {
    mtime = fs.statSync(OVERRIDES_FILE).mtimeMs;
  } catch {
    // No file is the normal "feature unused" state — stay quiet.
    if (cache !== EMPTY) {
      console.log("[model-overrides] Overrides file removed — all overrides cleared.");
    }
    cache = EMPTY;
    cachedMtime = -1;
    lastGoodCount = 0;
    return cache;
  }
  if (mtime === cachedMtime) return cache;

  cachedMtime = mtime;
  let text;
  try {
    text = fs.readFileSync(OVERRIDES_FILE, "utf8");
  } catch (err) {
    console.error(`[model-overrides] Cannot read ${OVERRIDES_FILE}: ${err?.message || err}`);
    return cache;
  }

  try {
    const parsed = parseYAML(text);
    const list = Array.isArray(parsed?.overrides) ? parsed.overrides : [];
    if (parsed && parsed.overrides !== undefined && !Array.isArray(parsed.overrides)) {
      console.error(
        `[model-overrides] ${OVERRIDES_FILE}: top-level "overrides" must be a list — ` +
        `kept the previous ${lastGoodCount} entr${lastGoodCount === 1 ? "y" : "ies"}.`
      );
      return cache;
    }
    const entries = list.map((raw, i) => validateEntry(raw, i)).filter(Boolean);
    cache = entries;
    lastGoodCount = entries.length;
    console.log(
      `[model-overrides] Loaded ${entries.length} override${entries.length === 1 ? "" : "s"} ` +
      `from ${OVERRIDES_FILE} — file parsed OK.`
    );
    return cache;
  } catch (err) {
    const mark = err?.mark;
    const where = mark ? ` at line ${mark.line + 1}, column ${mark.column + 1}` : "";
    const reason = err?.reason || err?.message || String(err);
    console.error(
      `[model-overrides] YAML PARSE FAILED${where}: ${reason}\n` +
      `[model-overrides] File: ${OVERRIDES_FILE}\n` +
      `[model-overrides] Kept the previous ${lastGoodCount} entr${lastGoodCount === 1 ? "y" : "ies"} ` +
      `so running traffic is unaffected. Fix the YAML and save again — it reloads automatically.`
    );
    return cache;
  }
}

/**
 * Resolve the override for a provider + model pair.
 * Matching semantics (tiers, merging, hyphen/dot tolerance) are documented on
 * matchOverride in ./modelOverrideMatch.js.
 *
 * @returns {object|null}
 */
export function getModelOverride(provider, model) {
  return matchOverride(load(), provider, model);
}

// Force a re-read on the next lookup.
export function invalidateModelOverrides() {
  cachedMtime = -1;
}

/**
 * The validated override entries, for consumers that must apply the same rules
 * elsewhere. The dashboard needs this: its fallback capability lookup runs in
 * the browser, where there is no file to read, so /api/models ships the parsed
 * entries and the client matches them with the shared matchOverride().
 *
 * @returns {object[]}
 */
export function getModelOverrideEntries() {
  return load();
}

// Hand the reader to capabilities.js. That module is bundled into the browser
// too, so it cannot import this file directly — the server pushes it in.
export async function installModelOverrideSource() {
  const { setModelOverrideSource } = await import("./capabilities.js");
  setModelOverrideSource({ getOverride: getModelOverride });
  // Prime the cache so the startup log states the YAML status before any
  // request arrives — the operator should never have to guess.
  load();
}
