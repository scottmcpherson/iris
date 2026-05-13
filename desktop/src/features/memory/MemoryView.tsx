import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Database,
  FileDiff,
  History,
  RotateCcw,
  Save,
  Search,
  Server,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { loadJsonValue, saveJsonValue, storageKeys } from "../../app/storage";
import { ViewHeader } from "../../shared/ViewHeader";
import { endpointLabel, formatBytes } from "../../shared/format";
import { Button } from "../../shared/ui/button";
import type { HermesMemory, HermesMemoryFile, HermesMemoryHistoryEntry, HermesStatus } from "../../types/hermes";

type MemoryFileKey = "memory" | "user";
type ResetTarget = MemoryFileKey | "all";

type MemoryProviderControls = {
  builtin: boolean;
  external: boolean;
  workspace: boolean;
};

type MemoryViewProps = {
  memory: HermesMemory | null;
  profile: string;
  status: HermesStatus | null;
  onSaveMemory: (
    file: MemoryFileKey,
    content: string,
    expectedUpdatedAt?: number | null,
  ) => Promise<string>;
  onResetMemory: (file: ResetTarget, confirm: string) => Promise<string>;
};

const fileLabels: Record<MemoryFileKey, string> = {
  memory: "MEMORY.md",
  user: "USER.md",
};

