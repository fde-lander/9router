import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { parseYAML, stringifyYAML } from "confbox";
import { DATA_DIR } from "@/lib/dataDir.js";

export const dynamic = "force-dynamic";

const OVERRIDES_FILE = path.join(DATA_DIR, "model-overrides.yaml");
const BACKUP_FILE = `${OVERRIDES_FILE}.bak`;

const BOOL_KEYS = [
  "vision", "pdf", "audioInput", "videoInput",
  "imageOutput", "audioOutput", "search", "tools", "reasoning",
];

// Regenerated on every write. confbox's parseYAML drops comments, so anything
// inside the "overrides" list cannot survive a round-trip through the editor —
// this header is the one place hand-written notes are safe. Keep it in sync
// with MODEL_OVERRIDES_GUIDE.md.
const FILE_HEADER = `# model-overrides.yaml — custom model capability overrides
#
# Highest priority: these win over every built-in table (provider-specific,
# exact model, pattern, and the floor).
#
# Edit and save; changes are picked up automatically, no restart needed.
# Delete this file to disable all overrides.
#
# Matching (most specific first):
#   1. provider + model  — both must match
#   2. model             — any provider
#   3. model             — vendor prefix ignored (zai-org/glm-5.3 == glm-5.3)
#
# NOTE: this file is rewritten by the dashboard editor, so hand-written
# comments inside the "overrides" list are not preserved. Keep notes here.

`;

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model) return null;

  const entry = { model };
  if (typeof raw.provider === "string" && raw.provider.trim()) {
    entry.provider = raw.provider.trim();
  }
  for (const key of ["contextWindow", "maxOutput"]) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === "") continue;
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `Entry "${model}": ${key} must be a positive number.` };
    }
    entry[key] = Math.floor(value);
  }
  for (const key of BOOL_KEYS) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] !== "boolean") {
      return { error: `Entry "${model}": ${key} must be true or false.` };
    }
    entry[key] = raw[key];
  }
  const hasEffect = ["contextWindow", "maxOutput", ...BOOL_KEYS].some((k) => entry[k] !== undefined);
  if (!hasEffect) {
    return { error: `Entry "${model}": set at least one of contextWindow, maxOutput, or a capability toggle.` };
  }
  return { entry };
}

// GET /api/models/overrides — read the YAML as a list
export async function GET() {
  try {
    if (!fs.existsSync(OVERRIDES_FILE)) {
      return NextResponse.json({ overrides: [], filePath: OVERRIDES_FILE, exists: false });
    }
    const text = fs.readFileSync(OVERRIDES_FILE, "utf8");
    const parsed = parseYAML(text);
    const list = Array.isArray(parsed?.overrides) ? parsed.overrides : [];
    return NextResponse.json({ overrides: list, filePath: OVERRIDES_FILE, exists: true });
  } catch (err) {
    const mark = err?.mark;
    const where = mark ? ` (line ${mark.line + 1}, column ${mark.column + 1})` : "";
    return NextResponse.json(
      {
        error: `YAML parse failed${where}: ${err?.reason || err?.message || err}`,
        filePath: OVERRIDES_FILE,
        exists: true,
      },
      { status: 422 }
    );
  }
}

// POST /api/models/overrides — replace the whole list
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const incoming = Array.isArray(body?.overrides) ? body.overrides : null;
  if (!incoming) {
    return NextResponse.json({ error: '"overrides" must be a list.' }, { status: 400 });
  }

  const entries = [];
  for (const raw of incoming) {
    const result = sanitizeEntry(raw);
    if (result?.error) return NextResponse.json({ error: result.error }, { status: 400 });
    if (result?.entry) entries.push(result.entry);
  }

  try {
    if (fs.existsSync(OVERRIDES_FILE)) {
      fs.copyFileSync(OVERRIDES_FILE, BACKUP_FILE);
    }
    const yaml = FILE_HEADER + stringifyYAML({ overrides: entries });
    const tmp = `${OVERRIDES_FILE}.tmp`;
    fs.writeFileSync(tmp, yaml, "utf8");
    fs.renameSync(tmp, OVERRIDES_FILE);
    return NextResponse.json({ ok: true, count: entries.length, filePath: OVERRIDES_FILE });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to write ${OVERRIDES_FILE}: ${err?.message || err}` },
      { status: 500 }
    );
  }
}
