// Read side of the user-editable model capability overrides.
//
// The file is the source of truth; the only thing held in memory is a parsed
// copy dropped as soon as the file's mtime changes. getCapabilitiesForModel is
// synchronous and runs per request, so the hot path is one stat (~1us) and the
// parse only reruns after the file is edited.
//
// A parse failure KEEPS the last good cache and logs a loud error: a typo in
// the YAML must never silently drop every override the user configured.

import fs from "node:fs";
import path from "node:path";
import { parseYAML } from "confbox";
import { DATA_DIR } from "@/lib/dataDir.js";

export const OVERRIDES_FILE = path.join(DATA_DIR, "model-overrides.yaml");

const EMPTY = [];
let cache = EMPTY;
let cachedMtime = -1;
let lastGoodCount = 0;

// Boolean capability keys an override entry may force on or off. Kept in sync
// with DEFAULT_CAPABILITIES in capabilities.js — anything not listed is ignored
// so a typo cannot inject an unknown key into the capability object.
const BOOL_KEYS = [
  "vision", "pdf", "audioInput", "videoInput",
  "imageOutput", "audioOutput", "search", "tools", "reasoning",
];

function normalize(str) {
  return String(str || "").trim().toLowerCase();
}

// "zai-org/GLM-5.3-Flash:free" -> "glm-5.3-flash"
function baseId(model) {
  if (!model) return "";
  const withoutVendor = model.includes("/") ? model.split("/").pop() : model;
  return normalize(withoutVendor.split(":")[0]);
}

function validateEntry(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(`[model-overrides] Entry #${index + 1} is not a mapping — skipped.`);
    return null;
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model) {
    console.warn(`[model-overrides] Entry #${index + 1} has no "model" field — skipped.`);
    return null;
  }

  const entry = { model };
  if (typeof raw.provider === "string" && raw.provider.trim()) {
    entry.provider = raw.provider.trim();
  }

  for (const key of ["contextWindow", "maxOutput"]) {
    if (raw[key] === undefined) continue;
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value > 0) {
      entry[key] = Math.floor(value);
    } else {
      console.warn(
        `[model-overrides] Entry #${index + 1} (${model}) field "${key}" is not a positive number ` +
        `(got ${JSON.stringify(raw[key])}) — field ignored, other fields still apply.`
      );
    }
  }

  for (const key of BOOL_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === "boolean") {
      entry[key] = raw[key];
    } else {
      console.warn(
        `[model-overrides] Entry #${index + 1} (${model}) field "${key}" is not a boolean ` +
        `(got ${JSON.stringify(raw[key])}) — field ignored, other fields still apply.`
      );
    }
  }

  const hasEffect = ["contextWindow", "maxOutput", ...BOOL_KEYS].some((k) => entry[k] !== undefined);
  if (!hasEffect) {
    console.warn(
      `[model-overrides] Entry #${index + 1} (${model}) sets no recognised capability field — skipped.`
    );
    return null;
  }
  return entry;
}

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
    const entries = list.map(validateEntry).filter(Boolean);
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
 *
 * Entries are matched in three specificity tiers:
 *   1. provider + model  — both must match (most specific)
 *   2. model             — exact id, any provider
 *   3. model             — vendor prefix stripped (zai-org/glm-5.3 == glm-5.3)
 *
 * All matching tiers are then merged least-specific-first, so a more specific
 * entry wins field by field while less specific entries still supply the fields
 * it does not mention.
 *
 * Why merge rather than "first match wins": the documented YAML lets one model
 * carry several entries — typically one for its limits and another for its
 * capability toggles. Under a plain first-match rule the second entry would be
 * silently dead, and a provider-scoped entry would discard every generic value
 * it does not restate. Measured 2026-09-28 against the plan's own example.
 *
 * @returns {object|null}
 */
export function getModelOverride(provider, model) {
  const entries = load();
  if (!entries.length) return null;

  const m = normalize(model);
  const b = baseId(model);
  const p = normalize(provider);

  const generic = [];   // tier 2 — vendor-stripped id
  const exact = [];     // tier 1 — exact id
  const scoped = [];    // tier 0 — provider + id

  for (const entry of entries) {
    const em = normalize(entry.model);
    const eb = baseId(entry.model);
    if (entry.provider) {
      if (p && em === m && normalize(entry.provider) === p) scoped.push(entry);
      continue;
    }
    if (em === m) exact.push(entry);
    else if (eb && eb === b) generic.push(entry);
  }

  const ordered = [...generic, ...exact, ...scoped];
  if (!ordered.length) return null;
  if (ordered.length === 1) return ordered[0];

  const merged = {};
  for (const entry of ordered) Object.assign(merged, entry);
  return merged;
}

// Force a re-read on the next lookup.
export function invalidateModelOverrides() {
  cachedMtime = -1;
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