export function MemoryView({
  memory,
  profile,
  status,
  onResetMemory,
  onSaveMemory,
}: MemoryViewProps) {
  const memoryFile = emptyMemoryFile("MEMORY.md", memory?.memory);
  const userFile = emptyMemoryFile("USER.md", memory?.user);
  const [activeFile, setActiveFile] = useState<MemoryFileKey>("memory");
  const [drafts, setDrafts] = useState(() => ({
    memory: memoryFile.content,
    user: userFile.content,
  }));
  const [query, setQuery] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);
  const [resetText, setResetText] = useState("");
  const [providers, setProviders] = useState<MemoryProviderControls>(() => loadProviderControls());

  const files = useMemo(
    () => ({
      memory: memoryFile,
      user: userFile,
    }),
    [memoryFile, userFile],
  );
  const active = files[activeFile];
  const draft = drafts[activeFile] ?? "";
  const dirty = draft !== active.content;
  const activeHistory = (memory?.history ?? []).filter((entry) => entry.file === fileLabels[activeFile]);
  const selectedHistory =
    memory?.history.find((entry) => entry.id === selectedHistoryId) ?? activeHistory[0] ?? null;
  const draftDiff = useMemo(() => diffLines(active.content, draft), [active.content, draft]);
  const historyDiff = useMemo(
    () => diffLines(selectedHistory?.content ?? "", active.content),
    [active.content, selectedHistory],
  );
  const searchResults = useMemo(
    () => searchMemory(query, files, memory?.history ?? []),
    [files, memory?.history, query],
  );
  const stats = useMemo(() => memoryStats(files, memory?.history ?? []), [files, memory?.history]);

  useEffect(() => {
    setDrafts({
      memory: memoryFile.content,
      user: userFile.content,
    });
    setSelectedHistoryId("");
  }, [profile, memoryFile.content, userFile.content]);

  useEffect(() => {
    saveJsonValue(storageKeys.memoryProviders, providers);
  }, [providers]);

  return (
    <div className="tool-view memory-workspace">
      <ViewHeader
        icon={<Database size={19} />}
        eyebrow={`Profile: ${profile}`}
        title="Memory management"
        action={memory?.path || "Open folder"}
      />

      <section className="memory-dashboard" aria-label="Memory growth dashboard">
        <MetricTile label="Total" value={formatBytes(stats.totalBytes)} detail={`${stats.totalLines} lines`} />
        <MetricTile label="MEMORY.md" value={formatBytes(memoryFile.bytes)} detail={formatDate(memoryFile.updatedAt)} />
        <MetricTile label="USER.md" value={formatBytes(userFile.bytes)} detail={formatDate(userFile.updatedAt)} />
        <MetricTile label="Revisions" value={`${memory?.history.length ?? 0}`} detail={stats.growthLabel} />
      </section>

      <section className="memory-provider-board" aria-label="Memory provider status">
        <div className="provider-card">
          <div>
            <ShieldCheck size={17} />
            <span>Management API</span>
          </div>
          <strong>{memory?.ok ? "Ready" : "Offline"}</strong>
          <small>{endpointLabel(status?.managementStatus)}</small>
        </div>
        <div className="provider-card">
          <div>
            <Server size={17} />
            <span>Session API</span>
          </div>
          <strong>{status?.activeApiStatus?.ok ? "Online" : "Offline"}</strong>
          <small>{endpointLabel(status?.activeApiStatus)}</small>
        </div>
        <label className="memory-toggle">
          <input
            type="checkbox"
            checked={providers.builtin}
            onChange={(event) => setProviders((current) => ({ ...current, builtin: event.target.checked }))}
          />
          <span>Agent memory</span>
        </label>
        <label className="memory-toggle">
          <input
            type="checkbox"
            checked={providers.external}
            onChange={(event) => setProviders((current) => ({ ...current, external: event.target.checked }))}
          />
          <span>External providers</span>
        </label>
        <label className="memory-toggle">
          <input
            type="checkbox"
            checked={providers.workspace}
            onChange={(event) => setProviders((current) => ({ ...current, workspace: event.target.checked }))}
          />
          <span>Workspace context</span>
        </label>
      </section>

      <section className="memory-editor-shell">
        <div className="memory-toolbar">
          <div className="memory-tabs" role="tablist" aria-label="Memory files">
            {(["memory", "user"] as MemoryFileKey[]).map((file) => (
              <Button
                className={`memory-tab ${activeFile === file ? "active" : ""}`}
                key={file}
                type="button"
                variant="ghost"
                onClick={() => setActiveFile(file)}
              >
                <span>{fileLabels[file]}</span>
                <small>{formatBytes(files[file].bytes)}</small>
              </Button>
            ))}
          </div>
          <div className="memory-actions">
            <Button variant="appIcon" size="icon-md" type="button" title="Undo draft" disabled={!dirty} onClick={undoDraft}>
              <Undo2 size={15} />
            </Button>
            <Button variant="appIcon" size="icon-md" type="button" title="Save memory" disabled={!dirty} onClick={saveDraft}>
              <Save size={15} />
            </Button>
            <Button variant="appIconDanger" size="icon-md" type="button" title="Reset file" onClick={() => beginReset(activeFile)}>
              <RotateCcw size={15} />
            </Button>
          </div>
        </div>

        <textarea
          className="memory-editor"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDrafts((current) => ({ ...current, [activeFile]: event.target.value }))}
        />

        <div className={`memory-save-state ${dirty ? "dirty" : ""}`}>
          {dirty ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span>{dirty ? `${draftDiff.added} added, ${draftDiff.removed} removed` : "Saved"}</span>
          {statusMessage ? <strong>{statusMessage}</strong> : null}
        </div>
      </section>

      <section className="memory-lower-grid">
        <div className="memory-panel memory-search-panel">
          <header>
            <p>
              <Search size={15} />
              Search
            </p>
            <span>{searchResults.length} matches</span>
          </header>
          <div className="memory-search">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory" />
          </div>
          <div className="memory-result-list">
            {searchResults.map((result) => (
              <Button
                key={result.id}
                type="button"
                variant="ghost"
                onClick={() => {
                  setActiveFile(result.file);
                  setSelectedHistoryId(result.historyId || "");
                }}
              >
                <span>{fileLabels[result.file]}</span>
                <strong>{result.title}</strong>
                <small>{result.snippet}</small>
              </Button>
            ))}
          </div>
        </div>

        <div className="memory-panel">
          <header>
            <p>
              <History size={15} />
              Timeline
            </p>
            <span>{activeHistory.length} revisions</span>
          </header>
          <div className="memory-timeline">
            {activeHistory.map((entry) => (
              <Button
                className={selectedHistory?.id === entry.id ? "active" : ""}
                key={entry.id}
                type="button"
                variant="ghost"
                onClick={() => setSelectedHistoryId(entry.id)}
              >
                <span>{entry.action}</span>
                <strong>{entry.summary}</strong>
                <small>{formatDate(entry.updatedAt)} · {formatBytes(entry.bytes)}</small>
              </Button>
            ))}
            {!activeHistory.length ? <p className="memory-empty">No saved revisions yet.</p> : null}
          </div>
        </div>

        <div className="memory-panel memory-diff-panel">
          <header>
            <p>
              <FileDiff size={15} />
              Diff
            </p>
            <span>{selectedHistory ? "Revision to current" : "Draft to saved"}</span>
          </header>
          <div className="diff-summary">
            <span>+{selectedHistory ? historyDiff.added : draftDiff.added}</span>
            <span>-{selectedHistory ? historyDiff.removed : draftDiff.removed}</span>
          </div>
          <pre>{formatDiff(selectedHistory ? historyDiff.lines : draftDiff.lines)}</pre>
        </div>
      </section>

      <Button className="memory-reset-all" variant="appDanger" size="appSmall" type="button" onClick={() => beginReset("all")}>
        Reset all memory
      </Button>

      {resetTarget ? (
        <div className="memory-reset-modal" role="dialog" aria-modal="true">
          <div>
            <AlertTriangle size={18} />
            <strong>Reset {resetTarget === "all" ? "all memory" : fileLabels[resetTarget]}</strong>
          </div>
          <p>This removes the selected memory file from the active agent after saving a revision snapshot.</p>
          <input
            autoFocus
            value={resetText}
            onChange={(event) => setResetText(event.target.value)}
            placeholder="RESET MEMORY"
          />
          <div>
            <Button variant="appGhost" size="appSmall" type="button" onClick={cancelReset}>
              Cancel
            </Button>
            <Button variant="appDanger" size="appSmall" type="button" disabled={resetText !== "RESET MEMORY"} onClick={confirmReset}>
              Confirm reset
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );

  async function saveDraft() {
    setStatusMessage("");
    const message = await onSaveMemory(activeFile, draft, active.updatedAt);
    setStatusMessage(message);
  }

  function undoDraft() {
    setDrafts((current) => ({ ...current, [activeFile]: active.content }));
    setStatusMessage("Draft reverted.");
  }

  function beginReset(target: ResetTarget) {
    setResetTarget(target);
    setResetText("");
  }

  function cancelReset() {
    setResetTarget(null);
    setResetText("");
  }

  async function confirmReset() {
    if (!resetTarget) return;
    const message = await onResetMemory(resetTarget, resetText);
    setStatusMessage(message);
    cancelReset();
  }
}

function MetricTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metric-tile">
      <BarChart3 size={15} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function emptyMemoryFile(name: string, file?: HermesMemoryFile): HermesMemoryFile {
  return (
    file ?? {
      name,
      path: "",
      exists: false,
      updatedAt: null,
      bytes: 0,
      content: "",
    }
  );
}

function loadProviderControls(): MemoryProviderControls {
  const parsed = loadJsonValue<Partial<MemoryProviderControls>>(storageKeys.memoryProviders, {});
  return {
    builtin: parsed.builtin ?? true,
    external: parsed.external ?? false,
    workspace: parsed.workspace ?? true,
  };
}

function formatDate(timestamp: number | null) {
  if (!timestamp) return "Never";
  return new Date(timestamp * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function memoryStats(files: Record<MemoryFileKey, HermesMemoryFile>, history: HermesMemoryHistoryEntry[]) {
  const totalBytes = files.memory.bytes + files.user.bytes;
  const totalLines = countLines(files.memory.content) + countLines(files.user.content);
  const latestHistory = history[0];
  const delta = latestHistory ? totalBytes - latestHistory.bytes : 0;
  const growthLabel = latestHistory ? `${delta >= 0 ? "+" : ""}${formatBytes(Math.abs(delta))} since last revision` : "No baseline";
  return { totalBytes, totalLines, growthLabel };
}

function countLines(text: string) {
  return text ? text.split(/\r?\n/).length : 0;
}

function diffLines(before: string, after: string) {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const lines: Array<{ type: "same" | "added" | "removed"; text: string }> = [];
  let added = 0;
  let removed = 0;
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index];
    const right = afterLines[index];
    if (left === right) {
      if (left !== undefined && left !== "") lines.push({ type: "same", text: left });
    } else {
      if (left !== undefined) {
        removed += 1;
        lines.push({ type: "removed", text: left });
      }
      if (right !== undefined) {
        added += 1;
        lines.push({ type: "added", text: right });
      }
    }
  }
  return { added, removed, lines: lines.slice(0, 80) };
}

function formatDiff(lines: ReturnType<typeof diffLines>["lines"]) {
  if (!lines.length) return "No differences.";
  return lines
    .map((line) => `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "} ${line.text}`)
    .join("\n");
}

function searchMemory(
  query: string,
  files: Record<MemoryFileKey, HermesMemoryFile>,
  history: HermesMemoryHistoryEntry[],
) {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  const results: Array<{
    id: string;
    file: MemoryFileKey;
    historyId?: string;
    title: string;
    snippet: string;
  }> = [];

  (Object.keys(files) as MemoryFileKey[]).forEach((file) => {
    const snippet = matchSnippet(files[file].content, term);
    if (snippet) {
      results.push({ id: `current-${file}`, file, title: "Current file", snippet });
    }
  });

  history.forEach((entry) => {
    const snippet = matchSnippet(entry.content, term);
    if (snippet) {
      results.push({
        id: entry.id,
        file: entry.file === "USER.md" ? "user" : "memory",
        historyId: entry.id,
        title: entry.summary,
        snippet,
      });
    }
  });
  return results.slice(0, 12);
}

function matchSnippet(text: string, term: string) {
  const line = text.split(/\r?\n/).find((item) => item.toLowerCase().includes(term));
  return line?.trim().slice(0, 180) ?? "";
}
