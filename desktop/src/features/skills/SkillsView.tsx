import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Plus,
  Save,
  Search,
  Store,
  X,
} from "lucide-react";
import { useSaveSkillMutation, useSkillDetailQuery } from "../../lib/query";
import { CodeEditor } from "../../shared/CodeEditor";
import { Alert, AlertDescription } from "../../shared/ui/alert";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Field, FieldLabel } from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu";
import type { HermesRuntimeConfig, HermesSkill, HermesSkillDetail } from "../../types/hermes";

type SkillSource = HermesSkill["source"];

const fallbackSkills: HermesSkill[] = [
  makeVirtualSkill({
    name: "Skill authoring",
    category: "bundled",
    description: "Create and edit Iris procedural memory from successful workflows.",
    path: "hub://bundled/skill-authoring",
    source: "bundled",
    version: "0.1.0",
    tags: ["authoring", "workflow"],
  }),
];

const communitySkills: HermesSkill[] = [
  makeVirtualSkill({
    name: "Research brief",
    category: "community",
    description: "Collect sources, compress evidence, and produce an executive brief.",
    path: "hub://community/research-brief",
    source: "community",
    version: "0.3.0",
    tags: ["research", "brief"],
  }),
  makeVirtualSkill({
    name: "PRD builder",
    category: "community",
    description: "Convert a product idea into an implementation-ready product requirements doc.",
    path: "hub://community/prd-builder",
    source: "community",
    version: "0.2.2",
    tags: ["product", "docs"],
  }),
];

