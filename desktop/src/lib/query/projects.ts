import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveIrisProject,
  createIrisProject,
  getIrisProjectSessions,
  getIrisProjects,
  linkIrisProjectSession,
  updateIrisProject,
  type IrisProject,
} from "../irisCore";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";
import { sessionKeys } from "./sessions";

export const projectKeys = {
  all: (runtimeKey: string) => ["projects", runtimeKey] as const,
  list: (runtimeKey: string) => [...projectKeys.all(runtimeKey), "list"] as const,
  detail: (runtimeKey: string, projectId: string) => [...projectKeys.all(runtimeKey), "detail", projectId] as const,
  sessions: (runtimeKey: string, projectId: string) => [...projectKeys.detail(runtimeKey, projectId), "sessions"] as const,
};

export function projectsQueryOptions(runtime: HermesRuntimeConfig) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: projectKeys.list(routeKey),
    queryFn: () => ensureOk(getIrisProjects(runtime), "Could not load projects."),
    placeholderData: keepPreviousData,
  });
}

export function projectSessionsQueryOptions(runtime: HermesRuntimeConfig, projectId: string, limit = 80) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: projectKeys.sessions(routeKey, projectId),
    queryFn: () => ensureOk(getIrisProjectSessions(projectId, limit, runtime), "Could not load project sessions."),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  });
}

export function useProjectsQuery(runtime: HermesRuntimeConfig) {
  return useQuery(projectsQueryOptions(runtime));
}

export function useProjectSessionsQuery(runtime: HermesRuntimeConfig, projectId: string, limit = 80) {
  return useQuery(projectSessionsQueryOptions(runtime, projectId, limit));
}

export function useCreateProjectMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (payload: { name: string; defaultAgentId: string; systemPrompt?: string }) =>
      ensureOk(createIrisProject(payload, runtime), "Could not create project."),
    onSuccess: (result) => {
      queryClient.setQueryData(projectKeys.list(routeKey), (current: { projects?: IrisProject[] } | undefined) => ({
        projects: result.project
          ? [result.project, ...(current?.projects || []).filter((project) => project.id !== result.project.id)]
          : current?.projects || [],
      }));
      queryClient.invalidateQueries({ queryKey: projectKeys.list(routeKey) });
    },
  });
}

export function useUpdateProjectMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: ({ projectId, payload }: {
      projectId: string;
      payload: { name?: string; defaultAgentId?: string; systemPrompt?: string };
    }) => ensureOk(updateIrisProject(projectId, payload, runtime), "Could not update project."),
    onSuccess: (result) => {
      queryClient.setQueryData(projectKeys.list(routeKey), (current: { projects?: IrisProject[] } | undefined) => ({
        projects: (current?.projects || []).map((project) => project.id === result.project.id ? result.project : project),
      }));
      queryClient.invalidateQueries({ queryKey: projectKeys.list(routeKey) });
    },
  });
}

export function useArchiveProjectMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (projectId: string) => ensureOk(archiveIrisProject(projectId, runtime), "Could not archive project."),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.list(routeKey) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.all(routeKey) });
    },
  });
}

export function useLinkProjectSessionMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: ({ projectId, sessionId }: { projectId: string; sessionId: string }) =>
      ensureOk(linkIrisProjectSession(projectId, sessionId, runtime), "Could not link project session."),
    onSuccess: (_result, payload) => {
      queryClient.invalidateQueries({ queryKey: projectKeys.sessions(routeKey, payload.projectId) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.all(routeKey) });
    },
  });
}
