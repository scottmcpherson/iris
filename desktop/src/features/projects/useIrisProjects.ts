import { useCallback, useEffect, useMemo, useState } from "react";
import { loadJsonValue, loadStringValue, saveJsonValue, saveStringValue, storageKeys } from "../../app/storage";
import {
  createIrisProject,
  getAgentUICoreAgents,
  getIrisProjectConversations,
  getIrisProjects,
  updateIrisProject,
  type AgentUICoreAgent,
  type IrisProject,
} from "../../lib/agentuiCore";
import { coreConversationToLegacy } from "../../lib/coreLegacyCompat";
import type { HermesConversation, HermesRuntimeConfig } from "../../types/hermes";

export type ProjectConversationMap = Record<string, HermesConversation[]>;

export type CreateProjectPayload = {
  name: string;
  defaultAgentId: string;
  systemPrompt: string;
};

export type UpdateProjectPayload = CreateProjectPayload;

export function useIrisProjects(runtimeConfig: HermesRuntimeConfig) {
  const [projects, setProjects] = useState<IrisProject[]>([]);
  const [agents, setAgents] = useState<AgentUICoreAgent[]>([]);
  const [selectedProjectId, setSelectedProjectIdState] = useState(() =>
    loadStringValue(storageKeys.selectedProjectId, ""),
  );
  const [conversationsByProject, setConversationsByProject] = useState<ProjectConversationMap>({});
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectConversationsLoading, setProjectConversationsLoading] = useState<Record<string, boolean>>({});
  const [projectConversationsLoaded, setProjectConversationsLoaded] = useState<Record<string, boolean>>({});
  const [projectErrors, setProjectErrors] = useState<Record<string, string | null>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(
    () => loadCollapsedProjects(),
  );

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );

  const refreshProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const [projectResult, agentResult] = await Promise.all([
        getIrisProjects(runtimeConfig),
        getAgentUICoreAgents(runtimeConfig),
      ]);
      if (projectResult.ok) {
        setProjects(projectResult.projects || []);
        setProjectErrors((current) => ({ ...current, list: null }));
      } else {
        setProjectErrors((current) => ({
          ...current,
          list: projectResult.error || "Could not load projects.",
        }));
      }
      if (agentResult.ok) setAgents(agentResult.agents || []);
    } catch (error) {
      setProjectErrors((current) => ({
        ...current,
        list: error instanceof Error ? error.message : "Could not load projects.",
      }));
    } finally {
      setProjectsLoading(false);
    }
  }, [runtimeConfig]);

  const refreshProjectConversations = useCallback(async (projectId: string) => {
    if (!projectId) return;
    setProjectConversationsLoading((current) => ({ ...current, [projectId]: true }));
    try {
      const result = await getIrisProjectConversations(projectId, 80, runtimeConfig);
      if (!result.ok) {
        setProjectErrors((current) => ({
          ...current,
          [projectId]: result.error || "Could not load project conversations.",
        }));
        setProjectConversationsLoaded((current) => ({ ...current, [projectId]: true }));
        return;
      }
      setConversationsByProject((current) => ({
        ...current,
        [projectId]: (result.conversations || []).map(coreConversationToLegacy),
      }));
      setProjectErrors((current) => ({ ...current, [projectId]: null }));
      setProjectConversationsLoaded((current) => ({ ...current, [projectId]: true }));
    } catch (error) {
      setProjectErrors((current) => ({
        ...current,
        [projectId]: error instanceof Error ? error.message : "Could not load project conversations.",
      }));
      setProjectConversationsLoaded((current) => ({ ...current, [projectId]: true }));
    } finally {
      setProjectConversationsLoading((current) => ({ ...current, [projectId]: false }));
    }
  }, [runtimeConfig]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    for (const project of projects) {
      if (collapsedProjects[project.id]) continue;
      if (projectConversationsLoaded[project.id]) continue;
      if (projectConversationsLoading[project.id]) continue;
      void refreshProjectConversations(project.id);
    }
  }, [
    collapsedProjects,
    projectConversationsLoaded,
    projectConversationsLoading,
    projects,
    refreshProjectConversations,
  ]);

  async function createProject(payload: CreateProjectPayload) {
    const result = await createIrisProject(payload, runtimeConfig);
    if (!result.ok || !result.project) {
      throw new Error(result.error || "Could not create project.");
    }
    setProjects((current) => [result.project, ...current.filter((project) => project.id !== result.project.id)]);
    selectProject(result.project.id);
    setCollapsedProjectsValue(result.project.id, false);
    return result.project;
  }

  async function updateProject(projectId: string, payload: UpdateProjectPayload) {
    const result = await updateIrisProject(projectId, payload, runtimeConfig);
    if (!result.ok || !result.project) {
      throw new Error(result.error || "Could not update project.");
    }
    setProjects((current) =>
      current.map((project) => (project.id === projectId ? result.project : project)),
    );
    return result.project;
  }

  function selectProject(projectId: string | null) {
    const nextProjectId = projectId || "";
    setSelectedProjectIdState(nextProjectId);
    saveStringValue(storageKeys.selectedProjectId, nextProjectId);
  }

  function toggleProjectCollapsed(projectId: string) {
    setCollapsedProjects((current) => {
      const next = { ...current, [projectId]: !current[projectId] };
      saveCollapsedProjects(next);
      return next;
    });
  }

  function setCollapsedProjectsValue(projectId: string, collapsed: boolean) {
    setCollapsedProjects((current) => {
      const next = { ...current, [projectId]: collapsed };
      saveCollapsedProjects(next);
      return next;
    });
  }

  return {
    projects,
    agents,
    selectedProject,
    selectedProjectId,
    conversationsByProject,
    projectsLoading,
    projectConversationsLoading,
    projectConversationsLoaded,
    projectErrors,
    collapsedProjects,
    createProject,
    updateProject,
    refreshProjects,
    refreshProjectConversations,
    selectProject,
    toggleProjectCollapsed,
    setCollapsedProjectsValue,
  };
}

function loadCollapsedProjects() {
  const parsed = loadJsonValue<Record<string, unknown>>(storageKeys.collapsedProjects, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, Boolean(value)]))
    : {};
}

function saveCollapsedProjects(value: Record<string, boolean>) {
  saveJsonValue(storageKeys.collapsedProjects, value);
}
