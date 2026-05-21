import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileCode2,
  Plus,
  Save,
  Search,
  Store,
  Trash2,
  X,
} from "lucide-react";
import {
  useDeleteSkillMutation,
  useInstallSkillMutation,
  useSaveSkillMutation,
  useSkillCatalogQuery,
  useSkillDetailQuery,
  useSkillsQuery,
} from "../../lib/query";
import { CodeEditor } from "../../shared/CodeEditor";
import { Alert, AlertDescription } from "../../shared/ui/alert";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../shared/ui/empty";
import { Field, FieldLabel } from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu";
import type {
  HermesRuntimeConfig,
  HermesSkill,
  HermesSkillCatalogItem,
  HermesSkillDetail,
} from "../../types/hermes";

type SkillRow = {
  key: string;
  kind: "installed" | "available";
  skill: HermesSkill | HermesSkillCatalogItem;
  groupKey: string;
  groupLabel: string;
  sortBucket: number;
  sourceLabel: string;
  searchText: string;
  sourceProfile?: string;
  sourceSkillId?: string;
  conflict?: boolean;
};

const NEW_SKILL_ACTION = "action://new-skill";

export function SkillsView({
  profile,
  runtimeConfig,
  connected,
  onProfileSkillsChanged,
}: {
  profile: string;
  runtimeConfig: HermesRuntimeConfig;
  connected: boolean;
  onProfileSkillsChanged: (profileName: string) => void;
}) {
  const skillsQuery = useSkillsQuery(runtimeConfig, profile, connected);
  const catalogQuery = useSkillCatalogQuery(runtimeConfig, profile, connected);
  const installedSkills = skillsQuery.data?.skills ?? [];
  const availableSkills = catalogQuery.data?.available ?? [];
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [selectedKey, setSelectedKey] = useState("");
  const [pendingSelection, setPendingSelection] = useState("");
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [installTarget, setInstallTarget] = useState<SkillRow | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SkillRow | null>(null);
  const [detail, setDetail] = useState<HermesSkillDetail | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftCategory, setDraftCategory] = useState("personal");
  const [draftContent, setDraftContent] = useState("");
  const [notice, setNotice] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);

  const allRows = useMemo(() => {
    const rows: SkillRow[] = [];
    for (const skill of installedSkills) {
      const sourceLabel = `Installed in ${profile}`;
      rows.push({
        key: installedSkillKey(skill),
        kind: "installed",
        skill,
        groupKey: `installed:${skill.category || "personal"}`,
        groupLabel: skill.category || "personal",
        sortBucket: 0,
        sourceLabel,
        searchText: skillSearchText(skill, sourceLabel, profile),
      });
    }
    for (const skill of availableSkills) {
      const sourceLabel = `Available from ${skill.sourceProfile}`;
      rows.push({
        key: availableSkillKey(skill),
        kind: "available",
        skill,
        groupKey: `available:${skill.sourceProfile}`,
        groupLabel: sourceLabel,
        sortBucket: 1,
        sourceLabel,
        searchText: skillSearchText(skill, sourceLabel, skill.sourceProfile),
        sourceProfile: skill.sourceProfile,
        sourceSkillId: skill.sourceSkillId,
        conflict: Boolean(skill.conflict),
      });
    }
    return rows;
  }, [availableSkills, installedSkills, profile]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allRows.filter((row) => {
      const sourceMatches =
        sourceFilter === "all" ||
        sourceFilter === row.kind ||
        (sourceFilter.startsWith("source:") && row.sourceProfile === sourceFilter.slice("source:".length));
      return sourceMatches && (!needle || row.searchText.includes(needle));
    });
  }, [allRows, query, sourceFilter]);

  const sourceOptions = useMemo(() => {
    const sourceProfiles = Array.from(
      new Set(availableSkills.map((skill) => skill.sourceProfile).filter(Boolean)),
    ).sort((a, b) => a.localeCompare(b));
    return [
      { value: "all", label: "all skills" },
      { value: "installed", label: `installed in ${profile}` },
      { value: "available", label: "available" },
      ...sourceProfiles.map((sourceProfile) => ({
        value: `source:${sourceProfile}`,
        label: `from ${sourceProfile}`,
      })),
    ];
  }, [availableSkills, profile]);

  const groupedRows = useMemo(() => {
    const map = new Map<string, { key: string; label: string; sortBucket: number; rows: SkillRow[] }>();
    for (const row of visibleRows) {
      const group = map.get(row.groupKey) ?? {
        key: row.groupKey,
        label: row.groupLabel,
        sortBucket: row.sortBucket,
        rows: [],
      };
      group.rows.push(row);
      map.set(row.groupKey, group);
    }
    return Array.from(map.values()).sort((a, b) => (
      a.sortBucket - b.sortBucket ||
      a.label.localeCompare(b.label)
    ));
  }, [visibleRows]);

  const selectedRow = allRows.find((row) => row.key === selectedKey) ?? null;
  const isDraftSelection = selectedKey.startsWith("draft://");
  const selectedInstalled = selectedRow?.kind === "installed" ? selectedRow : null;
  const selectedAvailable = selectedRow?.kind === "available" ? selectedRow : null;
  const installedSkillId = selectedInstalled ? selectedInstalled.skill.id || "" : "";
  const availableSkillId = selectedAvailable?.sourceSkillId || "";
  const availableProfile = selectedAvailable?.sourceProfile || "default";
  const installedDetailQuery = useSkillDetailQuery(runtimeConfig, profile, installedSkillId);
  const availableDetailQuery = useSkillDetailQuery(runtimeConfig, availableProfile, availableSkillId);
  const saveSkillMutation = useSaveSkillMutation(runtimeConfig);
  const installSkillMutation = useInstallSkillMutation(runtimeConfig);
  const deleteSkillMutation = useDeleteSkillMutation(runtimeConfig);
  const savedInstalledSelection = Boolean(
    selectedInstalled || (!selectedRow && selectedKey.startsWith("installed:") && detail),
  );
  const selectedDetailLoading =
    Boolean(selectedInstalled && installedDetailQuery.isLoading) ||
    Boolean(selectedAvailable && availableDetailQuery.isLoading);
  const isEditable = Boolean(isDraftSelection || savedInstalledSelection);
  const isAvailablePreview = Boolean(selectedAvailable);
  const isDirty = Boolean(
    isEditable &&
    detail &&
    (
      draftName !== detail.name ||
      draftCategory !== detail.category ||
      draftContent !== detail.content
    ),
  );
  const draftMeta = useMemo(() => extractDraftMetadata(draftContent), [draftContent]);
  const hasFrontmatter = draftContent.trimStart().startsWith("---");
  const editorMetadata = useMemo(
    () => [
      { label: "frontmatter", value: hasFrontmatter ? "frontmatter detected" : "frontmatter missing" },
      { label: "lines", value: `${draftContent.split("\n").length} lines` },
      { label: "description", value: draftMeta.description || "description not set" },
    ],
    [draftContent, draftMeta.description, hasFrontmatter],
  );
  const canSave =
    isEditable &&
    draftName.trim().length > 0 &&
    draftCategory.trim().length > 0 &&
    !selectedDetailLoading &&
    !saveSkillMutation.isPending;
  const isSearching = query.trim().length > 0;
  const listIsLoading = skillsQuery.isLoading || catalogQuery.isLoading;

  useEffect(() => {
    if (!selectedKey && allRows.length > 0) {
      setSelectedKey(allRows[0].key);
    }
    if (!allRows.length && !isDraftSelection) {
      setDetail(null);
      setDraftName("");
      setDraftCategory("personal");
      setDraftContent("");
    }
  }, [allRows, isDraftSelection, selectedKey]);

  useEffect(() => {
    if (!selectedRow) return;
    setExpandedGroups((prev) => {
      if (prev.has(selectedRow.groupKey)) return prev;
      const next = new Set(prev);
      next.add(selectedRow.groupKey);
      return next;
    });
  }, [selectedRow]);

  useEffect(() => {
    if (isDraftSelection) return;
    setNotice("");
    if (!selectedRow) {
      if (!selectedKey.startsWith("installed:")) setDetail(null);
      return;
    }

    if (selectedRow.kind === "installed") {
      const nextDetail = installedDetailQuery.data ?? summaryDetail(selectedRow.skill, "");
      setDetail(nextDetail);
      setDraftName(nextDetail.name);
      setDraftCategory(nextDetail.category);
      setDraftContent(nextDetail.content);
      if (installedDetailQuery.error) setNotice(queryErrorMessage(installedDetailQuery.error, "Could not load skill."));
      return;
    }

    const nextDetail = availableDetailQuery.data ?? summaryDetail(selectedRow.skill, "");
    setDetail(nextDetail);
    setDraftName(nextDetail.name);
    setDraftCategory(nextDetail.category);
    setDraftContent(nextDetail.content);
    if (availableDetailQuery.error) setNotice(queryErrorMessage(availableDetailQuery.error, "Could not load skill preview."));
  }, [
    availableDetailQuery.data,
    availableDetailQuery.error,
    installedDetailQuery.data,
    installedDetailQuery.error,
    isDraftSelection,
    selectedKey,
  ]);

  function toggleGroup(groupKey: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  function isGroupExpanded(groupKey: string) {
    return isSearching || expandedGroups.has(groupKey);
  }

  function openSearch() {
    setIsSearchExpanded(true);
  }

  function closeSearch() {
    setIsSearchExpanded(false);
    setQuery("");
  }

  function requestSelection(nextKey: string) {
    if (nextKey === selectedKey) return;
    if (isDirty) {
      setPendingSelection(nextKey);
      setShowDiscardDialog(true);
      return;
    }
    applySelection(nextKey);
  }

  function requestNewSkill() {
    if (isDirty) {
      setPendingSelection(NEW_SKILL_ACTION);
      setShowDiscardDialog(true);
      return;
    }
    createNewSkill();
  }

  function confirmDiscard() {
    const next = pendingSelection;
    setPendingSelection("");
    setShowDiscardDialog(false);
    if (next === NEW_SKILL_ACTION) createNewSkill();
    else if (next) applySelection(next);
  }

  function applySelection(nextKey: string) {
    setSelectedKey(nextKey);
  }

  function createNewSkill() {
    const nextDetail = draftSkillDetail(profile);
    setSelectedKey(nextDetail.path);
    setDetail(nextDetail);
    setDraftName(nextDetail.name);
    setDraftCategory(nextDetail.category);
    setDraftContent(nextDetail.content);
    setNotice(`New skill draft for ${profile}.`);
  }

  async function saveSkill() {
    if (!canSave) return;
    setNotice("");
    try {
      const result = await saveSkillMutation.mutateAsync({
        profile,
        id: detail && !isVirtualPath(detail.path) ? detail.id : undefined,
        path: detail && !isVirtualPath(detail.path) ? detail.path : undefined,
        name: draftName,
        category: draftCategory,
        content: draftContent,
      });
      setDetail(result.skill);
      setDraftName(result.skill.name);
      setDraftCategory(result.skill.category);
      setDraftContent(result.skill.content);
      setSelectedKey(installedSkillKey(result.skill));
      setNotice(`Saved for ${profile}. New chats use the updated skill.`);
      onProfileSkillsChanged(profile);
    } catch (error) {
      setNotice(queryErrorMessage(error, "Could not save skill."));
    }
  }

  async function installSkill(row: SkillRow, overwrite = false) {
    if (row.kind !== "available") return;
    const skill = row.skill as HermesSkillCatalogItem;
    setNotice("");
    try {
      const result = await installSkillMutation.mutateAsync({
        profile,
        sourceAgentId: skill.sourceAgentId,
        sourceProfile: skill.sourceProfile,
        sourceSkillId: skill.sourceSkillId,
        overwrite,
      });
      setInstallTarget(null);
      setDetail(result.skill);
      setDraftName(result.skill.name);
      setDraftCategory(result.skill.category);
      setDraftContent(result.skill.content);
      setSelectedKey(installedSkillKey(result.skill));
      setNotice(`Installed for ${profile}. Open a fresh chat if an existing session does not pick it up.`);
      onProfileSkillsChanged(profile);
    } catch (error) {
      const message = queryErrorMessage(error, "Could not install skill.");
      setNotice(message);
      if (message.toLowerCase().includes("already exists")) setInstallTarget(row);
    }
  }

  async function removeSkill(row: SkillRow) {
    if (row.kind !== "installed") return;
    const skillId = row.skill.id || "";
    if (!skillId) {
      setNotice("Could not remove skill because its id is missing.");
      return;
    }
    setNotice("");
    try {
      await deleteSkillMutation.mutateAsync({ profile, skillId });
      const nextRow = allRows.find((candidate) => candidate.key !== row.key) ?? null;
      setRemoveTarget(null);
      setSelectedKey(nextRow?.key || "");
      if (!nextRow) setDetail(null);
      setNotice(`Removed from ${profile}. Restart the Hermes gateway if skills are still cached.`);
      onProfileSkillsChanged(profile);
    } catch (error) {
      setNotice(queryErrorMessage(error, "Could not remove skill."));
    }
  }

  const selectedTitle = detail?.name || (listIsLoading ? "Loading skills" : "Select a skill");
  const selectedPath = detail?.path || (connected ? `No skill selected for ${profile}` : "Iris Core is offline");

  return (
    <div className="skills-workspace">
      <div className="skills-browser">
        <aside className="skill-list-panel">
          <div className={`skill-list-controls ${isSearchExpanded ? "is-searching" : ""}`}>
            {isSearchExpanded ? (
              <>
                <div className="skill-search-expanded">
                  <Search aria-hidden="true" />
                  <Input
                    autoFocus
                    value={query}
                    placeholder="Search skills, tags, or categories"
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") closeSearch();
                    }}
                  />
                </div>
                <Button
                  type="button"
                  variant="appIcon"
                  size="icon-sm"
                  aria-label="Close search"
                  title="Close search"
                  onClick={closeSearch}
                >
                  <X />
                </Button>
              </>
            ) : (
              <>
                <h2 className="skill-list-title">Skills</h2>
                <div className="skill-list-actions">
                  <Button
                    type="button"
                    variant="appIcon"
                    size="icon-sm"
                    aria-label="Search"
                    title="Search"
                    onClick={openSearch}
                  >
                    <Search />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="appIcon"
                        size="icon-sm"
                        className="skill-list-source-trigger"
                        aria-label="Source filter"
                        title="Source"
                      >
                        <Store />
                        {sourceFilter !== "all" ? (
                          <span className="skill-source-dot" aria-hidden="true" />
                        ) : null}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuRadioGroup
                        value={sourceFilter}
                        onValueChange={setSourceFilter}
                      >
                        {sourceOptions.map((option) => (
                          <DropdownMenuRadioItem key={option.value} value={option.value}>
                            {option.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    type="button"
                    size="icon-sm"
                    aria-label="New skill"
                    title="New skill"
                    onClick={requestNewSkill}
                  >
                    <Plus />
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className="skill-grid">
            {groupedRows.length ? groupedRows.map((group) => {
              const expanded = isGroupExpanded(group.key);
              const ChevronIcon = expanded ? ChevronDown : ChevronRight;
              return (
                <div key={group.key} className="skill-group">
                  <Button
                    type="button"
                    variant="ghost"
                    className="skill-group-toggle"
                    aria-expanded={expanded}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <span className="skill-group-label">{group.label}</span>
                    <ChevronIcon className="skill-group-chevron" />
                    <span className="skill-group-count">{group.rows.length}</span>
                  </Button>
                  {expanded ? (
                    <div className="skill-group-body">
                      {group.rows.map((row) => (
                        <Button
                          key={row.key}
                          type="button"
                          variant="ghost"
                          className={`skill-row ${row.key === selectedKey ? "active" : ""}`}
                          onClick={() => requestSelection(row.key)}
                        >
                          <div className="skill-icon">
                            <FileCode2 />
                          </div>
                          <div className="skill-row-copy">
                            <p className="skill-row-title">{row.skill.name}</p>
                            <span className="skill-row-description">{row.skill.description}</span>
                            {row.conflict ? <span className="skill-row-meta">conflict</span> : null}
                          </div>
                          <Badge
                            variant="secondary"
                            className={`source-pill ${row.kind}${row.conflict ? " conflict" : ""}`}
                          >
                            {row.sourceLabel}
                          </Badge>
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            }) : (
              <Empty className="skill-empty">
                <EmptyHeader>
                  <EmptyTitle>No skills installed for {profile}.</EmptyTitle>
                  <EmptyDescription>
                    {listIsLoading
                      ? "Loading skills."
                      : connected
                        ? "Create a skill or install one from another local profile."
                        : "Connect to Iris Core to manage this profile."}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button type="button" size="appSmall" onClick={requestNewSkill} disabled={!connected}>
                    <Plus data-icon="inline-start" />
                    New skill
                  </Button>
                </EmptyContent>
              </Empty>
            )}
          </div>
        </aside>

        <section className="skill-detail-panel">
          <div className="skill-detail-header">
            <div>
              <h2>{selectedTitle}</h2>
              <span>{selectedPath}</span>
            </div>
          </div>

          {detail ? (
            <div className="skill-editor-shell">
              <div className="skill-editor-fields">
                <Field>
                  <FieldLabel>Name</FieldLabel>
                  <Input
                    value={draftName}
                    disabled={!isEditable}
                    onChange={(event) => setDraftName(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Category</FieldLabel>
                  <Input
                    value={draftCategory}
                    disabled={!isEditable}
                    onChange={(event) => setDraftCategory(event.target.value)}
                  />
                </Field>
              </div>
              <CodeEditor
                value={draftContent}
                onChange={setDraftContent}
                readOnly={!isEditable}
                metadata={editorMetadata}
              />
            </div>
          ) : (
            <Empty className="skill-detail-placeholder">
              <EmptyHeader>
                <EmptyTitle>No skill selected</EmptyTitle>
                <EmptyDescription>
                  {connected ? `Select or create a skill for ${profile}.` : "Iris Core is offline."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          <div className="skill-detail-footer">
            {notice ? (
              <Alert className="settings-notice skill-detail-notice">
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            ) : (
              <span className="skill-detail-footer-spacer" aria-hidden="true" />
            )}
            <div className="skill-detail-actions">
              {selectedInstalled ? (
                <Button
                  type="button"
                  variant="appIconDanger"
                  size="appSmall"
                  disabled={deleteSkillMutation.isPending}
                  onClick={() => setRemoveTarget(selectedInstalled)}
                >
                  <Trash2 data-icon="inline-start" />
                  Remove from {profile}
                </Button>
              ) : null}
              {isAvailablePreview && selectedAvailable ? (
                <Button
                  type="button"
                  size="appSmall"
                  disabled={installSkillMutation.isPending || selectedDetailLoading}
                  onClick={() => {
                    if (selectedAvailable.conflict) setInstallTarget(selectedAvailable);
                    else void installSkill(selectedAvailable);
                  }}
                >
                  <Download data-icon="inline-start" />
                  Install
                </Button>
              ) : (
                <Button
                  type="button"
                  size="appSmall"
                  disabled={!canSave}
                  onClick={() => void saveSkill()}
                >
                  <Save data-icon="inline-start" />
                  {saveSkillMutation.isPending ? "Saving" : "Save"}
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>

      <Dialog
        open={showDiscardDialog}
        onOpenChange={(open) => {
          setShowDiscardDialog(open);
          if (!open) setPendingSelection("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              Unsaved edits to {detail?.name || "this skill"} will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowDiscardDialog(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDiscard}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove from {profile}?</DialogTitle>
            <DialogDescription>
              {removeTarget?.skill.name || "This skill"} will be removed from {profile}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteSkillMutation.isPending || !removeTarget}
              onClick={() => removeTarget && void removeSkill(removeTarget)}
            >
              Remove from {profile}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(installTarget)} onOpenChange={(open) => !open && setInstallTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Overwrite skill?</DialogTitle>
            <DialogDescription>
              {installTarget?.skill.name || "This skill"} already exists in {profile}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setInstallTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={installSkillMutation.isPending || !installTarget}
              onClick={() => installTarget && void installSkill(installTarget, true)}
            >
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function installedSkillKey(skill: HermesSkill) {
  return `installed:${skill.id || skill.path}`;
}

function availableSkillKey(skill: HermesSkillCatalogItem) {
  return `available:${skill.catalogId || `${skill.sourceProfile}:${skill.sourceSkillId}`}`;
}

function skillSearchText(skill: HermesSkill, sourceLabel: string, profile: string) {
  return `${skill.name} ${skill.description} ${skill.category} ${skill.tags.join(" ")} ${sourceLabel} ${profile}`.toLowerCase();
}

function summaryDetail(skill: HermesSkill, content: string): HermesSkillDetail {
  return {
    ...skill,
    content,
    history: [],
  };
}

function draftSkillDetail(profile: string): HermesSkillDetail {
  const path = `draft://${Date.now()}`;
  const skill: HermesSkill = {
    id: "",
    name: "Untitled skill",
    path,
    category: "personal",
    description: `Draft a new skill for ${profile}.`,
    updatedAt: null,
    source: "installed",
    version: "0.1.0",
    tags: ["draft"],
    bytes: 0,
    metadata: {},
  };
  return {
    ...skill,
    content: defaultSkillContent(skill),
    history: [],
  };
}

function isVirtualPath(path: string) {
  return path.startsWith("draft://");
}

function defaultSkillContent(skill: HermesSkill) {
  return `---
name: ${skill.name}
description: ${skill.description}
category: ${skill.category}
source: installed
version: ${skill.version || "0.1.0"}
tags: [${skill.tags.join(", ")}]
---

# ${skill.name}

Use this skill when the user's request matches this workflow.

## Workflow

1. Confirm the task goal and available context.
2. Gather the minimum evidence needed to act confidently.
3. Execute the workflow and report the result.
`;
}

function extractDraftMetadata(content: string) {
  const metadata: Record<string, string> = {};
  for (const line of content.split("\n").slice(0, 48)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) metadata[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, "");
  }
  return metadata;
}

function queryErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
