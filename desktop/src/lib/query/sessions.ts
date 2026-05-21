import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  sendIrisCoreMessage,
  type CoreMessageAttachmentRef,
  type CoreMetadata,
  type IrisCoreSendMessageResult,
} from "../irisCore";
import {
  deleteIrisSession,
  getIrisSessionDetail,
  getIrisSessions,
  renameIrisSession,
} from "../irisRuntime";
import type { HermesModelSelection, HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";

export const sessionKeys = {
  all: (runtimeKey: string) => ["sessions", runtimeKey] as const,
  lists: (runtimeKey: string) => [...sessionKeys.all(runtimeKey), "list"] as const,
  list: (runtimeKey: string, profile: string) => [...sessionKeys.lists(runtimeKey), profile || "default"] as const,
  detail: (runtimeKey: string, sessionId: string) => [...sessionKeys.all(runtimeKey), "detail", sessionId] as const,
};

export function sessionsQueryOptions(runtime: HermesRuntimeConfig, profile = "default", limit = 80) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: sessionKeys.list(routeKey, profile),
    queryFn: () => ensureOk(getIrisSessions(profile, limit, runtime), "Could not load sessions."),
  });
}

export function sessionDetailQueryOptions(runtime: HermesRuntimeConfig, profile: string, sessionId: string) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: sessionKeys.detail(routeKey, sessionId),
    queryFn: () => ensureOk(getIrisSessionDetail(profile, sessionId, runtime), "Could not load session."),
    enabled: Boolean(sessionId),
  });
}

export type SendMessageMutationPayload = {
  sessionId: string;
  payload: {
    text: string;
    attachments?: CoreMessageAttachmentRef[];
    model?: HermesModelSelection | null;
    clientMessageId?: string;
    metadata?: CoreMetadata;
  };
};

export function useSessionsQuery(runtime: HermesRuntimeConfig, profile = "default", limit = 80) {
  return useQuery(sessionsQueryOptions(runtime, profile, limit));
}

export function useSessionDetailQuery(runtime: HermesRuntimeConfig, profile: string, sessionId: string) {
  return useQuery(sessionDetailQueryOptions(runtime, profile, sessionId));
}

export function useRenameSessionMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: ({ profile, sessionId, title }: { profile: string; sessionId: string; title: string }) =>
      ensureOk(renameIrisSession(profile, sessionId, title, runtime), "Could not rename session."),
    onSuccess: (_result, payload) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list(routeKey, payload.profile) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(routeKey, payload.sessionId) });
    },
  });
}

export function useDeleteSessionMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: ({ profile, sessionId }: { profile: string; sessionId: string }) =>
      ensureOk(deleteIrisSession(profile, sessionId, runtime), "Could not delete session."),
    onSuccess: (_result, payload) => {
      queryClient.invalidateQueries({ queryKey: sessionKeys.list(routeKey, payload.profile) });
      queryClient.removeQueries({ queryKey: sessionKeys.detail(routeKey, payload.sessionId) });
    },
  });
}

export function useSendMessageMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: ({ sessionId, payload }: SendMessageMutationPayload) =>
      ensureOk(sendIrisCoreMessage(sessionId, payload, runtime), "Iris Core did not accept the message."),
    onSuccess: (result: IrisCoreSendMessageResult, variables) => {
      const sessionId = result.canonicalSessionId || result.session?.id || result.sessionId || variables.sessionId;
      queryClient.invalidateQueries({ queryKey: sessionKeys.all(routeKey) });
      queryClient.invalidateQueries({ queryKey: sessionKeys.detail(routeKey, sessionId) });
    },
  });
}
