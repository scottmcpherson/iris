import { coreRequest } from "./transport";
import type {
  CreateProjectPayload,
  CreateProjectResponse,
  GetProjectSessionsOptions,
  IrisCoreClient,
  IrisProjectListResponse,
  IrisSessionListResponse,
} from "./types";

export function getProjects(client: IrisCoreClient) {
  return coreRequest<IrisProjectListResponse>(client, "GET", "/projects");
}

export function createProject(client: IrisCoreClient, payload: CreateProjectPayload) {
  return coreRequest<CreateProjectResponse>(client, "POST", "/projects", payload);
}

export function getProjectSessions(client: IrisCoreClient, options: GetProjectSessionsOptions) {
  const query = new URLSearchParams({ limit: String(options.limit ?? 80) });
  return coreRequest<IrisSessionListResponse>(
    client,
    "GET",
    `/projects/${encodeURIComponent(options.projectId)}/sessions?${query}`,
  );
}
