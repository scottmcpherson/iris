import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
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
import { endpointLabel, formatBytes } from "../../shared/format";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardContent, CardHeader } from "../../shared/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../shared/ui/empty";
import { Input } from "../../shared/ui/input";
import { ScrollArea } from "../../shared/ui/scroll-area";
import { Switch } from "../../shared/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/tabs";
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
    <div className="memory-workspace">
      <section className="memory-dashboard" aria-label="Memory growth dashboard">
        <MetricTile label="Total" value={formatBytes(stats.totalBytes)} detail={`${stats.totalLines} lines`} />
        <MetricTile label="MEMORY.md" value={formatBytes(memoryFile.bytes)} detail={formatDate(memoryFile.updatedAt)} />
        <MetricTile label="USER.md" value={formatBytes(userFile.bytes)} detail={formatDate(userFile.updatedAt)} />
        <MetricTile label="Revisions" value={`${memory?.history.length ?? 0}`} detail={stats.growthLabel} />
      </section>

      <section className="memory-provider-board" aria-label="Memory provider status">
        <Card className="provider-card">
          <div className="provider-card-title">
            <ShieldCheck size={17} />
            <span>Management API</span>
          </div>
          <Badge variant={memory?.ok ? "secondary" : "outline"}>{memory?.ok ? "Ready" : "Offline"}</Badge>
          <small className="provider-card-detail">{endpointLabel(status?.managementStatus)}</small>
        </Card>
        <Card className="provider-card">
          <div className="provider-card-title">
            <Server size={17} />
            <span>Session API</span>
          </div>
          <Badge variant={status?.activeApiStatus?.ok ? "secondary" : "outline"}>{status?.activeApiStatus?.ok ? "Online" : "Offline"}</Badge>
          <small className="provider-card-detail">{endpointLabel(status?.activeApiStatus)}</small>
        </Card>
        <div className="memory-toggle">
          <Switch
            id="memory-provider-builtin"
            checked={providers.builtin}
            onCheckedChange={(checked) => setProviders((current) => ({ ...current, builtin: checked }))}
          />
          <label htmlFor="memory-provider-builtin">Agent memory</label>
        </div>
        <div className="memory-toggle">
          <Switch
            id="memory-provider-external"
            checked={providers.external}
            onCheckedChange={(checked) => setProviders((current) => ({ ...current, external: checked }))}
          />
          <label htmlFor="memory-provider-external">External providers</label>
        </div>
        <div className="memory-toggle">
          <Switch
            id="memory-provider-workspace"
            checked={providers.workspace}
            onCheckedChange={(checked) => setProviders((current) => ({ ...current, workspace: checked }))}
          />
          <label htmlFor="memory-provider-workspace">Workspace context</label>
        </div>
      </section>

      <section className="memory-editor-shell">
        <div className="memory-toolbar">
          <Tabs
            value={activeFile}
            onValueChange={(value) => setActiveFile(value as MemoryFileKey)}
            className="min-w-0"
          >
            <TabsList aria-label="Memory files" className="h-auto gap-[5px] bg-transparent p-0">
              {(["memory", "user"] as MemoryFileKey[]).map((file) => (
                <TabsTrigger
                  className="grid h-[44px] min-w-[132px] gap-0.5 rounded-lg px-[11px] py-0 text-left"
                  key={file}
                  value={file}
                >
                  <span className="self-end truncate">{fileLabels[file]}</span>
                  <small className="self-start truncate text-[11px] font-[700] text-menu-muted-foreground">
                    {formatBytes(files[file].bytes)}
                  </small>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
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
        <Card className="memory-panel memory-search-panel">
          <CardHeader>
            <p className="memory-panel-title">
              <Search size={15} />
              Search
            </p>
            <Badge variant="secondary">{searchResults.length} matches</Badge>
          </CardHeader>
          <CardContent className="memory-panel-content">
          <div className="memory-search">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory" />
          </div>
          <ScrollArea className="memory-result-list">
            {searchResults.length ? (
              searchResults.map((result) => (
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
              ))
            ) : (
              <MemoryEmptyState>No search results</MemoryEmptyState>
            )}
          </ScrollArea>
          </CardContent>
        </Card>

        <Card className="memory-panel">
          <CardHeader>
            <p className="memory-panel-title">
              <History size={15} />
              Timeline
            </p>
            <Badge variant="secondary">{activeHistory.length} revisions</Badge>
          </CardHeader>
          <CardContent className="memory-panel-content">
          <ScrollArea className="memory-timeline">
            {activeHistory.length ? (
              activeHistory.map((entry) => (
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
              ))
            ) : (
              <MemoryEmptyState>No saved revisions yet.</MemoryEmptyState>
            )}
          </ScrollArea>
          </CardContent>
        </Card>

        <Card className="memory-panel memory-diff-panel">
          <CardHeader>
            <p className="memory-panel-title">
              <FileDiff size={15} />
              Diff
            </p>
            <Badge variant="secondary">{selectedHistory ? "Revision to current" : "Draft to saved"}</Badge>
          </CardHeader>
          <CardContent className="memory-panel-content">
          <div className="diff-summary">
            <span>+{selectedHistory ? historyDiff.added : draftDiff.added}</span>
            <span>-{selectedHistory ? historyDiff.removed : draftDiff.removed}</span>
          </div>
          <ScrollArea className="memory-diff-scroll">
            <pre className="memory-diff-output">{formatDiff(selectedHistory ? historyDiff.lines : draftDiff.lines)}</pre>
          </ScrollArea>
          </CardContent>
        </Card>
      </section>

      <Button className="memory-reset-all" variant="appDanger" size="appSmall" type="button" onClick={() => beginReset("all")}>
        Reset all memory
      </Button>

      {resetTarget ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) cancelReset();
          }}
        >
          <DialogContent
            className="border-menu-danger/25 bg-menu text-menu-foreground shadow-context-menu sm:max-w-[420px]"
            showCloseButton={false}
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg text-menu-hover-foreground">
                <AlertTriangle size={18} />
                Reset {resetTarget === "all" ? "all memory" : fileLabels[resetTarget]}
              </DialogTitle>
              <DialogDescription className="text-sm leading-[1.45] text-menu-muted-foreground">
                This removes the selected memory file from the active agent after saving a revision snapshot.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              className="h-[38px] border-menu-border bg-secondary text-menu-hover-foreground placeholder:text-menu-muted-foreground"
              value={resetText}
              onChange={(event) => setResetText(event.target.value)}
              placeholder="RESET MEMORY"
            />
            <DialogFooter className="gap-2">
              <Button variant="appGhost" size="appSmall" type="button" onClick={cancelReset}>
                Cancel
              </Button>
              <Button variant="appDanger" size="appSmall" type="button" disabled={resetText !== "RESET MEMORY"} onClick={confirmReset}>
                Confirm reset
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
    <Card className="metric-tile">
      <BarChart3 size={15} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </Card>
  );
}

function MemoryEmptyState({ children }: { children: string }) {
  return (
    <Empty className="memory-empty">
      <EmptyHeader>
        <EmptyTitle>{children}</EmptyTitle>
        <EmptyDescription>Memory activity appears here after edits, searches, or saved revisions.</EmptyDescription>
      </EmptyHeader>
    </Empty>
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
