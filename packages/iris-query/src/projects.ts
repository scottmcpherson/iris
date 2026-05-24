import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createProject,
  getProjectSessions,
  getProjects,
  type CreateProjectPayload,
  type IrisCoreClient,
  type IrisProject,
} from "@iris/core-client";
import { ensureOk } from "./ensureOk";
import { sessionKeys } from "./sessions";

export const projectKeys = {
  all: (clientKey: string) => ["projects", clientKey] as const,
  list: (clientKey: string) => [...projectKeys.all(clientKey), "list"] as const,
  detail: (clientKey: string, projectId: string) => [...projectKeys.all(clientKey), "detail", projectId] as const,
  sessions: (clientKey: string, projectId: string) => [...projectKeys.detail(clientKey, projectId), "sessions"] as const,
};

export function projectsQueryOptions(client: IrisCoreClient | null, clientKey: string) {
  return queryOptions({
    queryKey: projectKeys.list(clientKey),
    queryFn: () => {
      if (!client) throw new Error("Iris Core is not connected.");
      return ensureOk(getProjects(client), "Could not load projects.");
    },
    enabled: Boolean(client),
    placeholderData: keepPreviousData,
  });
}

export function projectSessionsQueryOptions(
  client: IrisCoreClient | null,
  clientKey: string,
  projectId: string,
  limit = 80,
) {
  return queryOptions({
    queryKey: projectKeys.sessions(clientKey, projectId),
    queryFn: () => {
      if (!client) throw new Error("Iris Core is not connected.");
      return ensureOk(getProjectSessions(client, { projectId, limit }), "Could not load project sessions.");
    },
    enabled: Boolean(client && projectId),
    placeholderData: keepPreviousData,
  });
}

export function useProjectsQuery(client: IrisCoreClient | null, clientKey: string) {
  return useQuery(projectsQueryOptions(client, clientKey));
}

export function useProjectSessionsQuery(
  client: IrisCoreClient | null,
  clientKey: string,
  projectId: string,
  limit = 80,
) {
  return useQuery(projectSessionsQueryOptions(client, clientKey, projectId, limit));
}

export function useCreateProjectMutation(client: IrisCoreClient | null, clientKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateProjectPayload) => {
      if (!client) throw new Error("Iris Core is not connected.");
      return ensureOk(createProject(client, payload), "Could not create project.");
    },
    onSuccess: (result) => {
      queryClient.setQueryData(projectKeys.list(clientKey), (current: { projects?: IrisProject[] } | undefined) => ({
        projects: result.project
          ? [result.project, ...(current?.projects || []).filter((project) => project.id !== result.project.id)]
          : current?.projects || [],
      }));
      queryClient.invalidateQueries({ queryKey: projectKeys.list(clientKey) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.all(clientKey) });
    },
  });
}
