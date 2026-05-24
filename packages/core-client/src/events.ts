import { coreBaseUrl, coreRequest } from "./transport";
import type {
  GetEventsOptions,
  IrisCoreClient,
  IrisCoreEventsResponse,
  LatestEventCursorResponse,
} from "./types";

export function getEvents(client: IrisCoreClient, options: GetEventsOptions = {}) {
  const query = eventsQuery(options);
  return coreRequest<IrisCoreEventsResponse>(client, "GET", `/events?${query}`);
}

export function getLatestEventCursor(client: IrisCoreClient, agentId = "") {
  return getEvents(client, { after: Number.MAX_SAFE_INTEGER, limit: 1, agentId }) as Promise<
    LatestEventCursorResponse & { ok: boolean; error?: string }
  >;
}

export function eventStreamUrl(client: IrisCoreClient, options: GetEventsOptions = {}) {
  return `${coreBaseUrl(client)}/events/stream?${eventsQuery(options)}`;
}

function eventsQuery(options: GetEventsOptions) {
  const query = new URLSearchParams({
    after: String(options.after ?? 0),
    limit: String(options.limit ?? 200),
  });
  if (options.agentId) query.set("agentId", options.agentId);
  if (options.automationOnly) query.set("automationOnly", "true");
  if (options.order) query.set("order", options.order);
  return query;
}
