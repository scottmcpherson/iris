import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileDiff,
  FileText,
  History,
  Info,
  Plug,
  RotateCcw,
  Save,
  Undo2,
  User as UserIcon,
} from "lucide-react";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../shared/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../shared/ui/collapsible";
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
import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/tabs";
import type {
  HermesMemory,
  HermesMemoryFile,
  HermesMemoryResetExpectations,
  HermesStatus,
} from "../../types/hermes";

type MemoryFileKey = "memory" | "user";
type ResetTarget = MemoryFileKey | "all";
type CapacityTone = "ready" | "warning" | "over";

const fileLabels: Record<MemoryFileKey, string> = {
  memory: "MEMORY.md",
  user: "USER.md",
};

const fileLimits: Record<MemoryFileKey, number> = {
  memory: 2200,
  user: 1375,
};

const fileDescriptions: Record<MemoryFileKey, string> = {
  memory: "Environment facts, project conventions, completed tasks",
  user: "Identity, preferences, communication style",
};

const fileIcons: Record<MemoryFileKey, typeof FileText> = {
  memory: FileText,
  user: UserIcon,
};

type MemoryViewProps = {
  memory: HermesMemory | null;
  profile: string;
  status: HermesStatus | null;
  onSaveMemory: (
    file: MemoryFileKey,
    content: string,
    expectedUpdatedAt?: number | null,
    expectedContentHash?: string | null,
  ) => Promise<string>;
  onResetMemory: (
    file: ResetTarget,
    confirm: string,
    expectations?: HermesMemoryResetExpectations,
  ) => Promise<string>;
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
  const [statusMessage, setStatusMessage] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);
  const [resetText, setResetText] = useState("");

  const files = useMemo(
    () => ({ memory: memoryFile, user: userFile }),
    [memoryFile, userFile],
  );
  const active = files[activeFile];
  const draft = drafts[activeFile] ?? "";
  const dirty = draft !== active.content;
  const activeLimit = fileLimits[activeFile];
  const draftChars = draft.length;
  const activeCapacity = capacityFor(draftChars, activeLimit);
  const activeHistory = (memory?.history ?? []).filter(
    (entry) => entry.file === fileLabels[activeFile],
  );
  const selectedHistory =
    memory?.history.find((entry) => entry.id === selectedHistoryId) ??
    activeHistory[0] ??
    null;
  const historyDiff = useMemo(
    () => diffLines(selectedHistory?.content ?? "", active.content),
    [active.content, selectedHistory],
  );
  const syncCaption = memory?.ok
    ? `Synced from Hermes${profile ? ` · profile ${profile}` : ""}`
    : status?.connected
      ? "Memory unavailable — management API offline"
      : "Memory unavailable — Iris Core offline";

  useEffect(() => {
    setDrafts({
      memory: memoryFile.content,
      user: userFile.content,
    });
    setSelectedHistoryId("");
    setStatusMessage("");
  }, [profile, memoryFile.content, userFile.content]);

  return (
    <div className="memory-workspace">
      <div className="memory-capacity-grid">
        {(["memory", "user"] as MemoryFileKey[]).map((file) => {
          const fileData = files[file];
          const chars = fileData.content.length;
          const limit = fileLimits[file];
          const capacity = capacityFor(chars, limit);
          const Icon = fileIcons[file];
          return (
            <Card
              key={file}
              className={`agent-overview-card memory-capacity-card memory-capacity-card-${capacity.tone}`}
            >
              <CardHeader>
                <CardTitle>
                  <Icon className="agent-overview-card-icon" />
                  <span>{fileLabels[file]}</span>
                </CardTitle>
                <CardDescription>{fileDescriptions[file]}</CardDescription>
                <div className="agent-overview-card-header-actions">
                  <Button
                    variant="appIcon"
                    size="icon-sm"
                    onClick={() => beginReset(file)}
                    title={`Reset ${fileLabels[file]}`}
                    aria-label={`Reset ${fileLabels[file]}`}
                  >
                    <RotateCcw />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="agent-overview-card-body">
                <CapacityBar chars={chars} limit={limit} capacity={capacity} />
                <div className="memory-capacity-meta">
                  <span>{countLines(fileData.content)} lines</span>
                  <span>Updated {formatDate(fileData.updatedAt)}</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="agent-overview-card memory-editor-card">
        <CardHeader>
          <CardTitle>
            <FileText className="agent-overview-card-icon" />
            <span>Edit memory</span>
          </CardTitle>
          <CardDescription>{syncCaption}</CardDescription>
          <div className="agent-overview-card-header-actions">
            <Button
              variant="appIcon"
              size="icon-sm"
              type="button"
              title="Undo draft"
              aria-label="Undo draft"
              disabled={!dirty}
              onClick={undoDraft}
            >
              <Undo2 />
            </Button>
            <Button
              variant="appIcon"
              size="icon-sm"
              type="button"
              title="Save memory"
              aria-label="Save memory"
              disabled={!dirty}
              onClick={saveDraft}
            >
              <Save />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="agent-overview-card-body memory-editor-body">
          <div className="memory-editor-toolbar">
            <Tabs
              value={activeFile}
              onValueChange={(value) => setActiveFile(value as MemoryFileKey)}
              className="min-w-0"
            >
              <TabsList aria-label="Memory files" className="h-auto gap-1 bg-transparent p-0">
                {(["memory", "user"] as MemoryFileKey[]).map((file) => (
                  <TabsTrigger
                    key={file}
                    value={file}
                    className="h-[30px] rounded-md px-3 text-[12px]"
                  >
                    {fileLabels[file]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <span className={`memory-char-counter tone-${activeCapacity.tone}`}>
              {draftChars.toLocaleString()} / {activeLimit.toLocaleString()} chars
            </span>
          </div>
          <textarea
            className="memory-editor"
            spellCheck={false}
            value={draft}
            onChange={(event) =>
              setDrafts((current) => ({ ...current, [activeFile]: event.target.value }))
            }
          />
          <div className={`memory-save-state ${dirty ? "dirty" : ""}`}>
            {dirty ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
            <span>
              {dirty
                ? activeCapacity.tone === "over"
                  ? `${draftChars - activeLimit} chars over limit — agent may reject save`
                  : "Unsaved changes"
                : "Saved"}
            </span>
            {statusMessage ? <strong>{statusMessage}</strong> : null}
          </div>
        </CardContent>
      </Card>

      <Card className="agent-overview-card memory-history-card">
        <Collapsible defaultOpen={Boolean(activeHistory.length)}>
          <CardHeader className="memory-history-header">
            <CollapsibleTrigger asChild>
              <button type="button" className="memory-history-trigger">
                <History className="agent-overview-card-icon" />
                <span className="memory-history-title">Revision history</span>
                <Badge variant="secondary" className="memory-history-count">
                  {activeHistory.length}
                </Badge>
                <CardDescription className="memory-history-description">
                  {fileLabels[activeFile]} · saved snapshots
                </CardDescription>
              </button>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent forceMount>
            <CardContent className="agent-overview-card-body memory-history-body">
              {activeHistory.length ? (
                <div className="memory-history-split">
                  <ScrollArea className="memory-revision-list">
                    <div className="memory-revision-list-inner">
                      {activeHistory.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          className={`memory-revision ${selectedHistory?.id === entry.id ? "active" : ""}`}
                          onClick={() => setSelectedHistoryId(entry.id)}
                        >
                          <span className="memory-revision-action">{entry.action}</span>
                          <strong>{entry.summary || "Revision"}</strong>
                          <small>
                            {formatDate(entry.updatedAt)} · {entry.bytes.toLocaleString()} B
                          </small>
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                  <div className="memory-history-diff">
                    <div className="memory-history-diff-header">
                      <FileDiff size={14} />
                      <span>Revision → current</span>
                      <span className="memory-diff-pill memory-diff-pill-added">
                        +{historyDiff.added}
                      </span>
                      <span className="memory-diff-pill memory-diff-pill-removed">
                        -{historyDiff.removed}
                      </span>
                    </div>
                    <ScrollArea className="memory-diff-scroll">
                      <pre className="memory-diff-output">{formatDiff(historyDiff.lines)}</pre>
                    </ScrollArea>
                  </div>
                </div>
              ) : (
                <Empty className="memory-history-empty">
                  <EmptyHeader>
                    <EmptyTitle>No revisions yet</EmptyTitle>
                    <EmptyDescription>
                      Snapshots appear here after Iris saves or resets {fileLabels[activeFile]}.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      <div className="memory-providers-note">
        <Plug size={13} />
        <span>
          External memory providers (Honcho, Mem0, and others) are configured on the Hermes host.
        </span>
        <Info size={13} className="memory-providers-info" />
      </div>

      <div className="memory-footer-actions">
        <Button
          variant="appDanger"
          size="appSmall"
          type="button"
          onClick={() => beginReset("all")}
        >
          Reset all memory
        </Button>
      </div>

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
                {resetTarget === "all"
                  ? "This removes both memory files from the active agent after saving revision snapshots."
                  : "This removes the selected memory file from the active agent after saving a revision snapshot."}
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
              <Button
                variant="appDanger"
                size="appSmall"
                type="button"
                disabled={resetText !== "RESET MEMORY"}
                onClick={confirmReset}
              >
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
    const message = await onSaveMemory(activeFile, draft, active.updatedAt, active.contentHash ?? null);
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
    const message = await onResetMemory(resetTarget, resetText, resetExpectations(resetTarget, files));
    setStatusMessage(message);
    cancelReset();
  }
}

function CapacityBar({
  chars,
  limit,
  capacity,
}: {
  chars: number;
  limit: number;
  capacity: ReturnType<typeof capacityFor>;
}) {
  return (
    <div className="memory-capacity-bar-wrap">
      <div className="memory-capacity-bar-track" role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(chars, limit)}>
        <div
          className={`memory-capacity-bar-fill tone-${capacity.tone}`}
          style={{ width: `${Math.min(100, capacity.percent)}%` }}
        />
      </div>
      <div className="memory-capacity-bar-meta">
        <strong>
          {chars.toLocaleString()} / {limit.toLocaleString()}
        </strong>
        <span>{capacity.label}</span>
      </div>
    </div>
  );
}

function capacityFor(chars: number, limit: number): { percent: number; tone: CapacityTone; label: string } {
  const percent = limit > 0 ? (chars / limit) * 100 : 0;
  let tone: CapacityTone = "ready";
  if (percent >= 100) tone = "over";
  else if (percent >= 70) tone = "warning";
  const label = chars > limit ? `${Math.round(percent)}% — over limit` : `${Math.round(percent)}% used`;
  return { percent, tone, label };
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
      contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    }
  );
}

function resetExpectations(
  target: ResetTarget,
  files: Record<MemoryFileKey, HermesMemoryFile>,
): HermesMemoryResetExpectations {
  const targets: MemoryFileKey[] = target === "all" ? ["memory", "user"] : [target];
  const expectedContentHashByFile = Object.fromEntries(
    targets
      .filter((file) => files[file].contentHash !== undefined)
      .map((file) => [file, files[file].contentHash ?? null]),
  );
  return {
    expectedUpdatedAtByFile: Object.fromEntries(
      targets.map((file) => [file, files[file].updatedAt]),
    ),
    ...(Object.keys(expectedContentHashByFile).length ? { expectedContentHashByFile } : {}),
  };
}

function formatDate(timestamp: number | null) {
  if (!timestamp) return "never";
  return new Date(timestamp * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  return { added, removed, lines: lines.slice(0, 120) };
}

function formatDiff(lines: ReturnType<typeof diffLines>["lines"]) {
  if (!lines.length) return "No differences.";
  return lines
    .map((line) => `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "} ${line.text}`)
    .join("\n");
}
