"use client";

import { useState, useEffect, useCallback } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { matchOverride } from "open-sse/providers/modelOverrideMatch.js";

// Module cache: one /api/models fetch shared by every useModelCaps instance.
let cache = null; // { byFull, byId } | null
let inflight = null;
// Override entries parsed server-side, shipped with /api/models. The browser has
// no file to read, so these are what make an override visible for a model that
// is missing from the maps below.
let overrides = [];

function buildMaps(models) {
  const byFull = {};
  const byId = {};
  for (const m of models || []) {
    if (!m.caps) continue;
    if (m.fullModel) byFull[m.fullModel] = m.caps;
    if (m.routedModel) byFull[m.routedModel] = m.caps;
    if (m.model) byId[m.model] = m.caps;
  }
  return { byFull, byId };
}

function loadModelCaps() {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/models")
    .then(async (res) => {
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = await res.json();
      cache = buildMaps(data.models);
      overrides = Array.isArray(data.overrides) ? data.overrides : [];
      return cache;
    })
    .catch(() => {
      // Keep null so a later mount can retry
      return { byFull: {}, byId: {} };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// Resolve caps from a "provider/model" string or a bare model id.
function resolveCaps(byFull, byId, key) {
  if (!key) return null;
  if (byFull[key]) return byFull[key];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (byId[bare]) return byId[bare];
  const provider = key.includes("/") ? key.slice(0, key.indexOf("/")) : null;
  const c = getCapabilitiesForModel(provider, bare);
  const base = {
    vision: c.vision,
    search: c.search,
    reasoning: c.reasoning,
    contextWindow: c.contextWindow,
    maxOutput: c.maxOutput,
  };
  // The client copy of capabilities.js has no override reader (the server
  // installs it at startup and instrumentation never runs in the browser), so
  // apply the entries shipped by /api/models here. Without this, a model absent
  // from the maps above — e.g. one whose id the registry spells differently —
  // silently fell back to the built-in tables and the override never showed.
  const override = matchOverride(overrides, provider, bare);
  if (!override) return base;
  const merged = { ...base };
  for (const k of ["contextWindow", "maxOutput", "vision", "search", "reasoning"]) {
    if (override[k] !== undefined) merged[k] = override[k];
  }
  return merged;
}

export function useModelCaps() {
  const [byFull, setByFull] = useState(() => cache?.byFull || {});
  const [byId, setById] = useState(() => cache?.byId || {});

  useEffect(() => {
    let alive = true;
    const sync = (maps) => {
      if (alive) { setByFull(maps.byFull); setById(maps.byId); }
    };
    if (cache) {
      sync(cache);
    } else {
      loadModelCaps().then(sync);
    }
    // Custom models change at runtime — drop the shared cache and refetch.
    // Model overrides change it too: the overrides page saves to YAML, so the
    // caps computed by /api/models are stale until this map is rebuilt.
    const invalidate = () => {
      cache = null;
      loadModelCaps().then(sync);
    };
    window.addEventListener("customModelChanged", invalidate);
    window.addEventListener("modelOverridesChanged", invalidate);
    return () => {
      alive = false;
      window.removeEventListener("customModelChanged", invalidate);
      window.removeEventListener("modelOverridesChanged", invalidate);
    };
  }, []);

  const getCaps = useCallback(
    (key) => resolveCaps(byFull, byId, key),
    [byFull, byId],
  );

  return { getCaps };
}