export function SkillsView({
  profile,
  runtimeConfig,
  skills,
  onRefresh,
}: {
  profile: string;
  runtimeConfig: HermesRuntimeConfig;
  skills: HermesSkill[];
  onRefresh: () => void;
}) {
  const installedSkills = skills.length ? skills : fallbackSkills;
  const allSkills = useMemo(() => [...installedSkills, ...communitySkills], [installedSkills]);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SkillSource | "all">("all");
  const [selectedKey, setSelectedKey] = useState("");
  const [detail, setDetail] = useState<HermesSkillDetail | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftCategory, setDraftCategory] = useState("personal");
  const [draftContent, setDraftContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);

  const visibleSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allSkills.filter((skill) => {
      const haystack = `${skill.name} ${skill.description} ${skill.category} ${skill.tags.join(" ")}`.toLowerCase();
      return (
        (!needle || haystack.includes(needle)) &&
        (sourceFilter === "all" || skill.source === sourceFilter)
      );
    });
  }, [allSkills, query, sourceFilter]);

  const groupedSkills = useMemo(() => {
    const map = new Map<string, HermesSkill[]>();
    for (const skill of visibleSkills) {
      const list = map.get(skill.category) ?? [];
      list.push(skill);
      map.set(skill.category, list);
    }
    return Array.from(map.entries())
      .map(([category, items]) => ({ category, skills: items }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }, [visibleSkills]);

  const isSearching = query.trim().length > 0;

  const selectedSkill = allSkills.find((skill) => skillKey(skill) === selectedKey);
  const selectedSkillId = selectedSkill && !isVirtualSkill(selectedSkill)
    ? selectedSkill.id || selectedSkill.path
    : "";
  const skillDetailQuery = useSkillDetailQuery(runtimeConfig, profile, selectedSkillId);
  const saveSkillMutation = useSaveSkillMutation(runtimeConfig);
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
  const canSave = draftName.trim().length > 0 && draftCategory.trim().length > 0;

  useEffect(() => {
    if (selectedKey.startsWith("draft://")) return;
    if (!selectedKey || !visibleSkills.some((skill) => skillKey(skill) === selectedKey)) {
      setSelectedKey(visibleSkills[0] ? skillKey(visibleSkills[0]) : "");
    }
  }, [selectedKey, visibleSkills]);

  useEffect(() => {
    if (!selectedSkill) return;
    setExpandedGroups((prev) => {
      if (prev.has(selectedSkill.category)) return prev;
      const next = new Set(prev);
      next.add(selectedSkill.category);
      return next;
    });
  }, [selectedSkill]);

  function toggleGroup(category: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  function isGroupExpanded(category: string) {
    return isSearching || expandedGroups.has(category);
  }

  function openSearch() {
    setIsSearchExpanded(true);
  }

  function closeSearch() {
    setIsSearchExpanded(false);
    setQuery("");
  }

  useEffect(() => {
    if (!selectedSkill) {
      if (!selectedKey.startsWith("draft://")) setDetail(null);
      return;
    }

    setNotice("");
    if (isVirtualSkill(selectedSkill)) {
      const nextDetail = virtualSkillDetail(selectedSkill);
      setDetail(nextDetail);
      setDraftName(nextDetail.name);
      setDraftCategory(nextDetail.category);
      setDraftContent(nextDetail.content);
      return;
    }

    if (skillDetailQuery.data) {
      setDetail(skillDetailQuery.data);
      setDraftName(skillDetailQuery.data.name);
      setDraftCategory(skillDetailQuery.data.category);
      setDraftContent(skillDetailQuery.data.content);
    } else if (skillDetailQuery.error) {
      const message = skillDetailQuery.error instanceof Error ? skillDetailQuery.error.message : "Could not load skill.";
      setNotice(message);
    }
  }, [selectedKey, selectedSkill, skillDetailQuery.data, skillDetailQuery.error]);

  function createNewSkill() {
    const nextDetail = virtualSkillDetail(
      makeVirtualSkill({
        name: "Untitled skill",
        category: "personal",
        description: "Draft a new Iris skill.",
        path: `draft://${Date.now()}`,
        source: "installed",
        version: "0.1.0",
        tags: ["draft"],
      }),
    );
    setSelectedKey(nextDetail.path);
    setDetail(nextDetail);
    setDraftName(nextDetail.name);
    setDraftCategory(nextDetail.category);
    setDraftContent(nextDetail.content);
    setNotice("New skill draft ready.");
  }

  async function saveSkill() {
    if (!canSave) return;
    setIsSaving(true);
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
      setSelectedKey(result.skill.path);
      setNotice("Skill saved.");
      onRefresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save skill.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="tool-view skills-workspace">
      <div className="skills-browser">
        <aside className="skill-list-panel">
          <div className={`skill-list-controls ${isSearchExpanded ? "is-searching" : ""}`}>
            {isSearchExpanded ? (
              <>
                <div className="skill-search-expanded">
                  <Search aria-hidden="true" size={14} />
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
                        onValueChange={(value) => setSourceFilter(value as SkillSource | "all")}
                      >
                        <DropdownMenuRadioItem value="all">all sources</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="installed">installed</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="bundled">bundled</DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="community">community</DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    type="button"
                    size="icon-sm"
                    aria-label="New skill"
                    title="New skill"
                    onClick={createNewSkill}
                  >
                    <Plus />
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className="skill-grid">
            {groupedSkills.map(({ category, skills: groupSkills }) => {
              const expanded = isGroupExpanded(category);
              const ChevronIcon = expanded ? ChevronDown : ChevronRight;
              return (
                <div key={category} className="skill-group">
                  <Button
                    type="button"
                    variant="ghost"
                    className="skill-group-toggle"
                    aria-expanded={expanded}
                    onClick={() => toggleGroup(category)}
                  >
                    <span className="skill-group-label">{category}</span>
                    <ChevronIcon className="skill-group-chevron" size={13} />
                    <span className="skill-group-count">{groupSkills.length}</span>
                  </Button>
                  {expanded ? (
                    <div className="skill-group-body">
                      {groupSkills.map((skill) => (
                        <Button
                          key={skillKey(skill)}
                          type="button"
                          variant="ghost"
                          className={`skill-row ${skillKey(skill) === selectedKey ? "active" : ""}`}
                          onClick={() => setSelectedKey(skillKey(skill))}
                        >
                          <div className="skill-icon">
                            <FileCode2 size={18} />
                          </div>
                          <div className="skill-row-copy">
                            <p className="skill-row-title">{skill.name}</p>
                            <span className="skill-row-description">{skill.description}</span>
                          </div>
                          <Badge variant="secondary" className={`source-pill ${skill.source}`}>{skill.source}</Badge>
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </aside>

        <section className="skill-detail-panel">
          <div className="skill-detail-header">
            <div>
              <h2>{detail?.name || "Select a skill"}</h2>
              <span>{detail?.path || "No skill selected"}</span>
            </div>
          </div>

          <div className="skill-editor-shell">
            <div className="skill-editor-fields">
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel>Category</FieldLabel>
                <Input value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)} />
              </Field>
            </div>
            <CodeEditor value={draftContent} onChange={setDraftContent} metadata={editorMetadata} />
          </div>

          <div className="skill-detail-footer">
            {notice ? (
              <Alert className="settings-notice skill-detail-notice">
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            ) : (
              <span className="skill-detail-footer-spacer" aria-hidden="true" />
            )}
            <Button size="appSmall" disabled={!canSave || isSaving} onClick={() => void saveSkill()}>
              <Save data-icon="inline-start" />
              {isSaving ? "Saving" : isVirtualPath(detail?.path || "") ? "Install" : "Save"}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

function makeVirtualSkill(skill: Omit<HermesSkill, "updatedAt" | "bytes" | "metadata">): HermesSkill {
  return {
    ...skill,
    updatedAt: null,
    bytes: 0,
    metadata: {
      name: skill.name,
      description: skill.description,
      category: skill.category,
      source: skill.source,
      version: skill.version || "0.1.0",
      tags: skill.tags.join(", "),
    },
  };
}

function skillKey(skill: HermesSkill) {
  return skill.path || `${skill.source}:${skill.category}:${skill.name}`;
}

function isVirtualSkill(skill: HermesSkill) {
  return isVirtualPath(skill.path);
}

function isVirtualPath(path: string) {
  return path.startsWith("hub://") || path.startsWith("draft://");
}

function virtualSkillDetail(skill: HermesSkill): HermesSkillDetail {
  return {
    ...skill,
    content: defaultSkillContent(skill),
    history: [],
  };
}

function defaultSkillContent(skill: HermesSkill) {
  return `---
name: ${skill.name}
description: ${skill.description}
category: ${skill.category}
source: ${skill.source}
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
