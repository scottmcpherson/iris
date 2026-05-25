import { getAgentForProfile } from "./agents";
import { coreRequest } from "./transport";
import type {
  CoreMetadata,
  CreateSessionPayload,
  CreateSessionResponse,
  GetSessionDetailOptions,
  GetSessionsOptions,
  IrisCoreClient,
  IrisCoreMessage,
  IrisCoreSession,
  IrisCoreSessionReadState,
  IrisSessionDetailResponse,
  IrisSessionListResponse,
} from "./types";

export async function getSessions(client: IrisCoreClient, options: GetSessionsOptions = {}) {
  let agentId = options.agentId || "";
  if (!agentId && options.profile) {
    const agentResult = await getAgentForProfile(client, options.profile);
    if (!agentResult.ok || !agentResult.agent) {
      return {
        ok: false,
        sessions: [],
        error: ("error" in agentResult && agentResult.error) || "Could not resolve Iris agent.",
      };
    }
    agentId = agentResult.agent.id;
  }

  const query = new URLSearchParams({ limit: String(options.limit ?? 80) });
  if (agentId) query.set("agentId", agentId);
  return coreRequest<IrisSessionListResponse>(client, "GET", `/sessions?${query}`);
}

export function createSession(client: IrisCoreClient, payload: CreateSessionPayload) {
  return coreRequest<CreateSessionResponse>(client, "POST", "/sessions", payload);
}

export function updateSession(
  client: IrisCoreClient,
  sessionId: string,
  payload: { title?: string; metadata?: CoreMetadata },
) {
  return coreRequest<{ session: IrisCoreSession }>(
    client,
    "PATCH",
    `/sessions/${encodeURIComponent(sessionId)}`,
    payload,
  );
}

export function deleteSession(client: IrisCoreClient, sessionId: string) {
  return coreRequest<{ sessionId: string }>(
    client,
    "DELETE",
    `/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function getSessionDetail(client: IrisCoreClient, options: GetSessionDetailOptions) {
  const [sessionResult, messagesResult] = await Promise.all([
    getSession(client, options),
    getSessionMessages(client, options),
  ]);
  if (!sessionResult.ok || !messagesResult.ok) {
    return {
      ok: false,
      session: sessionResult.session || null,
      messages: messagesResult.messages || [],
      warning: messagesResult.warning,
      error: sessionResult.error || messagesResult.error || "Could not load session.",
    } as IrisSessionDetailResponse & { ok: false; error: string };
  }
  return {
    ok: true,
    session: sessionResult.session,
    messages: messagesResult.messages,
    warning: messagesResult.warning,
  } as IrisSessionDetailResponse & { ok: true };
}

export function getSession(client: IrisCoreClient, options: GetSessionDetailOptions) {
  return coreRequest<{ session: IrisCoreSession }>(
    client,
    "GET",
    `/sessions/${encodeURIComponent(options.sessionId)}${sessionReferenceQuery(options)}`,
  );
}

export function getSessionMessages(client: IrisCoreClient, options: GetSessionDetailOptions) {
  return coreRequest<{ sessionId: string; messages: IrisCoreMessage[]; warning?: string }>(
    client,
    "GET",
    `/sessions/${encodeURIComponent(options.sessionId)}/messages${sessionReferenceQuery(options)}`,
  );
}

export function updateSessionReadState(
  client: IrisCoreClient,
  sessionId: string,
  state: "read" | "unread",
  metadata: CoreMetadata = {},
) {
  return coreRequest<{ readState: IrisCoreSessionReadState }>(
    client,
    "PATCH",
    `/sessions/${encodeURIComponent(sessionId)}/read-state`,
    { state, metadata },
  );
}

function sessionReferenceQuery(reference: { externalSessionId?: string; externalChatId?: string }) {
  const query = new URLSearchParams();
  if (reference.externalSessionId) query.set("externalSessionId", reference.externalSessionId);
  if (reference.externalChatId) query.set("externalChatId", reference.externalChatId);
  const value = query.toString();
  return value ? `?${value}` : "";
}
