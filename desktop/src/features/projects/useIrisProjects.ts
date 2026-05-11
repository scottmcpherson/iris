import { useCallback, useEffect, useMemo, useState } from "react";
import { loadJsonValue, loadStringValue, saveJsonValue, saveStringValue, storageKeys } from "../../app/storage";
import {
  createIrisProject,
  getAgentUICoreAgents,
  getIrisProjectSessions,
  getIrisProjects,
  updateIrisProject,
  type AgentUICoreAgent,
  type IrisProject,
} from "../../lib/agentuiCore";
import { coreSessionToLegacy } from "../../lib/coreLegacyCompat";
import type { HermesSession, HermesRuntimeConfig } from "../../types/hermes";

export type ProjectSessionMap = Record<string, HermesSession[]>;

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
  const [sessionsByProject, setSessionsByProject] = useState<ProjectSessionMap>({});
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectSessionsLoading, setProjectSessionsLoading] = useState<Record<string, boolean>>({});
  const [projectSessionsLoaded, setProjectSessionsLoaded] = useState<Record<string, boolean>>({});
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

  const refreshProjectSessions = useCallback(async (projectId: string) => {
    if (!projectId) return;
    setProjectSessionsLoading((current) => ({ ...current, [projectId]: true }));
    try {
      const result = await getIrisProjectSessions(projectId, 80, runtimeConfig);
      if (!result.ok) {
        setProjectErrors((current) => ({
          ...current,
          [projectId]: result.error || "Could not load project sessions.",
        }));
        setProjectSessionsLoaded((current) => ({ ...current, [projectId]: true }));
        return;
      }
      setSessionsByProject((current) => ({
        ...current,
        [projectId]: (result.sessions || []).map(coreSessionToLegacy),
      }));
      setProjectErrors((current) => ({ ...current, [projectId]: null }));
      setProjectSessionsLoaded((current) => ({ ...current, [projectId]: true }));
    } catch (error) {
      setProjectErrors((current) => ({
        ...current,
        [projectId]: error instanceof Error ? error.message : "Could not load project sessions.",
      }));
      setProjectSessionsLoaded((current) => ({ ...current, [projectId]: true }));
    } finally {
      setProjectSessionsLoading((current) => ({ ...current, [projectId]: false }));
    }
  }, [runtimeConfig]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (Object.values(projectSessionsLoading).some(Boolean)) return;
    const nextProject =
      projects.find(
        (project) =>
          project.id === selectedProjectId &&
          !collapsedProjects[project.id] &&
          !projectSessionsLoaded[project.id],
      ) ||
      projects.find(
        (project) =>
          !collapsedProjects[project.id] &&
          !projectSessionsLoaded[project.id],
      );
    if (nextProject) void refreshProjectSessions(nextProject.id);
  }, [
    collapsedProjects,
    projectSessionsLoaded,
    projectSessionsLoading,
    projects,
    refreshProjectSessions,
    selectedProjectId,
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
    sessionsByProject,
    projectsLoading,
    projectSessionsLoading,
    projectSessionsLoaded,
    projectErrors,
    collapsedProjects,
    createProject,
    updateProject,
    refreshProjects,
    refreshProjectSessions,
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
