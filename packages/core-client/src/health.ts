import { coreRequest } from "./transport";
import type { IrisCoreClient, IrisCoreHealthResponse } from "./types";

export function getHealth(client: IrisCoreClient) {
  return coreRequest<IrisCoreHealthResponse>(client, "GET", "/health");
}
