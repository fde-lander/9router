"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton, ConfirmModal, Input, Modal, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Boolean capabilities the editor exposes. Mirrors BOOL_KEYS in
// src/app/api/models/overrides/route.js and modelOverrides.js — the three lists
// must agree or a toggle would be silently dropped on save.
const BOOL_KEYS = [
  { key: "vision",       label: "Vision",       hint: "Read images" },
  { key: "pdf",          label: "PDF",          hint: "Read documents" },
  { key: "audioInput",   label: "Audio in",     hint: "Read audio" },
  { key: "videoInput",   label: "Video in",     hint: "Read video" },
  { key: "imageOutput",  label: "Image out",    hint: "Generate images" },
  { key: "audioOutput",  label: "Audio out",    hint: "Generate audio" },
  { key: "search",       label: "Search",       hint: "Built-in web search" },
  { key: "tools",        label: "Tools",        hint: "Function calling" },
  { key: "reasoning",    label: "Reasoning",    hint: "Thinking / reasoning" },
];

const EMPTY_FORM = {
  provider: "",
  model: "",
  contextWindow: "",
  maxOutput: "",
  bools: {}, // { [key]: true|false } — absent means "leave as-is"
};

// A capability badge: filled green when forced ON, hollow grey when forced OFF,
// and not rendered at all when the entry does not mention the key.
function CapBadge({ on }) {
  return (
    <span
      className={
        "px-1.5 py-0.5 rounded-[3px] text-[10px] font-semibold border " +
        (on
          ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
          : "bg-transparent text-text-muted border-border-subtle")
      }
    >
      {on ? "ON" : "OFF"}
    </span>
  );
}

function fmtNum(v) {
  if (v === undefined || v === null || v === "") return "—";
  return Number(v).toLocaleString();
}

