import type { QueryClient } from "@tanstack/react-query";
import { projectKeys, sessionKeys } from "@iris/iris-query";
import {
  updateSessionReadState,
  type CoreMetadata,
  type IrisCoreClient,
  type IrisCoreSession,
  type IrisCoreSessionReadState,
} from "@iris/core-client";

type SessionCache = {
  session?: IrisCoreSession;
  sessions?: IrisCoreSession[];
};

export function mobileReadState(
  sessionId: string,
  existingReadState?: IrisCoreSessionReadState,
  metadata: CoreMetadata = {},
): IrisCoreSessionReadState {
  const now = Math.floor(Date.now() / 1000);
  return {
    sessionId,
    state: "read",
    createdAt: existingReadState?.createdAt ?? now,
    updatedAt: now,
    metadata: {
      ...(existingReadState?.metadata || {}),
      ...metadata,
    },
  };
}

export function patchCachedSessionReadState(
  queryClient: QueryClient,
  clientKey: string,
  sessionId: string,
  readState: IrisCoreSessionReadState,
) {
  const patchSession = (session: IrisCoreSession) =>
    session.id === sessionId ? { ...session, readState } : session;

  const patchCache = <TData,>(current: TData): TData => {
    if (!current || typeof current !== "object") return current;
    const cache = current as SessionCache;
    if (!cache.session && !Array.isArray(cache.sessions)) return current;
    return {
      ...current,
      ...(cache.session ? { session: patchSession(cache.session) } : {}),
      ...(Array.isArray(cache.sessions)
        ? { sessions: cache.sessions.map((session) => patchSession(session)) }
        : {}),
    } as TData;
  };

  queryClient.setQueriesData({ queryKey: sessionKeys.all(clientKey) }, patchCache);
  queryClient.setQueriesData({ queryKey: projectKeys.all(clientKey) }, patchCache);
}

export function markMobileSessionRead({
  client,
  clientKey,
  existingReadState,
  metadata = {},
  queryClient,
  sessionId,
}: {
  client: IrisCoreClient | null;
  clientKey: string;
  existingReadState?: IrisCoreSessionReadState;
  metadata?: CoreMetadata;
  queryClient: QueryClient;
  sessionId: string;
}) {
  if (!sessionId) return;
  const readState = mobileReadState(sessionId, existingReadState, metadata);
  patchCachedSessionReadState(queryClient, clientKey, sessionId, readState);
  if (client) void updateSessionReadState(client, sessionId, "read", metadata);
}

export function mobileSessionShowsUnread(session: IrisCoreSession, selected = false) {
  return !selected && session.readState?.state === "unread";
}
