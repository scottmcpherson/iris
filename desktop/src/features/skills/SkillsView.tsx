import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  BookOpenCheck,
  Clock3,
  FileCode2,
  Filter,
  History,
  Plus,
  Save,
  Search,
  Sparkles,
  Store,
  Tags,
} from "lucide-react";
import { getIrisSkillDetail, saveIrisSkill } from "../../lib/irisRuntime";
import { ViewHeader } from "../../shared/ViewHeader";
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
  makeVirtualSkill({
    name: "Artifact preview",
    category: "desktop",
    description: "Turn useful previews into reusable skills after validation.",
    path: "hub://bundled/artifact-preview",
    source: "bundled",
    version: "0.1.0",
    tags: ["preview", "artifacts"],
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
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState<SkillSource | "all">("all");
  const [selectedKey, setSelectedKey] = useState("");
  const [detail, setDetail] = useState<HermesSkillDetail | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftCategory, setDraftCategory] = useState("personal");
  const [draftContent, setDraftContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const categories = useMemo(
    () => ["all", ...Array.from(new Set(allSkills.map((skill) => skill.category))).sort()],
    [allSkills],
  );

  const visibleSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allSkills.filter((skill) => {
      const haystack = `${skill.name} ${skill.description} ${skill.category} ${skill.tags.join(" ")}`.toLowerCase();
      return (
        (!needle || haystack.includes(needle)) &&
        (categoryFilter === "all" || skill.category === categoryFilter) &&
        (sourceFilter === "all" || skill.source === sourceFilter)
      );
    });
  }, [allSkills, categoryFilter, query, sourceFilter]);

  const selectedSkill = allSkills.find((skill) => skillKey(skill) === selectedKey);
  const draftMeta = useMemo(() => extractDraftMetadata(draftContent), [draftContent]);
  const hasFrontmatter = draftContent.trimStart().startsWith("---");
  const canSave = draftName.trim().length > 0 && draftCategory.trim().length > 0;

  useEffect(() => {
    if (selectedKey.startsWith("draft://")) return;
    if (!selectedKey || !visibleSkills.some((skill) => skillKey(skill) === selectedKey)) {
      setSelectedKey(visibleSkills[0] ? skillKey(visibleSkills[0]) : "");
    }
  }, [selectedKey, visibleSkills]);

  useEffect(() => {
    let cancelled = false;
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

    void getIrisSkillDetail(profile, selectedSkill.id || selectedSkill.path, runtimeConfig)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.error || "Could not load skill.");
        setDetail(result);
        setDraftName(result.name);
        setDraftCategory(result.category);
        setDraftContent(result.content);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Could not load skill.";
        setNotice(message);
      });

    return () => {
      cancelled = true;
    };
  }, [profile, runtimeConfig, selectedSkill]);

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
      const result = await saveIrisSkill({
        profile,
        id: detail && !isVirtualPath(detail.path) ? detail.id : undefined,
        path: detail && !isVirtualPath(detail.path) ? detail.path : undefined,
        name: draftName,
        category: draftCategory,
        content: draftContent,
        runtime: runtimeConfig,
      });
      if (!result.ok) throw new Error(result.error || "Could not save skill.");
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
      <ViewHeader
        icon={<Sparkles size={19} />}
        eyebrow="Skill browser"
        title="Curate, edit, and version Iris workflows."
        action="New skill"
        onAction={createNewSkill}
      />

      <div className="skills-toolbar">
        <label className="skill-search">
          <Search size={15} />
          <input
            value={query}
            placeholder="Search skills, tags, or categories"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="skill-select">
          <Filter size={15} />
          <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label className="skill-select">
          <Store size={15} />
          <select
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value as SkillSource | "all")}
          >
            <option value="all">all sources</option>
            <option value="installed">installed</option>
            <option value="bundled">bundled</option>
            <option value="community">community</option>
          </select>
        </label>
      </div>

      <div className="skills-browser">
        <aside className="skill-list-panel">
          <div className="skill-list-heading">
            <span>{visibleSkills.length} skills</span>
            <button className="icon-button" aria-label="Create skill" onClick={createNewSkill}>
              <Plus size={15} />
            </button>
          </div>
          <div className="skill-grid">
            {visibleSkills.map((skill) => (
              <button
                key={skillKey(skill)}
                className={`skill-row ${skillKey(skill) === selectedKey ? "active" : ""}`}
                onClick={() => setSelectedKey(skillKey(skill))}
              >
                <div className="skill-icon">
                  <FileCode2 size={18} />
                </div>
                <div>
                  <p>{skill.name}</p>
                  <span>{skill.description}</span>
                </div>
                <small className={`source-pill ${skill.source}`}>{skill.source}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="skill-detail-panel">
          <div className="skill-detail-header">
            <div>
              <p className="eyebrow">Skill detail</p>
              <h2>{detail?.name || "Select a skill"}</h2>
              <span>{detail?.path || "No skill selected"}</span>
            </div>
            <button className="small-button" disabled={!canSave || isSaving} onClick={() => void saveSkill()}>
              <Save size={14} />
              {isSaving ? "Saving" : isVirtualPath(detail?.path || "") ? "Install" : "Save"}
            </button>
          </div>

          <div className="skill-metadata-grid">
            <SkillMeta icon={<BookOpenCheck size={15} />} label="Source" value={detail?.source || "unknown"} />
            <SkillMeta icon={<Tags size={15} />} label="Version" value={draftMeta.version || detail?.version || "none"} />
            <SkillMeta icon={<Clock3 size={15} />} label="Updated" value={formatTime(detail?.updatedAt)} />
            <SkillMeta icon={<History size={15} />} label="History" value={`${detail?.history.length || 0} revisions`} />
          </div>

          <div className="skill-editor-shell">
            <div className="skill-editor-fields">
              <label>
                <span>Name</span>
                <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
              </label>
              <label>
                <span>Category</span>
                <input value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)} />
              </label>
            </div>
            <div className="syntax-strip">
              <span>{hasFrontmatter ? "frontmatter detected" : "frontmatter missing"}</span>
              <span>{draftContent.split("\n").length} lines</span>
              <span>{draftMeta.description || "description not set"}</span>
            </div>
            <div className="skill-code-editor">
              <pre aria-hidden="true">{lineNumbers(draftContent)}</pre>
              <textarea
                spellCheck={false}
                value={draftContent}
                onChange={(event) => setDraftContent(event.target.value)}
              />
            </div>
          </div>

          <div className="skills-lower-grid">
            <div className="skill-history">
              <p className="eyebrow">Change history</p>
              {(detail?.history || []).length ? (
                detail?.history.map((entry) => (
                  <div key={`${entry.version}-${entry.updatedAt}`} className="history-row">
                    <strong>{entry.version}</strong>
                    <span>{entry.summary}</span>
                    <small>{formatTime(entry.updatedAt)}</small>
                  </div>
                ))
              ) : (
                <div className="history-empty">Saved revisions will appear here after edits.</div>
              )}
            </div>
            <div className="skills-hub-panel">
              <p className="eyebrow">Skills Hub</p>
              {communitySkills.map((skill) => (
                <button key={skill.path} onClick={() => setSelectedKey(skillKey(skill))}>
                  <Store size={14} />
                  <span>{skill.name}</span>
                  <small>{skill.version}</small>
                </button>
              ))}
            </div>
          </div>
          {notice ? <p className="settings-notice">{notice}</p> : null}
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

function lineNumbers(content: string) {
  return content
    .split("\n")
    .map((_, index) => index + 1)
    .join("\n");
}

function formatTime(value?: number | null) {
  if (!value) return "not saved";
  return new Date(value * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SkillMeta({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="skill-meta">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