export default function ModelOverridesPage() {
  const success = useNotificationStore((s) => s.success);
  const error = useNotificationStore((s) => s.error);
  const { copied, copy } = useCopyToClipboard(2000);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [fileExists, setFileExists] = useState(false);
  const [parseError, setParseError] = useState(null);

  // `entries` is the last state read from / written to disk.
  const [entries, setEntries] = useState([]);
  // `draft` is the working copy the UI edits. Equal to entries when clean.
  const [draft, setDraft] = useState([]);

  const [showForm, setShowForm] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);

  const [deleteIndex, setDeleteIndex] = useState(null);
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/models/overrides", { cache: "no-store" });
      const data = await res.json();
      setFilePath(data.filePath || "");
      setFileExists(Boolean(data.exists));
      if (!res.ok) {
        setParseError(data.error || `HTTP ${res.status}`);
        setEntries([]);
        setDraft([]);
      } else {
        setParseError(null);
        const list = Array.isArray(data.overrides) ? data.overrides : [];
        setEntries(list);
        setDraft(list);
      }
    } catch (e) {
      setParseError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = useMemo(
    () => JSON.stringify(entries) !== JSON.stringify(draft),
    [entries, draft]
  );

  const openAdd = () => {
    setEditingIndex(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setShowForm(true);
  };

  const openEdit = (index) => {
    const e = draft[index] || {};
    const bools = {};
    for (const { key } of BOOL_KEYS) {
      if (typeof e[key] === "boolean") bools[key] = e[key];
    }
    setEditingIndex(index);
    setForm({
      provider: e.provider || "",
      model: e.model || "",
      contextWindow: e.contextWindow === undefined ? "" : String(e.contextWindow),
      maxOutput: e.maxOutput === undefined ? "" : String(e.maxOutput),
      bools,
    });
    setFormError(null);
    setShowForm(true);
  };

  const submitForm = () => {
    const model = form.model.trim();
    if (!model) {
      setFormError("Model is required.");
      return;
    }
    const entry = { model };
    if (form.provider.trim()) entry.provider = form.provider.trim();

    for (const key of ["contextWindow", "maxOutput"]) {
      const raw = String(form[key] ?? "").trim();
      if (raw === "") continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num <= 0) {
        setFormError(`${key} must be a positive number.`);
        return;
      }
      entry[key] = Math.floor(num);
    }
    for (const { key } of BOOL_KEYS) {
      if (typeof form.bools[key] === "boolean") entry[key] = form.bools[key];
    }
    const hasEffect = ["contextWindow", "maxOutput", ...BOOL_KEYS.map((b) => b.key)].some(
      (k) => entry[k] !== undefined
    );
    if (!hasEffect) {
      setFormError("Set at least one of context window, max output, or a capability toggle.");
      return;
    }

    setDraft((prev) => {
      const next = [...prev];
      if (editingIndex === null) next.push(entry);
      else next[editingIndex] = entry;
      return next;
    });
    setShowForm(false);
  };

  const confirmDelete = () => {
    if (deleteIndex === null) return;
    setDraft((prev) => prev.filter((_, i) => i !== deleteIndex));
    setDeleteIndex(null);
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        error(data.error || `Save failed (HTTP ${res.status})`, "Model Overrides");
        return;
      }
      success(`Saved ${data.count} override${data.count === 1 ? "" : "s"}.`, "Model Overrides");
      await load();
    } catch (e) {
      error(String(e?.message || e), "Model Overrides");
    } finally {
      setSaving(false);
    }
  };

  const requestSave = () => {
    // Master rule: a bulk change needs an extra confirmation before it lands.
    const changed = countChanged(entries, draft);
    if (changed > 3) {
      setShowSaveConfirm(true);
      return;
    }
    doSave();
  };

  const doOverwriteEmpty = async () => {
    setDraft([]);
    setShowOverwriteConfirm(false);
    setSaving(true);
    try {
      const res = await fetch("/api/models/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: [] }),
      });
      const data = await res.json();
      if (!res.ok) {
        error(data.error || `Save failed (HTTP ${res.status})`, "Model Overrides");
        return;
      }
      success("File replaced with an empty list.", "Model Overrides");
      await load();
    } catch (e) {
      error(String(e?.message || e), "Model Overrides");
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------------ render

  if (loading) {
    return (
      <div className="space-y-4">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 1. status card */}
      <Card padding="md">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-base font-semibold text-text-main">Model Overrides</h1>
              {parseError ? (
                <Badge variant="error" size="sm">Parse failed</Badge>
              ) : !fileExists ? (
                <Badge variant="default" size="sm">Not created</Badge>
              ) : (
                <Badge variant="success" size="sm">{entries.length} active</Badge>
              )}
            </div>
            <p className="text-xs text-text-muted mt-1">
              YAML overrides win over every built-in capability table. Edit and save — picked up
              automatically, no restart.
            </p>
            {filePath && (
              <button
                type="button"
                onClick={() => copy(filePath, "path")}
                className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-mono text-text-muted hover:text-primary transition-colors cursor-pointer"
                title="Click to copy"
              >
                <span className="material-symbols-outlined text-[13px]">
                  {copied === "path" ? "check" : "content_copy"}
                </span>
                {filePath}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="ghost" size="sm" onClick={load} disabled={saving}>
              Reload
            </Button>
            <Button size="sm" onClick={openAdd}>
              Add entry
            </Button>
          </div>
        </div>

        {parseError && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
            <p className="text-xs font-semibold text-red-600 dark:text-red-400 mb-1">
              The YAML could not be parsed
            </p>
            <pre className="text-[11px] font-mono text-text-muted whitespace-pre-wrap break-all">
              {parseError}
            </pre>
            <p className="text-[11px] text-text-muted mt-2">
              Running traffic keeps using the last valid configuration. Fix the file by hand, or
              replace it with an empty list below.
            </p>
            <div className="mt-2">
              <Button
                variant="danger"
                size="sm"
                onClick={() => setShowOverwriteConfirm(true)}
                disabled={saving}
              >
                Overwrite with empty list
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* 2. entry list */}
      {draft.length === 0 ? (
        <Card padding="md">
          <div className="text-center py-6">
            <span className="material-symbols-outlined text-[32px] text-text-muted">tune</span>
            <p className="text-sm text-text-main mt-2">No overrides configured</p>
            <p className="text-xs text-text-muted mt-1">
              Built-in tables are in use. Add an entry to pin a model&apos;s context window, output
              ceiling, or capabilities.
            </p>
            <div className="mt-3">
              <Button size="sm" onClick={openAdd}>Add entry</Button>
            </div>
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {draft.map((entry, index) => {
            const bools = BOOL_KEYS.filter(({ key }) => typeof entry[key] === "boolean");
            const isEdited =
              JSON.stringify(entries[index]) !== JSON.stringify(entry) ||
              index >= entries.length;
            return (
              <Card key={`${entry.model}-${index}`} padding="sm" hover>
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-text-main truncate">
                        {entry.model}
                      </span>
                      {entry.provider && (
                        <Badge variant="primary" size="sm">{entry.provider}</Badge>
                      )}
                      {isEdited && <Badge variant="warning" size="sm">unsaved</Badge>}
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <span className="text-[11px] text-text-muted">
                        ctx <span className="text-text-main font-semibold">{fmtNum(entry.contextWindow)}</span>
                      </span>
                      <span className="text-[11px] text-text-muted">
                        max <span className="text-text-main font-semibold">{fmtNum(entry.maxOutput)}</span>
                      </span>
                      {bools.map(({ key, label }) => (
                        <span key={key} className="inline-flex items-center gap-1">
                          <span className="text-[11px] text-text-muted">{label}</span>
                          <CapBadge on={entry[key]} />
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => openEdit(index)}
                      className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-surface-2 transition-colors cursor-pointer"
                      title="Edit"
                    >
                      <span className="material-symbols-outlined text-[16px]">edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteIndex(index)}
                      className="p-1.5 rounded-md text-text-muted hover:text-red-500 hover:bg-surface-2 transition-colors cursor-pointer"
                      title="Delete"
                    >
                      <span className="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* 3. save bar */}
      {dirty && (
        <Card padding="sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-text-muted">
              Unsaved changes ({countChanged(entries, draft)} entr
              {countChanged(entries, draft) === 1 ? "y" : "ies"} affected)
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDraft(entries)} disabled={saving}>
                Discard
              </Button>
              <Button size="sm" onClick={requestSave} loading={saving}>
                Save
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* add / edit modal */}
      <Modal
        isOpen={showForm}
        onClose={() => setShowForm(false)}
        title={editingIndex === null ? "Add override" : "Edit override"}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button onClick={submitForm}>
              {editingIndex === null ? "Add" : "Apply"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-text-main mb-1">
              Model <span className="text-red-500">*</span>
            </label>
            <Input
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="e.g. glm-5-3-flash"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-main mb-1">
              Provider <span className="text-text-muted">(optional — leave blank for all)</span>
            </label>
            <Input
              value={form.provider}
              onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
              placeholder="e.g. zai"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-main mb-1">Context window</label>
              <Input
                type="number"
                value={form.contextWindow}
                onChange={(e) => setForm((f) => ({ ...f, contextWindow: e.target.value }))}
                placeholder="1000000"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-main mb-1">Max output</label>
              <Input
                type="number"
                value={form.maxOutput}
                onChange={(e) => setForm((f) => ({ ...f, maxOutput: e.target.value }))}
                placeholder="131072"
              />
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-text-main mb-2">
              Capabilities <span className="text-text-muted">(leave untouched to inherit)</span>
            </p>
            <div className="space-y-1.5">
              {BOOL_KEYS.map(({ key, label, hint }) => {
                const value = form.bools[key];
                return (
                  <div key={key} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="text-xs text-text-main">{label}</span>
                      <span className="text-[11px] text-text-muted ml-2">{hint}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {value !== undefined && (
                        <button
                          type="button"
                          onClick={() =>
                            setForm((f) => {
                              const next = { ...f.bools };
                              delete next[key];
                              return { ...f, bools: next };
                            })
                          }
                          className="text-[10px] text-text-muted hover:text-primary cursor-pointer"
                          title="Inherit from table"
                        >
                          clear
                        </button>
                      )}
                      <Toggle
                        checked={value === true}
                        onChange={(next) =>
                          setForm((f) => ({ ...f, bools: { ...f.bools, [key]: next } }))
                        }
                        size="sm"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {formError && (
            <p className="text-xs text-red-500">{formError}</p>
          )}
        </div>
      </Modal>

      {/* delete confirm */}
      <ConfirmModal
        isOpen={deleteIndex !== null}
        onClose={() => setDeleteIndex(null)}
        onConfirm={confirmDelete}
        title="Delete override"
        message={
          deleteIndex !== null && draft[deleteIndex]
            ? `Remove the override for "${draft[deleteIndex].model}"? The change is applied when you save.`
            : ""
        }
        confirmText="Delete"
      />

      {/* bulk save confirm */}
      <ConfirmModal
        isOpen={showSaveConfirm}
        onClose={() => setShowSaveConfirm(false)}
        onConfirm={() => {
          setShowSaveConfirm(false);
          doSave();
        }}
        title="Save changes"
        message={`This will rewrite the whole file and affect ${countChanged(entries, draft)} entries. Continue?`}
        confirmText="Save"
        variant="primary"
        loading={saving}
      />

      {/* destructive overwrite confirm */}
      <ConfirmModal
        isOpen={showOverwriteConfirm}
        onClose={() => setShowOverwriteConfirm(false)}
        onConfirm={doOverwriteEmpty}
        title="Overwrite with an empty list"
        message="This replaces the file with an empty overrides list. Any hand-written YAML will be lost. Continue?"
        confirmText="Overwrite"
        loading={saving}
      />
    </div>
  );
}

// Count entries that differ between the saved list and the draft.
function countChanged(saved, draft) {
  const n = Math.max(saved.length, draft.length);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(saved[i]) !== JSON.stringify(draft[i])) changed += 1;
  }
  return changed;
}
