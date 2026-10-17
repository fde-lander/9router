// Pure matching logic for model capability overrides.
//
// Extracted from modelOverrides.js so it can run in BOTH environments:
//   • the server, which reads the YAML file (modelOverrides.js)
//   • the browser, which receives the parsed entries from /api/models/overrides
//
// This module deliberately has NO imports. modelOverrides.js needs node:fs and
// @/lib/dataDir.js, neither of which exists in the browser bundle, so the
// matcher cannot live there — but the two sides must agree on what matches, or
// the dashboard would show different numbers than the router actually uses.
//
// Why the browser needs this at all (measured 2026-09-28): the Combos page
// resolves caps through useModelCaps, which builds a map from GET /api/models
// and falls back to a CLIENT-SIDE getCapabilitiesForModel for anything missing
// from that map. The browser copy of capabilities.js has no override reader
// (src/instrumentation.js only runs on the server), so any model absent from the
// map — including one whose id the registry does not spell the same way —
// resolved to the built-in tables and the override was invisible.

export const BOOL_KEYS = [
  "vision", "pdf", "audioInput", "videoInput",
  "imageOutput", "audioOutput", "search", "tools", "reasoning",
];

export const NUM_KEYS = ["contextWindow", "maxOutput"];

export function normalize(str) {
  return String(str || "").trim().toLowerCase();
}

// "zai-org/GLM-5.3-Flash:free" -> "glm-5.3-flash"
export function baseId(model) {
  if (!model) return "";
  const withoutVendor = model.includes("/") ? model.split("/").pop() : model;
  return normalize(withoutVendor.split(":")[0]);
}

// Collapse digit-hyphen-digit to digit-dot-digit so an id written either way
// resolves to the same string: "glm-5-3-flash" == "glm-5.3-flash".
//
// Why: MASTER's provider names the model with HYPHENS ("glm-5-3-flash") while
// the registry spells versioned ids with DOTS ("glm-5.3-flash"). The provider's
// name is authoritative and must keep working, so the matcher tolerates both
// rather than asking the operator to retype the id. Same normalisation the
// registry already applies for kiro
// (open-sse/providers/models/schema.js normalizeModelId).
//
// Built on baseId so a vendor prefix and ":tag" suffix are already gone —
// otherwise "zai-org/glm-5-3-flash:free" would canonicalise to a string that
// still carries the prefix and could never equal a bare request id.
//
// Only the digit-hyphen-digit shape is rewritten. "model-123" keeps a hyphen
// ("model-1.2.3") and cannot collide with "model123".
export function canon(str) {
  return baseId(str).replace(/(\d)-(\d)/g, "$1.$2");
}

/**
 * Validate one raw YAML entry into a usable override, or null if unusable.
 * @param {object} raw
 * @param {number} index zero-based position, for log messages
 * @param {(msg: string) => void} [warn] sink for problems (defaults to console.warn)
 */
export function validateEntry(raw, index, warn = console.warn) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn(`[model-overrides] Entry #${index + 1} is not a mapping — skipped.`);
    return null;
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model) {
    warn(`[model-overrides] Entry #${index + 1} has no "model" field — skipped.`);
    return null;
  }

  const entry = { model };
  if (typeof raw.provider === "string" && raw.provider.trim()) {
    entry.provider = raw.provider.trim();
  }

  for (const key of NUM_KEYS) {
    if (raw[key] === undefined) continue;
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value > 0) {
      entry[key] = Math.floor(value);
    } else {
      warn(
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
      warn(
        `[model-overrides] Entry #${index + 1} (${model}) field "${key}" is not a boolean ` +
        `(got ${JSON.stringify(raw[key])}) — field ignored, other fields still apply.`
      );
    }
  }

  const hasEffect = [...NUM_KEYS, ...BOOL_KEYS].some((k) => entry[k] !== undefined);
  if (!hasEffect) {
    warn(
      `[model-overrides] Entry #${index + 1} (${model}) sets no recognised capability field — skipped.`
    );
    return null;
  }
  return entry;
}

/**
 * Find the override that applies to a provider + model pair.
 *
 * Entries are matched in four specificity tiers, most specific first:
 *   1. provider + model  — both must match, ids equal
 *   2. model             — exact id, any provider
 *   3. model             — vendor prefix stripped (zai-org/glm-5.3 == glm-5.3)
 *   4. model             — canonical form (digit-hyphen-digit == digit.dot.digit,
 *                          so "glm-5-3-flash" matches "glm-5.3-flash")
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
 * @param {object[]} entries validated entries
 * @param {string} provider
 * @param {string} model
 * @returns {object|null}
 */
export function matchOverride(entries, provider, model) {
  if (!entries || !entries.length) return null;

  const m = normalize(model);
  const b = baseId(model);
  const c = canon(model);
  const p = normalize(provider);

  const canonical = []; // tier 3 — digit separator difference only
  const generic = [];   // tier 2 — vendor-stripped id
  const exact = [];     // tier 1 — exact id
  const scoped = [];    // tier 0 — provider + id

  for (const entry of entries) {
    const em = normalize(entry.model);
    const eb = baseId(entry.model);
    const ec = canon(entry.model);
    if (entry.provider) {
      if (p && em === m && normalize(entry.provider) === p) scoped.push(entry);
      continue;
    }
    if (em === m) exact.push(entry);
    else if (eb && eb === b) generic.push(entry);
    else if (ec && ec === c) canonical.push(entry);
  }

  const ordered = [...canonical, ...generic, ...exact, ...scoped];
  if (!ordered.length) return null;
  if (ordered.length === 1) return ordered[0];

  const merged = {};
  for (const entry of ordered) Object.assign(merged, entry);
  return merged;
}
