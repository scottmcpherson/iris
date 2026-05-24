import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { loadJsonValue, loadStringValue, saveJsonValue, saveStringValue, storageKeys } from "../../app/storage";
import { resolveCoreApiUrl, runtimeDataRouteKey } from "../../app/runtimeConfig";
import { irisCoreSessionToHermes } from "../../lib/irisCoreMappings";
import {
  agentsQueryOptions,
  projectsQueryOptions,
  projectSessionsQueryOptions,
  useCreateProjectMutation,
  useUpdateProjectMutation,
} from "../../lib/query";
import type { HermesSession, HermesRuntimeConfig } from "../../types/hermes";

export type ProjectSessionMap = Record<string, HermesSession[]>;

export type CreateProjectPayload = {
  name: string;
  defaultAgentId: string;
  systemPrompt: string;
};

export type UpdateProjectPayload = CreateProjectPayload;

export function useIrisProjects(runtimeConfig: HermesRuntimeConfig, refreshKey = "") {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery(projectsQueryOptions(runtimeConfig));
  const agentsQuery = useQuery(agentsQueryOptions(runtimeConfig));
  const createProjectMutation = useCreateProjectMutation(runtimeConfig);
  const updateProjectMutation = useUpdateProjectMutation(runtimeConfig);
  const refetchProjectsQuery = projectsQuery.refetch;
  const refetchAgentsQuery = agentsQuery.refetch;
  const [selectedProjectId, setSelectedProjectIdState] = useState(() =>
    loadStringValue(storageKeys.selectedProjectId, ""),
  );
  const [sessionsByProject, setSessionsByProject] = useState<ProjectSessionMap>({});
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
  const projects = projectsQuery.data?.projects || [];
  const agents = agentsQuery.data?.agents || [];
  const projectsLoading = projectsQuery.isFetching || agentsQuery.isFetching;
  const mergedProjectErrors = {
    ...projectErrors,
    list:
      projectErrors.list ||
      (projectsQuery.error instanceof Error ? projectsQuery.error.message : null) ||
      (agentsQuery.error instanceof Error ? agentsQuery.error.message : null),
  };

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );

  const refreshProjects = useCallback(async () => {
    const activeRequestKey = requestKey;
    if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
    try {
      const [projectResult] = await Promise.all([
        refetchProjectsQuery(),
        refetchAgentsQuery(),
      ]);
      if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
      if (projectResult.error) {
        setProjectErrors((current) => ({
          ...current,
          list: projectResult.error instanceof Error ? projectResult.error.message : "Could not load projects.",
        }));
      } else {
        setProjectErrors((current) => ({ ...current, list: null }));
      }
    } catch (error) {
      if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
      setProjectErrors((current) => ({
        ...current,
        list: error instanceof Error ? error.message : "Could not load projects.",
      }));
    }
  }, [refetchAgentsQuery, refetchProjectsQuery, requestKey]);

  const refreshProjectSessions = useCallback(async (projectId: string) => {
    if (!projectId) return;
    const activeRequestKey = requestKey;
    if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
    setProjectSessionsLoading((current) => ({ ...current, [projectId]: true }));
    try {
      const result = await queryClient.fetchQuery(projectSessionsQueryOptions(runtimeConfig, projectId, 80));
      if (!isCurrentRequest(requestKeyRef, activeRequestKey)) return;
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
  }, [queryClient, runtimeConfig, requestKey]);

  useEffect(() => {
    if (previousRouteKeyRef.current === routeKey) return;
    previousRouteKeyRef.current = routeKey;
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
    const result = await createProjectMutation.mutateAsync(payload);
    if (!result.project) throw new Error("Could not create project.");
    selectProject(result.project.id);
    setCollapsedProjectsValue(result.project.id, false);
    return result.project;
  }

  async function updateProject(projectId: string, payload: UpdateProjectPayload) {
    const result = await updateProjectMutation.mutateAsync({ projectId, payload });
    if (!result.project) throw new Error("Could not update project.");
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
    projectErrors: mergedProjectErrors,
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
