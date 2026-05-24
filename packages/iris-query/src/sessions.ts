import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSession,
  getSessionDetail,
  getSessions,
  sendMessage,
  type CreateSessionPayload,
  type IrisCoreClient,
  type IrisCoreSendMessageResult,
  type SendMessagePayload,
} from "@iris/core-client";
import { ensureOk } from "./ensureOk";

export const sessionKeys = {
  all: (clientKey: string) => ["sessions", clientKey] as const,
  lists: (clientKey: string) => [...sessionKeys.all(clientKey), "list"] as const,
  list: (clientKey: string, profile: string) => [...sessionKeys.lists(clientKey), profile || "default"] as const,
  detail: (clientKey: string, sessionId: string) => [...sessionKeys.all(clientKey), "detail", sessionId] as const,
};

export function sessionsQueryOptions(
  client: IrisCoreClient | null,
  clientKey: string,
  profile = "default",
  limit = 80,
) {
  return queryOptions({
    queryKey: sessionKeys.list(clientKey, profile),
    queryFn: () => {
      if (!client) throw new Error("Iris Core is not connected.");
      return ensureOk(getSessions(client, { profile, limit }), "Could not load sessions.");
    },
    enabled: Boolean(client),
  });
}

export function sessionDetailQueryOptions(
  client: IrisCoreClient | null,
  clientKey: string,
  sessionId: string,
) {
  return queryOptions({
    queryKey: sessionKeys.detail(clientKey, sessionId),
    queryFn: () => {
      if (!client) throw new Error("Iris Core is not connected.");
      return ensureOk(getSessionDetail(client, { sessionId }), "Could not load session.");
    },
    enabled: Boolean(client && sessionId),
  });
}

export type SendMessageMutationPayload = {
  sessionId: string;
  payload: SendMessagePayload;
};

export function useSessionsQuery(
  client: IrisCoreClient | null,
  clientKey: string,
  profile = "default",
  limit = 80,
) {
  return useQuery(sessionsQueryOptions(client, clientKey, profile, limit));
}

export function useSessionDetailQuery(client: IrisCoreClient | null, clientKey: string, sessionId: string) {
  return useQuery(sessionDetailQueryOptions(client, clientKey, sessionId));
}

export function useCreateSessionMutation(client: IrisCoreClient | null, clientKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateSessionPayload) => {
      if (!client) throw new Error("Iris Core is not connected.");
      return ensureOk(createSession(client, payload), "Could not create session.");
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.all(clientKey) });
      if (result.session?.id) {
        queryClient.invalidateQueries({ queryKey: sessionKeys.detail(clientKey, result.session.id) });
      }
    },
  });
}

export function useSendMessageMutation(client: IrisCoreClient | null, clientKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, payload }: SendMessageMutationPayload) => {
      if (!client) throw new Error("Iris Core is not connected.");
      return ensureOk(sendMessage(client, sessionId, payload), "Iris Core did not accept the message.");
    },
    onSuccess: (result: IrisCoreSendMessageResult, variables) => {
      const sessionId = result.canonicalSessionId || result.session?.id || result.sessionId || variables.sessionId;
      queryClient.invalidateQueries({ queryKey: sessionKeys.all(clientKey) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(clientKey, sessionId) });
    },
  });
}
