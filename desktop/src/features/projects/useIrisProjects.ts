import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadJsonValue, loadStringValue, saveJsonValue, saveStringValue, storageKeys } from "../../app/storage";
import { resolveCoreApiUrl, runtimeDataRouteKey } from "../../app/runtimeConfig";
import {
  createIrisProject,
  getIrisCoreAgents,
  getIrisProjectSessions,
  getIrisProjects,
  updateIrisProject,
  type IrisCoreAgent,
  type IrisProject,
} from "../../lib/irisCore";
import { irisCoreSessionToHermes } from "../../lib/irisCoreMappings";
import type { HermesSession, HermesRuntimeConfig } from "../../types/hermes";

export type ProjectSessionMap = Record<string, HermesSession[]>;

export type CreateProjectPayload = {
  name: string;
  defaultAgentId: string;
  systemPrompt: string;
};

export type UpdateProjectPayload = CreateProjectPayload;

export function useIrisProjects(runtimeConfig: HermesRuntimeConfig, refreshKey = "") {
  const [projects, setProjects] = useState<IrisProject[]>([]);
  const [agents, setAgents] = useState<IrisCoreAgent[]>([]);
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
  const routeKey = runtimeDataRouteKey(runtimeConfig);
  const requestKey = `${routeKey}|${resolveCoreApiUrl(runtimeConfig)}`;
  const requestKeyRef = useRef(requestKey);
  const previousRouteKeyRef = useRef(routeKey);
  requestKeyRef.current = requestKey;

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );

  const refreshProjects = useCallback(async () => {
    const activeRequestKey = requestKey;
    if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
    setProjectsLoading(true);
    try {
      const [projectResult, agentResult] = await Promise.all([
        getIrisProjects(runtimeConfig),
        getIrisCoreAgents(runtimeConfig),
      ]);
      if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
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
      if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
      setProjectErrors((current) => ({
        ...current,
        list: error instanceof Error ? error.message : "Could not load projects.",
      }));
    } finally {
      if (isCurrentRequest(requestKeyRef, activeRequestKey)) {
        setProjectsLoading(false);
      }
    }
  }, [runtimeConfig, requestKey]);

  const refreshProjectSessions = useCallback(async (projectId: string) => {
    if (!projectId) return;
    const activeRequestKey = requestKey;
    if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
    setProjectSessionsLoading((current) => ({ ...current, [projectId]: true }));
    try {
      const result = await getIrisProjectSessions(projectId, 80, runtimeConfig);
      if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
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
        [projectId]: (result.sessions || []).map(irisCoreSessionToHermes),
      }));
      setProjectErrors((current) => ({ ...current, [projectId]: null }));
      setProjectSessionsLoaded((current) => ({ ...current, [projectId]: true }));
    } catch (error) {
      if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
      setProjectErrors((current) => ({
        ...current,
        [projectId]: error instanceof Error ? error.message : "Could not load project sessions.",
      }));
      setProjectSessionsLoaded((current) => ({ ...current, [projectId]: true }));
    } finally {
      if (isCurrentRequest(requestKeyRef, activeRequestKey)) {
        setProjectSessionsLoading((current) => ({ ...current, [projectId]: false }));
      }
    }
  }, [runtimeConfig, requestKey]);

  useEffect(() => {
    if (previousRouteKeyRef.current === routeKey) return;
    previousRouteKeyRef.current = routeKey;
    setProjects([]);
    setAgents([]);
    setSelectedProjectIdState("");
    saveStringValue(storageKeys.selectedProjectId, "");
    setSessionsByProject({});
    setProjectSessionsLoading({});
    setProjectSessionsLoaded({});
    setProjectErrors({});
  }, [routeKey]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects, refreshKey]);

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

function isCurrentRequest(ref: { current: string }, activeRequestKey: string) {
  return ref.current === activeRequestKey;
}
