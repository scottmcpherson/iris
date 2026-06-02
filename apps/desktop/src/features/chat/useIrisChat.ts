import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Message, MessageAttachment } from "../../app/types";
import {
  irisCoreEventToDeliveryMessage,
} from "../../lib/irisRuntime";
import {
  openCoreEventStream,
  cancelIrisCoreMessage,
  createIrisCoreSession,
  getIrisCoreEvents,
  getIrisCoreAgentForProfile,
  getIrisCoreLatestEventCursor,
  updateIrisCoreSessionReadState,
  type CoreEventStreamHandle,
  type IrisCoreEvent,
  type CoreMetadata,
} from "../../lib/irisCore";
import { irisCoreSessionToHermes } from "../../lib/irisCoreMappings";
import { resolveCoreApiUrl, runtimeDataRouteKey } from "../../app/runtimeConfig";
import {
  sessionDetailQueryOptions,
  sessionKeys,
  sessionsQueryOptions,
  useDeleteSessionMutation,
  useRenameSessionMutation,
  useSendMessageMutation,
} from "../../lib/query";
import type {
  HermesSession,
  HermesInboxMessage,
  HermesModelSelection,
  HermesRuntimeConfig,
} from "../../types/hermes";
import { compactText } from "../../shared/strings";
import { AttachmentUploadError, formatPromptWithAttachments, uploadAttachmentsForSend } from "./chatAttachments";
import { ASSISTANT_THINKING_TEXT, isAssistantThinkingPlaceholder } from "./assistantStatus";
import type { PendingProfileSessionSelection, SendMessageOptions } from "./chatTypes";
import {
  booleanMetadata,
  isHiddenDeliveryMetadata,
  stringMetadata,
  toAppMessages,
} from "./chatHistory";
import {
  completeRunningToolCards,
  deliveryCompletesActiveStream,
  mergeErrorDelivery,
  mergeCompletedDelivery,
  mergeStreamDelivery,
  mergeToolProgressDelivery,
  reconcileMessages,
} from "./chatStreamMerging";
import {
  activeSessionReplacements,
  activeRequestCompletedByHistory,
  sessionIdsForChatId,
  sessionTitleFromPrompt,
  isCoreSessionId,
  isOptimisticSession,
  isOptimisticSessionId,
  isTransientSessionLoadError,
  mergeSessionChatIdMap,
  mergeSessionReadStates,
  mergeOptimisticSessions,
  mergeRelatedSessionMessages,
  modelSwitchSelectionForSend,
  migrateActiveRequestId,
  migrateSessionMessages,
  migrateSessionValue,
  migrateModelSelection,
  optimisticSessionFromPrompt,
  preserveActiveSessionTitles,
  preserveLocalSessionProjectMetadata,
  preserveLocalScheduledDeliveries,
  removeActiveRequestIds,
  removeSessionForProfile,
  removeSessionsForProfile,
  removeSessionValues,
  removeModelSelections,
  removeReadStates,
  replacementForOptimisticSession,
  selectionFromSession,
  setSessionMessages,
  shouldApplySessionDetailSelection,
  shouldPreserveLocalMessagesOnEmptyHistory,
  shouldPreserveProfileSessionSelection,
  shouldRetryUnmappedDelivery,
  shouldSkipSessionDetailLoad,
  scheduleDedupedTimer,
  updateSessionReadStateForProfiles,
  upsertSessionForProfile,
  upsertSessionMetadataForProfile,
  sessionMetadataShouldPropagate,
  visibleSessionForSelection,
} from "./chatSessionState";
import {
  dedupeInboxDeliveries,
  runtimeChatId,
  shouldApplyDeliveryReadState,
  streamDeliveryFinalized,
} from "./chatCoreEvents";

export { isHiddenDeliveryMetadata, stripModelSwitchNote, toAppMessages } from "./chatHistory";
export {
  coalescePostStreamAttachments,
  deliveryCompletesActiveStream,
  mergeErrorDelivery,
  mergeCompletedDelivery,
  mergeMessageLists,
  mergeStreamDelivery,
} from "./chatStreamMerging";
export { mergeUploadedAttachment } from "./chatAttachments";
export {
  activeSessionReplacements,
  activeRequestCompletedByHistory,
  isTransientSessionLoadError,
  mergeSessionChatIdMap,
  mergeSessionReadStates,
  modelSwitchSelectionForSend,
  preserveActiveSessionTitles,
  preserveLocalSessionProjectMetadata,
  preserveLocalScheduledDeliveries,
  scheduleDedupedTimer,
  sessionMetadataShouldPropagate,
  shouldApplySessionDetailSelection,
  shouldPreserveLocalMessagesOnEmptyHistory,
  shouldPreserveProfileSessionSelection,
  shouldRetryUnmappedDelivery,
  shouldSendModelSwitch,
  shouldSkipSessionDetailLoad,
  upsertSessionMetadataForProfile,
} from "./chatSessionState";
export type { SendableAttachment } from "./chatTypes";

type UseIrisChatOptions = {
  profile: string;
  runtimeConfig: HermesRuntimeConfig;
  isChatViewActive?: boolean;
  onSessionMetadataResolved?: (sessionId: string, projectId: string | null) => void;
};

export const SESSION_TITLE_RESOLVE_DELAY_MS = 3000;
export const STREAM_SAFETY_TIMEOUT_MS = 60_000;
const STREAM_SAFETY_CHECK_INTERVAL_MS = 5_000;
const STREAM_SAFETY_TIMEOUT_MESSAGE = "Iris stopped receiving stream updates before the response completed.";

export function resolveDeliveryClientRequestId(clientRequestId: string, replyTo: string, replyToIsActive: boolean) {
  return clientRequestId || (replyToIsActive ? replyTo : "");
}

export function useIrisChat({
  profile,
  runtimeConfig,
  isChatViewActive = true,
  onSessionMetadataResolved,
}: UseIrisChatOptions) {
  const queryClient = useQueryClient();
  const renameSessionMutation = useRenameSessionMutation(runtimeConfig);
  const deleteSessionMutation = useDeleteSessionMutation(runtimeConfig);
  const sendMessageMutation = useSendMessageMutation(runtimeConfig);
  const [input, setInput] = useState("");
  const [messagesBySession, setMessagesBySession] = useState<Record<string, Message[]>>({});
  const [activeRequestIdsBySession, setActiveRequestIdsBySession] = useState<Record<string, string>>({});
  const [sessionReadStates, setSessionReadStates] = useState<Record<string, "read" | "unread">>({});
  const [sessionsByProfile, setSessionsByProfile] = useState<Record<string, HermesSession[]>>({});
  const [sessionsLoadedByProfile, setSessionsLoadedByProfile] = useState<Record<string, boolean>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionsLoadingByProfile, setSessionsLoadingByProfile] = useState<Record<string, boolean>>({});
  const [historyErrorsByProfile, setHistoryErrorsByProfile] = useState<Record<string, string | null>>({});
  const [historySource, setHistorySource] = useState<string | null>(null);
  const [historySchemaVersion, setHistorySchemaVersion] = useState<number | null>(null);
  const [sessionChatIdsBySession, setSessionChatIdsBySession] = useState<Record<string, string>>({});
  const [modelSelectionBySession, setModelSelectionBySession] = useState<Record<string, HermesModelSelection>>({});
  // Fetch cursor: the `after` for the next SSE/poll request. Advances past every
  // fetched event so we never refetch. Applied high-water: the highest cursor we
  // have committed to message state; used to dedupe SSE+poll overlap. Because
  // every event is a full snapshot, reprocessing is idempotent, so this dedupe is
  // belt-and-suspenders rather than load-bearing.
  const eventCursorsByProfileRef = useRef<Record<string, number>>({});
  const lastAppliedCursorByProfileRef = useRef<Record<string, number>>({});
  const eventCursorBootstrapKeysRef = useRef<Record<string, string>>({});
  const eventConsumerStartedAtRef = useRef(Math.floor(Date.now() / 1000));
  const pendingGatewayDeliveriesRef = useRef<HermesInboxMessage[]>([]);
  const pendingUnmappedDeliveryAttemptsRef = useRef<Record<string, number>>({});
  const pendingProfileSelectionRef = useRef<PendingProfileSessionSelection | null>(null);
  const coreEventStreamRef = useRef<CoreEventStreamHandle | null>(null);
  const sendInFlightRef = useRef(false);
  const messagesBySessionRef = useRef(messagesBySession);
  const activeRequestIdsBySessionRef = useRef(activeRequestIdsBySession);
  const activeRequestTouchedAtRef = useRef<Record<string, number>>({});
  const activeSessionTitlesBySessionRef = useRef<Record<string, string>>({});
  const selectedSessionIdRef = useRef(selectedSessionId);
  const hasActiveRequestRef = useRef(false);
  const isChatViewActiveRef = useRef(isChatViewActive);
  const sessionChatIdsBySessionRef = useRef(sessionChatIdsBySession);
  const sessionsByProfileRef = useRef(sessionsByProfile);
  const onSessionMetadataResolvedRef = useRef(onSessionMetadataResolved);
  onSessionMetadataResolvedRef.current = onSessionMetadataResolved;
  const pendingTitleResolveRef = useRef<Set<string>>(new Set());
  const routeKey = runtimeDataRouteKey(runtimeConfig);
  const coreApiUrl = resolveCoreApiUrl(runtimeConfig);
  const requestKey = `${routeKey}|${coreApiUrl}`;
  const requestKeyRef = useRef(requestKey);
  const previousRouteKeyRef = useRef(routeKey);
  const previousRequestKeyRef = useRef(requestKey);
  const sessions = sessionsByProfile[profile] || [];
  const sessionsLoading = Boolean(sessionsLoadingByProfile[profile]);
  const historyError = historyErrorsByProfile[profile] || null;
  const visibleSessionId = visibleSessionForSelection(
    selectedSessionId,
    sessions,
    sessionChatIdsBySession,
    messagesBySession,
  );
  const messages = visibleSessionId ? messagesBySession[visibleSessionId] || [] : [];
  const activeRequestId = visibleSessionId
    ? activeRequestIdsBySession[visibleSessionId] || null
    : null;
  const activeSessionIds = useMemo(
    () => Object.keys(activeRequestIdsBySession),
    [activeRequestIdsBySession],
  );
  const hasActiveRequest = activeSessionIds.length > 0;
  const selectedSession = visibleSessionId
    ? sessions.find((session) => session.id === visibleSessionId) || null
    : null;
  const selectedModelSelection = visibleSessionId
    ? modelSelectionBySession[visibleSessionId] || selectionFromSession(selectedSession)
    : null;

  messagesBySessionRef.current = messagesBySession;
  activeRequestIdsBySessionRef.current = activeRequestIdsBySession;
  hasActiveRequestRef.current = hasActiveRequest;
  selectedSessionIdRef.current = selectedSessionId;
  isChatViewActiveRef.current = isChatViewActive;
  sessionChatIdsBySessionRef.current = sessionChatIdsBySession;
  sessionsByProfileRef.current = sessionsByProfile;
  requestKeyRef.current = requestKey;

  function patchSessionsQuery(profileName: string, updater: (sessions: HermesSession[]) => HermesSession[]) {
    queryClient.setQueryData<{ sessions: HermesSession[] }>(
      sessionKeys.list(routeKey, profileName),
      (current) => current ? { ...current, sessions: updater(current.sessions || []) } : current,
    );
  }

  function invalidateSessionQueries(profileName = profile, sessionId = "") {
    queryClient.invalidateQueries({ queryKey: sessionKeys.list(routeKey, profileName) });
    if (sessionId) queryClient.invalidateQueries({ queryKey: sessionKeys.detail(routeKey, sessionId) });
  }

  useEffect(() => {
    if (!isChatViewActive || !selectedSessionId) return;
    markSessionRead(selectedSessionId, { reason: "active-selection" });
  }, [isChatViewActive, selectedSessionId]);

  useEffect(() => {
    if (previousRouteKeyRef.current === routeKey) return;
    previousRouteKeyRef.current = routeKey;
    resetRouteScopedChatState();
    void refreshSessions({ profileName: profile });
  }, [routeKey]);

  useEffect(() => {
    if (previousRequestKeyRef.current === requestKey) return;
    previousRequestKeyRef.current = requestKey;
    void refreshSessions({ profileName: profile, silent: true });
  }, [requestKey]);

  useEffect(() => {
    const pendingSelection = pendingProfileSelectionRef.current;
    if (shouldPreserveProfileSessionSelection(profile, selectedSessionId, pendingSelection)) {
      pendingProfileSelectionRef.current = null;
      setInput("");
      setHistoryErrorsByProfile((current) => ({ ...current, [profile]: null }));
    } else {
      pendingProfileSelectionRef.current = null;
      startNewSession();
    }
    void refreshSessions();
  }, [profile]);

  useEffect(() => {
    // One long-lived consumer per (requestKey, profile). It does NOT rebuild on
    // send (hasActiveRequest is read from a ref), so an in-flight reply is never
    // torn down. SSE is the fast path; polling is the floor while disconnected;
    // reconnect resumes from the applied cursor with capped backoff.
    let closed = false;
    let pollingActive = false;
    let pollTimer: number | null = null;
    let reconnectTimer: number | null = null;
    let reconnectDelay = 500;
    let agentId = "";
    const effectRequestKey = requestKey;

    const pollLoop = async () => {
      if (closed || !pollingActive || !isCurrentRequest(effectRequestKey)) return;
      await pollCoreEvents();
      if (closed || !pollingActive || !isCurrentRequest(effectRequestKey)) return;
      pollTimer = window.setTimeout(pollLoop, hasActiveRequestRef.current ? 400 : 2000);
    };
    const startPolling = () => {
      if (closed || pollingActive || !isCurrentRequest(effectRequestKey)) return;
      pollingActive = true;
      void pollLoop();
    };
    const stopPolling = () => {
      pollingActive = false;
      if (pollTimer !== null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const connect = () => {
      if (closed || !agentId || !isCurrentRequest(effectRequestKey)) return;
      coreEventStreamRef.current = openCoreEventStream(runtimeConfig, {
        after: eventCursorsByProfileRef.current[profile] || 0,
        agentId,
        onEvent: (event) => {
          if (!closed && isCurrentRequest(effectRequestKey)) handleCoreEvents([event]);
        },
        onOpen: () => {
          // Stream is healthy: reset backoff and drop the polling floor.
          reconnectDelay = 500;
          stopPolling();
        },
        onError: () => {
          if (closed) return;
          coreEventStreamRef.current?.close();
          coreEventStreamRef.current = null;
          // Keep events flowing over polling while we retry the stream, resuming
          // from the applied cursor so a reconnect can neither skip nor dup.
          startPolling();
          if (reconnectTimer === null && isCurrentRequest(effectRequestKey)) {
            reconnectTimer = window.setTimeout(() => {
              reconnectTimer = null;
              reconnectDelay = Math.min(reconnectDelay * 2, 5000);
              connect();
            }, reconnectDelay);
          }
        },
      });
    };

    void getIrisCoreAgentForProfile(profile, runtimeConfig)
      .then(async (agentResult) => {
        if (closed || !isCurrentRequest(effectRequestKey) || !agentResult.ok || !agentResult.agent) {
          startPolling();
          return;
        }
        agentId = agentResult.agent.id;
        const bootstrapped = await bootstrapCoreEventCursor(profile, agentId);
        if (closed || !isCurrentRequest(effectRequestKey)) return;
        if (!bootstrapped) {
          startPolling();
          return;
        }
        connect();
      })
      .catch(() => startPolling());

    return () => {
      closed = true;
      stopPolling();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (coreEventStreamRef.current) {
        coreEventStreamRef.current.close();
        coreEventStreamRef.current = null;
      }
    };
  }, [requestKey, profile]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      failTimedOutStreams();
    }, STREAM_SAFETY_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  async function sendMessage(options: SendMessageOptions | MessageAttachment[] = {}) {
    const draftAttachments = Array.isArray(options) ? options : options.attachments || [];
    const modelSelection = Array.isArray(options) ? null : options.modelSelection || null;
    const currentModelSelection = Array.isArray(options) ? null : options.currentModelSelection || null;
    const projectId = Array.isArray(options) ? null : options.projectId || null;
    const prompt = (Array.isArray(options) ? input : options.text ?? input).trim();
    if (!prompt && !draftAttachments.length) return false;
    if (sendInFlightRef.current) return false;
    sendInFlightRef.current = true;
    const previousSessionId = selectedSessionIdRef.current;
    const userMessageId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const optimisticSessionId = previousSessionId ? "" : `optimistic-${userMessageId}`;
    let sessionId = previousSessionId || optimisticSessionId;
    let activeSessionId = sessionId;
    let attachments: MessageAttachment[] = [];
    // Once the send has been handed to Core, a failure (timeout/transport error)
    // is ambiguous — Core may have accepted and a reply may still stream in — so
    // we keep the request pending instead of tearing it down. A failure BEFORE
    // this point (e.g. session create) is definitive and surfaces immediately.
    let sendInitiated = false;
    try {
      attachments = await uploadAttachmentsForSend(draftAttachments, {
        profile,
        messageId: userMessageId,
        sessionId: isCoreSessionId(sessionId) ? sessionId : "",
        runtimeConfig,
      });
    } catch (error) {
      if (error instanceof AttachmentUploadError) {
        if (!Array.isArray(options)) options.onAttachmentUploadError?.(error.attachment);
      }
      setInput(prompt);
      sendInFlightRef.current = false;
      return false;
    }
    const displayedPrompt = prompt;
    const attachmentRefs = attachments.map((attachment) => ({ id: attachment.id }));
    const promptWithAttachments = formatPromptWithAttachments(prompt, attachments);
    const userMessage: Message = {
      id: userMessageId,
      role: "user",
      content: displayedPrompt,
      attachments,
      clientRequestId: userMessageId,
    };
    const assistantMessage: Message = {
      id: assistantId,
      role: "assistant",
      content: ASSISTANT_THINKING_TEXT,
      streaming: true,
      clientRequestId: userMessageId,
    };
    const activeSessionTitle = sessionTitleFromPrompt(promptWithAttachments);
    let coreCreatedSession: HermesSession | null = null;
    let linkedFromSessionId = "";
    let gatewayChatId = previousSessionId ? chatIdForSession(previousSessionId) : "";
    if (!sessionId || activeRequestIdsBySessionRef.current[sessionId]) {
      sendInFlightRef.current = false;
      return false;
    }
    const optimisticTimestamp = Math.floor(Date.now() / 1000);
    pendingTitleResolveRef.current.delete(activeSessionId);
    setMessagesBySession((current) => ({
      ...current,
      [activeSessionId]: [
        ...(current[activeSessionId] || []),
        userMessage,
        assistantMessage,
      ],
    }));
    setSessionChatIdsBySession((current) => ({ ...current, [activeSessionId]: gatewayChatId }));
    activeRequestIdsBySessionRef.current = {
      ...activeRequestIdsBySessionRef.current,
      [activeSessionId]: userMessage.id,
    };
    activeRequestTouchedAtRef.current = {
      ...activeRequestTouchedAtRef.current,
      [userMessage.id]: Date.now(),
    };
    activeSessionTitlesBySessionRef.current = {
      ...activeSessionTitlesBySessionRef.current,
      [activeSessionId]: activeSessionTitle,
    };
    setActiveRequestIdsBySession((current) => ({
      ...current,
      [activeSessionId]: userMessage.id,
    }));
    setInput("");
    if (optimisticSessionId) {
      selectedSessionIdRef.current = optimisticSessionId;
      setSelectedSessionId(optimisticSessionId);
      setSessionsByProfile((current) =>
        upsertSessionForProfile(
          current,
          profile,
          optimisticSessionFromPrompt(
            optimisticSessionId,
            promptWithAttachments,
            optimisticTimestamp,
            optimisticTimestamp,
            gatewayChatId,
            modelSelection?.model || "",
            projectId,
          ),
        ),
      );
      setSessionsLoadedByProfile((current) => ({ ...current, [profile]: true }));
      setHistoryErrorsByProfile((current) => ({ ...current, [profile]: null }));
    }

    try {
      if (!sessionId || !isCoreSessionId(sessionId)) {
        const previousId = sessionId;
        const existingCoreSession = previousId && !isOptimisticSessionId(previousId)
          ? coreSessionForLegacySelection(previousId, gatewayChatId)
          : null;
        const coreSession = existingCoreSession ||
          await createCoreSessionForPrompt(
            promptWithAttachments,
            modelSelection?.model || "",
            projectId,
            previousId && !isOptimisticSessionId(previousId)
              ? {
                  externalChatId: gatewayChatId,
                  externalSessionId: previousId,
                  createdBy: "desktop-legacy-link",
                }
              : undefined,
          );
        if (!coreSession) throw new Error("Iris Core session is unavailable. Message was not sent.");
        coreCreatedSession = coreSession;
        linkedFromSessionId = previousId && previousId !== coreSession.id ? previousId : "";
        sessionId = coreSession.id;
        activeSessionId = sessionId;
        gatewayChatId = coreSession.chatId || gatewayChatId;
        if (linkedFromSessionId) {
          selectedSessionIdRef.current = sessionId;
          setSelectedSessionId(sessionId);
          setMessagesBySession((current) =>
            migrateSessionMessages(current, linkedFromSessionId, sessionId),
          );
          activeRequestIdsBySessionRef.current = migrateActiveRequestId(
            activeRequestIdsBySessionRef.current,
            linkedFromSessionId,
            sessionId,
          );
          activeSessionTitlesBySessionRef.current = migrateSessionValue(
            activeSessionTitlesBySessionRef.current,
            linkedFromSessionId,
            sessionId,
          );
          setActiveRequestIdsBySession((current) =>
            migrateActiveRequestId(current, linkedFromSessionId, sessionId),
          );
          setSessionChatIdsBySession((current) => {
            const next = { ...current, [sessionId]: gatewayChatId };
            delete next[linkedFromSessionId];
            return next;
          });
          setModelSelectionBySession((current) =>
            migrateModelSelection(current, linkedFromSessionId, sessionId),
          );
        }
      }
      if (coreCreatedSession) {
        const localSession = {
          ...coreCreatedSession,
          lastActiveAt: Math.max(coreCreatedSession.lastActiveAt || 0, optimisticTimestamp),
          preview: compactText(promptWithAttachments, 180) || coreCreatedSession.preview,
          messageCount: Math.max(coreCreatedSession.messageCount || 0, 1),
        };
        setSessionsByProfile((current) =>
          upsertSessionForProfile(
            removeSessionForProfile(current, profile, linkedFromSessionId),
            profile,
            localSession,
          ),
        );
        patchSessionsQuery(profile, (current) =>
          upsertSessionForProfile({ [profile]: removeSessionForProfile({ [profile]: current }, profile, linkedFromSessionId)[profile] || [] }, profile, localSession)[profile] || [],
        );
        setSessionsLoadedByProfile((current) => ({ ...current, [profile]: true }));
        setHistoryErrorsByProfile((current) => ({ ...current, [profile]: null }));
      }
      const switchSelection =
        modelSwitchSelectionForSend(modelSelection, currentModelSelection);
      const coreMetadata: CoreMetadata = {};
      if (gatewayChatId) coreMetadata.chatId = gatewayChatId;
      if (projectId) coreMetadata.projectId = projectId;
      if (switchSelection) coreMetadata.modelSwitch = switchSelection;
      sendInitiated = true;
      const result = await sendMessageMutation.mutateAsync({
        sessionId,
        payload: {
          text: displayedPrompt,
          attachments: attachmentRefs,
          model: modelSelection || null,
          clientMessageId: userMessage.id,
          metadata: coreMetadata,
        },
      });
      const canonicalSessionId = result.canonicalSessionId || result.session?.id || result.sessionId || sessionId;
      const acceptedChatId = result.session?.externalChatId ||
        ("runtime" in result ? runtimeChatId(result.runtime) : "") ||
        gatewayChatId;
      const acceptedSession = result.session ? irisCoreSessionToHermes(result.session) : null;
      if (acceptedSession) {
        setSessionsByProfile((current) => {
          const withoutPrevious = canonicalSessionId !== sessionId
            ? removeSessionForProfile(current, profile, sessionId)
            : current;
          return upsertSessionForProfile(withoutPrevious, profile, acceptedSession);
        });
        patchSessionsQuery(profile, (current) => {
          const withoutPrevious = canonicalSessionId !== sessionId
            ? removeSessionForProfile({ [profile]: current }, profile, sessionId)[profile] || []
            : current;
          return upsertSessionForProfile({ [profile]: withoutPrevious }, profile, acceptedSession)[profile] || [];
        });
      }
      if (canonicalSessionId !== sessionId) {
        if (selectedSessionIdRef.current === sessionId) {
          selectedSessionIdRef.current = canonicalSessionId;
          setSelectedSessionId(canonicalSessionId);
        }
        setMessagesBySession((current) =>
          migrateSessionMessages(current, sessionId, canonicalSessionId),
        );
        activeRequestIdsBySessionRef.current = migrateActiveRequestId(
          activeRequestIdsBySessionRef.current,
          sessionId,
          canonicalSessionId,
        );
        activeSessionTitlesBySessionRef.current = migrateSessionValue(
          activeSessionTitlesBySessionRef.current,
          sessionId,
          canonicalSessionId,
        );
        setActiveRequestIdsBySession((current) =>
          migrateActiveRequestId(current, sessionId, canonicalSessionId),
        );
        setModelSelectionBySession((current) =>
          migrateModelSelection(current, sessionId, canonicalSessionId),
        );
        setSessionReadStates((current) =>
          migrateSessionValue(current, sessionId, canonicalSessionId),
        );
        setSessionChatIdsBySession((current) => {
          const migrated = migrateSessionValue(current, sessionId, canonicalSessionId);
          const next = { ...migrated };
          if (acceptedChatId) next[canonicalSessionId] = acceptedChatId;
          sessionChatIdsBySessionRef.current = next;
          return next;
        });
        sessionId = canonicalSessionId;
        activeSessionId = canonicalSessionId;
      }
      if (acceptedChatId) {
        setSessionChatIdsBySession((current) => {
          const next = { ...current, [canonicalSessionId]: acceptedChatId };
          sessionChatIdsBySessionRef.current = next;
          return next;
        });
      }
      if (modelSelection) {
        setModelSelectionBySession((current) => ({ ...current, [canonicalSessionId]: modelSelection }));
      }
      window.setTimeout(() => {
        void pollCoreEvents();
        void refreshSessions({ profileName: profile, silent: true });
        invalidateSessionQueries(profile, canonicalSessionId);
        refreshSessionDetailSoon(canonicalSessionId, profile, acceptedChatId || gatewayChatId);
      }, 1200);
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Iris Core session is not available yet.";
      if (sendInitiated && activeRequestIdsBySessionRef.current[activeSessionId]) {
        // Resilient send: the request reached Core, so a lost/slow send response
        // must not tear down the in-flight reply or fabricate an error over it.
        // Keep the assistant placeholder streaming and let the event stream resolve
        // it (a real snapshot, or a Core-published error event); the safety timeout
        // (D7) is the final backstop. Durable idempotency (C4) makes this safe.
        activeRequestTouchedAtRef.current = {
          ...activeRequestTouchedAtRef.current,
          [userMessageId]: Date.now(),
        };
        return false;
      }
      activeRequestIdsBySessionRef.current = removeActiveRequestIds(
        activeRequestIdsBySessionRef.current,
        activeSessionId,
        sessionId,
      );
      activeSessionTitlesBySessionRef.current = removeSessionValues(
        activeSessionTitlesBySessionRef.current,
        activeSessionId,
        sessionId,
      );
      setActiveRequestIdsBySession((current) =>
        removeActiveRequestIds(current, activeSessionId, sessionId),
      );
      delete activeRequestTouchedAtRef.current[userMessageId];
      updateSessionMessage(activeSessionId, assistantId, (current) => ({
        ...current,
        content: message,
        streaming: false,
      }));
      setInput(prompt);
      return false;
    } finally {
      sendInFlightRef.current = false;
    }
  }

  async function refreshSessions(
    options: {
      silent?: boolean;
      profileName?: string;
      selectSessionId?: string | null;
      transientRetries?: number;
    } = {},
  ) {
    const activeRequestKey = requestKey;
    if (!isCurrentRequest(activeRequestKey)) return;
    const targetProfile = options.profileName || profile;
    if (!options.silent) {
      setSessionsLoadingByProfile((current) => ({ ...current, [targetProfile]: true }));
    }
    try {
      const result = await queryClient.fetchQuery(sessionsQueryOptions(runtimeConfig, targetProfile, 80));
      if (!isCurrentRequest(activeRequestKey)) return;
      if (targetProfile === profile) {
        setHistorySource(result.source || null);
        setHistorySchemaVersion(result.schemaVersion ?? null);
      }
      if (result.ok) {
        const currentProfileSessions = sessionsByProfileRef.current[targetProfile] || [];
        const endpointSessions = preserveActiveSessionTitles(
          preserveLocalSessionProjectMetadata(result.sessions || [], currentProfileSessions),
          currentProfileSessions,
          activeRequestIdsBySessionRef.current,
          activeSessionTitlesBySessionRef.current,
          sessionChatIdsBySessionRef.current,
        );
        setSessionReadStates((current) =>
          mergeSessionReadStates(current, endpointSessions),
        );
        setSessionChatIdsBySession((current) =>
          mergeSessionChatIdMap(current, endpointSessions),
        );
        const currentSelectedSessionId = selectedSessionIdRef.current || selectedSessionId;
        const selectedChatId = currentSelectedSessionId
          ? sessionChatIdsBySessionRef.current[currentSelectedSessionId] ||
            sessionChatIdsBySession[currentSelectedSessionId]
          : "";
        const selectedReplacement = currentSelectedSessionId
          ? replacementForOptimisticSession(
              currentSelectedSessionId,
              endpointSessions,
              currentProfileSessions,
              selectedChatId,
            )
          : null;
        if (
          currentSelectedSessionId &&
          isOptimisticSessionId(currentSelectedSessionId) &&
          selectedReplacement
        ) {
          selectedSessionIdRef.current = selectedReplacement.id;
          setSelectedSessionId(selectedReplacement.id);
          setMessagesBySession((current) =>
            migrateSessionMessages(current, currentSelectedSessionId, selectedReplacement.id),
          );
          setModelSelectionBySession((current) =>
            migrateModelSelection(current, currentSelectedSessionId, selectedReplacement.id),
          );
          activeRequestIdsBySessionRef.current = migrateActiveRequestId(
            activeRequestIdsBySessionRef.current,
            currentSelectedSessionId,
            selectedReplacement.id,
          );
          activeSessionTitlesBySessionRef.current = migrateSessionValue(
            activeSessionTitlesBySessionRef.current,
            currentSelectedSessionId,
            selectedReplacement.id,
          );
          setActiveRequestIdsBySession((current) =>
            migrateActiveRequestId(current, currentSelectedSessionId, selectedReplacement.id),
          );
          setSessionChatIdsBySession((current) => ({
            ...current,
            [selectedReplacement.id]: selectedReplacement.chatId || selectedChatId,
          }));
        }
        const activeReplacements = activeSessionReplacements(
          activeRequestIdsBySessionRef.current,
          endpointSessions,
          currentProfileSessions,
          sessionChatIdsBySessionRef.current,
        );
        if (activeReplacements.length) {
          for (const replacement of activeReplacements) {
            if (selectedSessionIdRef.current === replacement.fromId) {
              selectedSessionIdRef.current = replacement.to.id;
              setSelectedSessionId(replacement.to.id);
            }
            setMessagesBySession((current) =>
              migrateSessionMessages(current, replacement.fromId, replacement.to.id),
            );
            setModelSelectionBySession((current) =>
              migrateModelSelection(current, replacement.fromId, replacement.to.id),
            );
            activeRequestIdsBySessionRef.current = migrateActiveRequestId(
              activeRequestIdsBySessionRef.current,
              replacement.fromId,
              replacement.to.id,
            );
            activeSessionTitlesBySessionRef.current = migrateSessionValue(
              activeSessionTitlesBySessionRef.current,
              replacement.fromId,
              replacement.to.id,
            );
            setActiveRequestIdsBySession((current) =>
              migrateActiveRequestId(current, replacement.fromId, replacement.to.id),
            );
            setSessionChatIdsBySession((current) => ({
              ...current,
              [replacement.to.id]: replacement.to.chatId || replacement.chatId,
            }));
          }
        }
        setSessionsByProfile((current) => ({
          ...current,
          [targetProfile]: mergeOptimisticSessions(
            current[targetProfile] || [],
            endpointSessions,
          ),
        }));
        if (options.selectSessionId && targetProfile === profile) {
          const hasSelectedSession = result.sessions.some(
            (session) => session.id === options.selectSessionId,
          );
          if (hasSelectedSession) setSelectedSessionId(options.selectSessionId);
        }
        setHistoryErrorsByProfile((current) => ({ ...current, [targetProfile]: result.warning || null }));
        setSessionsLoadedByProfile((current) => ({ ...current, [targetProfile]: true }));
      } else {
        if (isTransientSessionLoadError(result.error) && (options.transientRetries ?? 3) > 0) {
          scheduleSessionRetry(targetProfile, options.selectSessionId, options.transientRetries ?? 3);
          return;
        }
        if (isTransientSessionLoadError(result.error)) {
          setHistoryErrorsByProfile((current) => ({ ...current, [targetProfile]: null }));
          return;
        }
        setSessionsByProfile((current) => ({ ...current, [targetProfile]: [] }));
        setHistoryErrorsByProfile((current) => ({
          ...current,
          [targetProfile]: result.error || "Could not load Hermes sessions.",
        }));
        setSessionsLoadedByProfile((current) => ({ ...current, [targetProfile]: true }));
      }
    } catch (error) {
      if (!isCurrentRequest(activeRequestKey)) return;
      const message = error instanceof Error ? error.message : "Could not load Hermes sessions.";
      if (isTransientSessionLoadError(message) && (options.transientRetries ?? 3) > 0) {
        scheduleSessionRetry(targetProfile, options.selectSessionId, options.transientRetries ?? 3);
        return;
      }
      if (isTransientSessionLoadError(message)) {
        setHistoryErrorsByProfile((current) => ({ ...current, [targetProfile]: null }));
        return;
      }
      setSessionsByProfile((current) => ({ ...current, [targetProfile]: [] }));
      setHistoryErrorsByProfile((current) => ({
        ...current,
        [targetProfile]: message,
      }));
      setSessionsLoadedByProfile((current) => ({ ...current, [targetProfile]: true }));
    } finally {
      if (!options.silent && isCurrentRequest(activeRequestKey)) {
        setSessionsLoadingByProfile((current) => ({ ...current, [targetProfile]: false }));
      }
    }
  }

  async function loadSession(sessionId: string, profileName = profile) {
    if (!sessionId) return;
    pendingProfileSelectionRef.current =
      profileName !== profile ? { profile: profileName, sessionId } : null;
    setSelectedSessionId(sessionId);
    markSessionRead(sessionId, { reason: "session-opened" });
    setInput("");
    if (shouldSkipSessionDetailLoad(sessionId, activeRequestIdsBySession)) {
      setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
      return;
    }
    await refreshSessionDetail(sessionId, profileName, { select: true });
  }

  async function renameSession(profileName: string, sessionId: string, title: string) {
    const cleanTitle = title.trim();
    if (!cleanTitle) return "Enter a session name.";
    let result: Awaited<ReturnType<typeof renameSessionMutation.mutateAsync>>;
    try {
      result = await renameSessionMutation.mutateAsync({ profile: profileName, sessionId, title: cleanTitle });
    } catch (error) {
      return error instanceof Error ? error.message : "Could not rename this session.";
    }
    if (!result.session) return "Could not rename this session.";
    setSessionsByProfile((current) =>
      upsertSessionForProfile(current, profileName, result.session),
    );
    patchSessionsQuery(profileName, (current) =>
      upsertSessionForProfile({ [profileName]: current }, profileName, result.session)[profileName] || [],
    );
    setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
    return "Session renamed.";
  }

  async function deleteSession(profileName: string, sessionId: string) {
    if (!sessionId) return "Session was not found.";
    if (activeRequestIdsBySessionRef.current[sessionId]) {
      return "Wait for the active response to finish before deleting this session.";
    }
    try {
      await deleteSessionMutation.mutateAsync({ profile: profileName, sessionId });
    } catch (error) {
      return error instanceof Error ? error.message : "Could not delete this session.";
    }
    const chatId = latestChatIdForSession(sessionId, profileName);
    const relatedSessionIds = sessionIdsForChatId(
      chatId,
      sessionId,
      sessionChatIdsBySessionRef.current,
    );
    const idsToRemove = [sessionId, ...relatedSessionIds];
    setSessionsByProfile((current) =>
      removeSessionsForProfile(current, profileName, idsToRemove),
    );
    patchSessionsQuery(profileName, (current) =>
      removeSessionsForProfile({ [profileName]: current }, profileName, idsToRemove)[profileName] || [],
    );
    setMessagesBySession((current) => removeSessionValues(current, ...idsToRemove));
    setSessionChatIdsBySession((current) => removeSessionValues(current, ...idsToRemove));
    setModelSelectionBySession((current) => removeModelSelections(current, ...idsToRemove));
    setSessionReadStates((current) => removeReadStates(current, ...idsToRemove));
    activeRequestIdsBySessionRef.current = removeActiveRequestIds(
      activeRequestIdsBySessionRef.current,
      ...idsToRemove,
    );
    activeSessionTitlesBySessionRef.current = removeSessionValues(
      activeSessionTitlesBySessionRef.current,
      ...idsToRemove,
    );
    setActiveRequestIdsBySession((current) =>
      removeActiveRequestIds(current, ...idsToRemove),
    );
    if (selectedSessionIdRef.current && idsToRemove.includes(selectedSessionIdRef.current)) {
      startNewSession(profileName);
    }
    setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
    return "Session deleted.";
  }

  async function refreshSessionDetail(
    sessionId: string,
    profileName = profile,
    options: { silent?: boolean; select?: boolean; reconcileActive?: boolean } = {},
  ) {
    if (!sessionId) return false;
    const activeRequestKey = requestKey;
    if (!isCurrentRequest(activeRequestKey)) return false;
    if (
      isOptimisticSessionId(sessionId) ||
      (activeRequestIdsBySessionRef.current[sessionId] && !options.reconcileActive)
    ) {
      setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
      return false;
    }
    if (!options.silent) {
      setSessionsLoadingByProfile((current) => ({ ...current, [profileName]: true }));
    }
    try {
      const result = await queryClient.fetchQuery(sessionDetailQueryOptions(runtimeConfig, profileName, sessionId));
      if (!isCurrentRequest(activeRequestKey)) return false;
      if (profileName === profile) {
        setHistorySource(result.source || null);
        setHistorySchemaVersion(result.schemaVersion ?? null);
      }
      if (!result.ok || !result.session) {
        setHistoryErrorsByProfile((current) => ({
          ...current,
          [profileName]: result.error || "Could not load this session.",
        }));
        return false;
      }
      const loadedSession = result.session;
      const selectedId = selectedSessionIdRef.current;
      const selectedChatId = selectedId ? latestChatIdForSession(selectedId, profileName) : "";
      const selectionStillTargetsThisLoad = shouldApplySessionDetailSelection(
        selectedId,
        selectedChatId,
        sessionId,
        loadedSession,
      );
      const shouldUpdateSelection =
        selectionStillTargetsThisLoad &&
        (options.select ||
          selectedId === sessionId ||
          selectedId === loadedSession.id ||
          Boolean(loadedSession.chatId && selectedChatId === loadedSession.chatId));
      if (shouldUpdateSelection) {
        setSelectedSessionId(loadedSession.id);
      }
      if (loadedSession.chatId) {
        setSessionChatIdsBySession((current) => ({
          ...current,
          [loadedSession.id]: loadedSession.chatId || "",
        }));
      }
      if (sessionMetadataShouldPropagate(loadedSession.title)) {
        setSessionsByProfile((current) => {
          const next = upsertSessionMetadataForProfile(current, profileName, loadedSession);
          sessionsByProfileRef.current = next;
          return next;
        });
      }
      const activeRequestId =
        activeRequestIdsBySessionRef.current[loadedSession.id] ||
        activeRequestIdsBySessionRef.current[sessionId] ||
        "";
      const canReconcileActive = activeRequestCompletedByHistory(result.messages, activeRequestId);
      if (!activeRequestId || canReconcileActive) {
        setMessagesBySession((current) => {
          const localMessages = current[loadedSession.id] || [];
          if (shouldPreserveLocalMessagesOnEmptyHistory(localMessages, result.messages)) {
            return current;
          }
          const historyMessages = preserveLocalScheduledDeliveries(
            toAppMessages(result.messages),
            localMessages,
          );
          // Reconcile keeping the LOCAL transcript's chronological order + identity
          // (it already holds event-only messages like /sethome replies and cron
          // deliveries that never enter Hermes history); history only folds in
          // messages local genuinely lacks. This avoids both the long-chat reorder
          // and the reversed-transcript bug where event-only turns were appended
          // after the history turns.
          const reconciled = reconcileMessages(localMessages, historyMessages);
          return {
            ...current,
            [loadedSession.id]: reconciled,
          };
        });
      }
      if (canReconcileActive) {
        const relatedSessionIds = sessionIdsForChatId(
          loadedSession.chatId || "",
          loadedSession.id,
          sessionChatIdsBySessionRef.current,
        );
        activeRequestIdsBySessionRef.current = removeActiveRequestIds(
          activeRequestIdsBySessionRef.current,
          sessionId,
          loadedSession.id,
          ...relatedSessionIds,
        );
        activeSessionTitlesBySessionRef.current = removeSessionValues(
          activeSessionTitlesBySessionRef.current,
          sessionId,
          loadedSession.id,
          ...relatedSessionIds,
        );
        setActiveRequestIdsBySession((current) =>
          removeActiveRequestIds(current, sessionId, loadedSession.id, ...relatedSessionIds),
        );
        if (activeRequestId) delete activeRequestTouchedAtRef.current[activeRequestId];
      }
      setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: result.warning || null }));
      return true;
    } catch (error) {
      if (!isCurrentRequest(activeRequestKey)) return false;
      setHistoryErrorsByProfile((current) => ({
        ...current,
        [profileName]: error instanceof Error ? error.message : "Could not load this session.",
      }));
      return false;
    } finally {
      if (!options.silent && isCurrentRequest(activeRequestKey)) {
        setSessionsLoadingByProfile((current) => ({ ...current, [profileName]: false }));
      }
    }
  }

  function scheduleSessionTitleResolveSoon(sessionId: string, chatId = "") {
    if (!sessionId || isOptimisticSessionId(sessionId)) return;
    scheduleDedupedTimer({
      key: sessionId,
      pending: pendingTitleResolveRef.current,
      delayMs: SESSION_TITLE_RESOLVE_DELAY_MS,
      run: async () => {
        const targetSessionId = latestRealSessionIdForChatId(chatId, profile) ||
          (isOptimisticSessionId(sessionId) ? "" : sessionId);
        if (!targetSessionId) return;
        await refreshSessionDetail(targetSessionId, profile, {
          silent: true,
          reconcileActive: true,
        });
        const projectId = projectIdForSessionId(targetSessionId) || null;
        onSessionMetadataResolvedRef.current?.(targetSessionId, projectId);
      },
    });
  }

  function refreshSessionDetailSoon(sessionId: string, profileName = profile, chatId = "") {
    window.setTimeout(() => {
      const targetSessionId = latestRealSessionIdForChatId(chatId, profileName) ||
        (isOptimisticSessionId(sessionId) ? "" : sessionId);
      if (targetSessionId) {
        void refreshSessionDetail(targetSessionId, profileName, { silent: true, reconcileActive: true });
      }
    }, 600);
  }

  function startNewSession(profileName = profile) {
    pendingProfileSelectionRef.current = null;
    setSelectedSessionId(null);
    setInput("");
    setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
  }

  function resetRouteScopedChatState() {
    coreEventStreamRef.current?.close();
    coreEventStreamRef.current = null;
    pendingProfileSelectionRef.current = null;
    pendingGatewayDeliveriesRef.current = [];
    pendingUnmappedDeliveryAttemptsRef.current = {};
    eventCursorsByProfileRef.current = {};
    lastAppliedCursorByProfileRef.current = {};
    eventCursorBootstrapKeysRef.current = {};
    eventConsumerStartedAtRef.current = Math.floor(Date.now() / 1000);
    activeRequestIdsBySessionRef.current = {};
    activeRequestTouchedAtRef.current = {};
    activeSessionTitlesBySessionRef.current = {};
    messagesBySessionRef.current = {};
    selectedSessionIdRef.current = null;
    sessionChatIdsBySessionRef.current = {};
    sessionsByProfileRef.current = {};
    sendInFlightRef.current = false;
    pendingTitleResolveRef.current.clear();

    setInput("");
    setMessagesBySession({});
    setActiveRequestIdsBySession({});
    setSessionReadStates({});
    setSessionsByProfile({});
    setSessionsLoadedByProfile({});
    setSelectedSessionId(null);
    setSessionsLoadingByProfile({});
    setHistoryErrorsByProfile({});
    setHistorySource(null);
    setHistorySchemaVersion(null);
    setSessionChatIdsBySession({});
    setModelSelectionBySession({});
  }

  function isCurrentRequest(activeRequestKey: string) {
    return requestKeyRef.current === activeRequestKey;
  }

  async function createCoreSessionForPrompt(
    promptText: string,
    model = "",
    projectId: string | null = null,
    link?: {
      externalChatId?: string;
      externalSessionId?: string;
      createdBy?: string;
    },
  ) {
    try {
      const agentResult = await getIrisCoreAgentForProfile(profile, runtimeConfig);
      if (!agentResult.ok || !agentResult.agent) return null;
      const created = await createIrisCoreSession(
        {
          agentId: agentResult.agent.id,
          title: sessionTitleFromPrompt(promptText),
          externalChatId: link?.externalChatId,
          externalSessionId: link?.externalSessionId,
          projectId,
          metadata: {
            model,
            ...(projectId ? { projectId } : {}),
            ...(link?.createdBy ? { createdBy: link.createdBy } : {}),
          },
        },
        runtimeConfig,
      );
      if (!created.ok || !created.session) return null;
      return {
        id: created.session.id,
        source: "iris-core",
        model,
        title: created.session.title,
        preview: compactText(promptText, 180),
        chatId: created.session.externalChatId,
        origin: created.session.origin || {},
        metadata: created.session.metadata || {},
        startedAt: created.session.createdAt,
        endedAt: null,
        lastActiveAt: created.session.updatedAt,
        messageCount: 1,
      } satisfies HermesSession;
    } catch {
      return null;
    }
  }

  function coreSessionForLegacySelection(sessionId: string, chatId = "") {
    if (!sessionId || isCoreSessionId(sessionId)) return null;
    if (chatId) {
      const byChatId = sessions.find(
        (session) => isCoreSessionId(session.id) && session.chatId === chatId,
      );
      if (byChatId) return byChatId;
    }
    return null;
  }

  function scheduleSessionRetry(
    targetProfile: string,
    selectSessionId: string | null | undefined,
    remainingRetries: number,
  ) {
    window.setTimeout(() => {
      void refreshSessions({
        profileName: targetProfile,
        selectSessionId,
        silent: true,
        transientRetries: remainingRetries - 1,
      });
    }, 1200 * (4 - remainingRetries));
  }

  async function cancelMessage() {
    if (!selectedSessionId || !activeRequestId) return;
    const sessionId = selectedSessionId;
    if (isCoreSessionId(sessionId)) await cancelIrisCoreMessage(sessionId, runtimeConfig);
    activeRequestIdsBySessionRef.current = removeActiveRequestIds(
      activeRequestIdsBySessionRef.current,
      sessionId,
    );
    activeSessionTitlesBySessionRef.current = removeSessionValues(
      activeSessionTitlesBySessionRef.current,
      sessionId,
    );
    delete activeRequestTouchedAtRef.current[activeRequestId];
    setActiveRequestIdsBySession((current) => removeActiveRequestIds(current, sessionId));
  }

  async function pollCoreEvents() {
    const activeRequestKey = requestKey;
    if (!isCurrentRequest(activeRequestKey)) return;
    const agentResult = await getIrisCoreAgentForProfile(profile, runtimeConfig);
    if (!isCurrentRequest(activeRequestKey)) return;
    if (!agentResult.ok || !agentResult.agent) return;
    const bootstrapped = await bootstrapCoreEventCursor(profile, agentResult.agent.id);
    if (!isCurrentRequest(activeRequestKey)) return;
    if (!bootstrapped) return;
    const cursor = eventCursorsByProfileRef.current[profile] || 0;
    const result = await getIrisCoreEvents(cursor, 200, runtimeConfig, agentResult.agent.id);
    if (!isCurrentRequest(activeRequestKey)) return;
    if (!result.ok) return;
    handleCoreEvents(result.events);
  }

  function handleCoreEvents(events: IrisCoreEvent[]) {
    if (!isCurrentRequest(requestKey)) return;
    const maxCursor = events.reduce((current, event) => Math.max(current, event.cursor || 0), 0);
    const deliveries = events
      .filter((event) => event.type.startsWith("message.assistant") || event.type === "message.error")
      .map((event) => irisCoreEventToDeliveryMessage(event, profile));
    if (deliveries.length) {
      handleCoreDeliveries(deliveries);
    }
    // Advance the fetch cursor only after the batch has been handed to state, and
    // past every fetched event (including filtered ones) so we never refetch.
    if (maxCursor > 0) {
      eventCursorsByProfileRef.current = {
        ...eventCursorsByProfileRef.current,
        [profile]: Math.max(eventCursorsByProfileRef.current[profile] || 0, maxCursor),
      };
    }
  }

  async function bootstrapCoreEventCursor(profileName: string, agentId: string) {
    const activeRequestKey = requestKey;
    if (!isCurrentRequest(activeRequestKey)) return false;
    const bootstrapKey = `${coreApiUrl}:${agentId}`;
    if (eventCursorBootstrapKeysRef.current[profileName] === bootstrapKey) return true;
    const result = await getIrisCoreLatestEventCursor(runtimeConfig, agentId);
    if (!isCurrentRequest(activeRequestKey)) return false;
    if (!result.ok) return false;
    const latestCursor = result.cursor || 0;
    eventCursorsByProfileRef.current = {
      ...eventCursorsByProfileRef.current,
      [profileName]: Math.max(eventCursorsByProfileRef.current[profileName] || 0, latestCursor),
    };
    // Treat everything up to the bootstrap cursor as already applied so pre-connect
    // events are skipped by the high-water dedupe instead of replayed.
    lastAppliedCursorByProfileRef.current = {
      ...lastAppliedCursorByProfileRef.current,
      [profileName]: Math.max(lastAppliedCursorByProfileRef.current[profileName] || 0, latestCursor),
    };
    eventCursorBootstrapKeysRef.current = {
      ...eventCursorBootstrapKeysRef.current,
      [profileName]: bootstrapKey,
    };
    return true;
  }

  function projectIdForSessionId(sessionId: string) {
    const profileSessions = sessionsByProfileRef.current[profile] || [];
    const matched = profileSessions.find((session) => session.id === sessionId);
    const metadata = matched?.metadata || {};
    const direct = typeof metadata.projectId === "string" ? metadata.projectId : "";
    if (direct) return direct;
    const project = metadata.project;
    if (project && typeof project === "object" && !Array.isArray(project)) {
      const id = (project as Record<string, unknown>).id;
      if (typeof id === "string") return id;
    }
    return "";
  }

  function handleCoreDeliveries(newDeliveries: HermesInboxMessage[]) {
    const deliveries = dedupeInboxDeliveries([
      ...pendingGatewayDeliveriesRef.current,
      ...newDeliveries,
    ]);
    if (!deliveries.length) return;

    const remaining: HermesInboxMessage[] = [];
    let handledDelivery = false;
    let unmappedDelivery = false;
    const appliedHighWater = lastAppliedCursorByProfileRef.current[profile] || 0;
    // Deliveries already queued for retry must still be reattempted even if a
    // later cursor advanced the high-water past them.
    const pendingRetryIds = new Set(pendingGatewayDeliveriesRef.current.map((delivery) => delivery.id));
    let maxAppliedCursor = appliedHighWater;
    const markApplied = (delivery: HermesInboxMessage) => {
      maxAppliedCursor = Math.max(maxAppliedCursor, delivery.cursor || 0);
    };

    for (const delivery of deliveries) {
      if (
        delivery.cursor > 0 &&
        delivery.cursor <= appliedHighWater &&
        !pendingRetryIds.has(delivery.id)
      ) {
        // Already committed (e.g. the same snapshot from both SSE and polling).
        continue;
      }
      if (delivery.profile && delivery.profile !== profile) {
        remaining.push(delivery);
        continue;
      }
      const replyTo = stringMetadata(delivery.metadata, "replyTo") || stringMetadata(delivery.metadata, "reply_to");
      const hidden = isHiddenDeliveryMetadata(delivery.metadata);
      if (hidden) {
        markApplied(delivery);
        handledDelivery = true;
        continue;
      }
      const streamMessageId = stringMetadata(delivery.metadata, "streamMessageId") ||
        stringMetadata(delivery.metadata, "stream_message_id");
      const clientRequestId = stringMetadata(delivery.metadata, "clientRequestId") ||
        stringMetadata(delivery.metadata, "client_request_id");
      const deliveryClientRequestId = resolveDeliveryClientRequestId(
        clientRequestId,
        replyTo,
        Boolean(replyTo && sessionIdForActiveRequest(replyTo)),
      );
      if (deliveryClientRequestId) {
        activeRequestTouchedAtRef.current = {
          ...activeRequestTouchedAtRef.current,
          [deliveryClientRequestId]: Date.now(),
        };
      }
      const isErrorDelivery = stringMetadata(delivery.metadata, "eventType") === "message.assistant.error" ||
        delivery.source === "hermes-error" ||
        Boolean(delivery.metadata?.error);
      const isStreamDelivery = Boolean(streamMessageId);
      const isFinalStreamDelivery = isStreamDelivery && streamDeliveryFinalized(delivery.metadata);
      const isToolProgress = !isStreamDelivery &&
        (delivery.source === "hermes-tool-progress" ||
          stringMetadata(delivery.metadata, "source") === "hermes-tool-progress" ||
          booleanMetadata(delivery.metadata, "toolProgress") === true);
      const sessionId =
        sessionIdForActiveRequest(deliveryClientRequestId) ||
        (delivery.source === "hermes-cron" ? "" : sessionIdForActiveRequest(replyTo)) ||
        sessionIdForChatId(delivery.chatId);
      if (!sessionId) {
        if (markUnmappedDeliveryForRetry(delivery.id)) {
          remaining.push(delivery);
          unmappedDelivery = true;
        } else {
          markApplied(delivery);
          delete pendingUnmappedDeliveryAttemptsRef.current[delivery.id];
        }
        continue;
      }
      const relatedSessionIds = sessionIdsForChatId(
        delivery.chatId,
        sessionId,
        sessionChatIdsBySessionRef.current,
      );
      // D7: any cursor advance for an active session keeps its safety timeout
      // fresh, even if this delivery wasn't clientRequestId-matched (e.g. an
      // uncorrelated snapshot or a delta for a concurrent turn on the chat). A
      // healthy stream is never marked timed-out.
      for (const relatedSessionId of relatedSessionIds) {
        const activeId = activeRequestIdsBySessionRef.current[relatedSessionId];
        if (activeId) {
          activeRequestTouchedAtRef.current = {
            ...activeRequestTouchedAtRef.current,
            [activeId]: Date.now(),
          };
        }
      }
      const existingBeforeMerge = mergeRelatedSessionMessages(
        messagesBySessionRef.current,
        relatedSessionIds,
      );
      const completesActiveStream = !isStreamDelivery && !isToolProgress &&
        (
          deliveryCompletesActiveStream(existingBeforeMerge, delivery) ||
          Boolean(deliveryClientRequestId && existingBeforeMerge.some(
            (message) => message.role === "assistant" && message.clientRequestId === deliveryClientRequestId,
          ))
        );

      handledDelivery = true;
      markApplied(delivery);
      delete pendingUnmappedDeliveryAttemptsRef.current[delivery.id];
      if (isToolProgress) {
        // Tool-progress deliveries append a standalone tool card in execution order
        // (interleaving with the round's text) without touching any text content and
        // without completing the turn — so they skip the stream-completion /
        // active-request-clearing logic below.
        setMessagesBySession((current) => {
          const freshRelatedSessionIds = sessionIdsForChatId(
            delivery.chatId,
            sessionId,
            sessionChatIdsBySessionRef.current,
          );
          const existing = mergeRelatedSessionMessages(current, freshRelatedSessionIds);
          const nextMessages = mergeToolProgressDelivery(existing, delivery);
          return setSessionMessages(current, freshRelatedSessionIds, sessionId, nextMessages);
        });
        continue;
      }
      let postMergeMessages: Message[] | null = null;
      setMessagesBySession((current) => {
        const freshRelatedSessionIds = sessionIdsForChatId(
          delivery.chatId,
          sessionId,
          sessionChatIdsBySessionRef.current,
        );
        const existing = mergeRelatedSessionMessages(
          current,
          freshRelatedSessionIds,
        );
        if (!isStreamDelivery && existing.some((message) => message.id === delivery.id)) {
          postMergeMessages = existing;
          return current;
        }
        const merged = isErrorDelivery
          ? mergeErrorDelivery(existing, delivery, deliveryClientRequestId)
          : isStreamDelivery
            ? mergeStreamDelivery(existing, delivery, streamMessageId, isFinalStreamDelivery, deliveryClientRequestId)
            : mergeCompletedDelivery(existing, delivery, replyTo, deliveryClientRequestId);
        // A terminal delivery (final stream chunk, completed, or error) settles the
        // turn, so flip any still-running standalone tool cards to completed. In a
        // multi-round turn each round's stream finalize settles that round's card; the
        // final delivery settles any remainder.
        const nextMessages =
          isFinalStreamDelivery || isErrorDelivery || !isStreamDelivery
            ? completeRunningToolCards(merged)
            : merged;
        postMergeMessages = nextMessages;
        return setSessionMessages(current, freshRelatedSessionIds, sessionId, nextMessages);
      });
      const sessionStillStreaming = postMergeMessages
        ? (postMergeMessages as Message[]).some(
            (message) => message.role === "assistant" && message.streaming === true,
          )
        : true;
      const shouldClearActive =
        isErrorDelivery ||
        (deliveryClientRequestId && (!isStreamDelivery || isFinalStreamDelivery)) ||
        isFinalStreamDelivery ||
        completesActiveStream ||
        (postMergeMessages !== null && !sessionStillStreaming);
      if (shouldClearActive) {
        const clearedRequestIds = relatedSessionIds
          .map((relatedSessionId) => activeRequestIdsBySessionRef.current[relatedSessionId])
          .filter(Boolean);
        activeRequestIdsBySessionRef.current = removeActiveRequestIds(
          activeRequestIdsBySessionRef.current,
          ...relatedSessionIds,
        );
        activeSessionTitlesBySessionRef.current = removeSessionValues(
          activeSessionTitlesBySessionRef.current,
          ...relatedSessionIds,
        );
        setActiveRequestIdsBySession((current) =>
          removeActiveRequestIds(current, ...relatedSessionIds),
        );
        for (const requestId of clearedRequestIds) {
          delete activeRequestTouchedAtRef.current[requestId];
        }
      }
      if (!isStreamDelivery || isFinalStreamDelivery) {
        if (shouldApplyDeliveryReadState(delivery, eventConsumerStartedAtRef.current)) {
          markDeliveredSessionReadState(relatedSessionIds, delivery.cursor);
        }
        invalidateSessionQueries(profile, sessionId);
        // No mid-stream refetch+replace: the Core-assembled snapshot is canonical
        // for the active turn. Title/project metadata is resolved here; it runs the
        // single idempotent post-completion reconcile (merge by clientRequestId,
        // never a blind body replace) once the stream has finalized.
        scheduleSessionTitleResolveSoon(sessionId, delivery.chatId);
      }
    }

    pendingGatewayDeliveriesRef.current = remaining.slice(-100);
    if (maxAppliedCursor > appliedHighWater) {
      lastAppliedCursorByProfileRef.current = {
        ...lastAppliedCursorByProfileRef.current,
        [profile]: maxAppliedCursor,
      };
    }
    if (handledDelivery || unmappedDelivery) {
      void refreshSessions({ profileName: profile, silent: true });
    }
  }

  function failTimedOutStreams() {
    const nowMs = Date.now();
    const timedOut = Object.entries(activeRequestIdsBySessionRef.current).filter(([_sessionId, requestId]) => {
      const touchedAt = activeRequestTouchedAtRef.current[requestId] || 0;
      return touchedAt > 0 && nowMs - touchedAt >= STREAM_SAFETY_TIMEOUT_MS;
    });
    if (!timedOut.length) return;

    setMessagesBySession((current) => {
      let next = current;
      for (const [sessionId, requestId] of timedOut) {
        const existing = next[sessionId] || [];
        // Honest finalize: the safety timeout fires only after the touch went stale
        // (no cursor progress for the whole window, see D7). If real content already
        // streamed in, keep it and just stop the spinner — never overwrite a good
        // partial reply with a fabricated error. Only show the stalled-stream error
        // when nothing but the "Thinking…" placeholder ever arrived.
        const hasStreamedContent = existing.some(
          (message) =>
            message.role === "assistant" &&
            message.clientRequestId === requestId &&
            Boolean(message.content) &&
            !isAssistantThinkingPlaceholder(message.content),
        );
        if (hasStreamedContent) {
          next = {
            ...next,
            [sessionId]: existing.map((message) =>
              message.role === "assistant" && message.clientRequestId === requestId && message.streaming
                ? { ...message, streaming: false }
                : message,
            ),
          };
          continue;
        }
        const timeoutDelivery: HermesInboxMessage = {
          id: `iris-stream-timeout-${requestId}`,
          cursor: 0,
          source: "iris-stream-timeout",
          platform: "iris",
          profile,
          chatId: latestChatIdForSession(sessionId),
          content: STREAM_SAFETY_TIMEOUT_MESSAGE,
          metadata: {
            clientRequestId: requestId,
            error: STREAM_SAFETY_TIMEOUT_MESSAGE,
          },
          createdAt: Math.floor(nowMs / 1000),
          acknowledgedAt: null,
        };
        next = {
          ...next,
          [sessionId]: mergeErrorDelivery(existing, timeoutDelivery, requestId),
        };
      }
      return next;
    });

    activeRequestIdsBySessionRef.current = removeActiveRequestIds(
      activeRequestIdsBySessionRef.current,
      ...timedOut.map(([sessionId]) => sessionId),
    );
    activeSessionTitlesBySessionRef.current = removeSessionValues(
      activeSessionTitlesBySessionRef.current,
      ...timedOut.map(([sessionId]) => sessionId),
    );
    setActiveRequestIdsBySession((current) =>
      removeActiveRequestIds(current, ...timedOut.map(([sessionId]) => sessionId)),
    );
    for (const [, requestId] of timedOut) {
      delete activeRequestTouchedAtRef.current[requestId];
    }
  }

  function chatIdForSession(sessionId: string | null | undefined) {
    if (!sessionId) return "";
    return (
      sessionChatIdsBySession[sessionId] ||
      sessions.find((session) => session.id === sessionId)?.chatId ||
      ""
    );
  }

  function sessionIdForChatId(chatId: string) {
    if (!chatId) return "";
    const selectedId = selectedSessionIdRef.current;
    if (selectedId && latestChatIdForSession(selectedId) === chatId) {
      return selectedId;
    }
    const profileSessions = sessionsByProfileRef.current[profile] || [];
    const realSession = profileSessions.find(
      (session) => !isOptimisticSession(session) && session.chatId === chatId,
    );
    if (realSession) return realSession.id;
    for (const [sessionId, mappedChatId] of Object.entries(sessionChatIdsBySessionRef.current)) {
      if (mappedChatId === chatId && !isOptimisticSessionId(sessionId)) return sessionId;
    }
    for (const [sessionId, mappedChatId] of Object.entries(sessionChatIdsBySessionRef.current)) {
      if (mappedChatId === chatId) return sessionId;
    }
    return profileSessions.find((session) => session.chatId === chatId)?.id || "";
  }

  function sessionIdForActiveRequest(requestId: string) {
    if (!requestId) return "";
    for (const [sessionId, activeId] of Object.entries(activeRequestIdsBySessionRef.current)) {
      if (activeId === requestId) return sessionId;
    }
    return "";
  }

  function markUnmappedDeliveryForRetry(deliveryId: string) {
    const attempts = pendingUnmappedDeliveryAttemptsRef.current[deliveryId] || 0;
    if (!shouldRetryUnmappedDelivery(attempts)) return false;
    pendingUnmappedDeliveryAttemptsRef.current = {
      ...pendingUnmappedDeliveryAttemptsRef.current,
      [deliveryId]: attempts + 1,
    };
    return true;
  }

  function latestChatIdForSession(sessionId: string, profileName = profile) {
    return (
      sessionChatIdsBySessionRef.current[sessionId] ||
      (sessionsByProfileRef.current[profileName] || [])
        .find((session) => session.id === sessionId)?.chatId ||
      ""
    );
  }

  function latestRealSessionIdForChatId(chatId: string, profileName = profile) {
    if (!chatId) return "";
    const realSession = (sessionsByProfileRef.current[profileName] || []).find(
      (session) => !isOptimisticSession(session) && session.chatId === chatId,
    );
    if (realSession) return realSession.id;
    for (const [sessionId, mappedChatId] of Object.entries(sessionChatIdsBySessionRef.current)) {
      if (mappedChatId === chatId && !isOptimisticSessionId(sessionId)) return sessionId;
    }
    return "";
  }

  function updateSessionMessage(
    sessionId: string,
    messageId: string,
    updater: (message: Message) => Message,
  ) {
    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: (current[sessionId] || []).map((message) =>
        message.id === messageId ? updater(message) : message,
      ),
    }));
  }

  function markDeliveredSessionReadState(sessionIds: string[], eventCursor: number) {
    const selectedId = selectedSessionIdRef.current;
    const visible = Boolean(isChatViewActiveRef.current && selectedId && sessionIds.includes(selectedId));
    if (!visible) return;
    for (const sessionId of sessionIds) {
      markSessionReadState(sessionId, "read", {
        reason: "active-delivery",
        eventCursor,
      });
    }
  }

  function markSessionRead(sessionId: string, metadata: CoreMetadata = {}) {
    markSessionReadState(sessionId, "read", metadata);
  }

  function markSessionReadState(
    sessionId: string,
    state: "read" | "unread",
    metadata: CoreMetadata = {},
  ) {
    if (!isCoreSessionId(sessionId)) return;
    setSessionReadStates((current) => ({ ...current, [sessionId]: state }));
    setSessionsByProfile((current) =>
      updateSessionReadStateForProfiles(current, sessionId, state),
    );
    void updateIrisCoreSessionReadState(sessionId, state, runtimeConfig, metadata);
  }

  return {
    activeRequestId,
    activeSessionIds,
    cancelMessage,
    sessions,
    sessionsByProfile,
    sessionReadStates,
    sessionsLoadedByProfile,
    sessionsLoading,
    sessionsLoadingByProfile,
    historyError,
    historyErrorsByProfile,
    historySchemaVersion,
    historySource,
    input,
    deleteSession,
    loadSession,
    messages,
    renameSession,
    selectedModelSelection,
    requestActive: Boolean(activeRequestId),
    refreshSessions,
    selectedSessionId,
    sendMessage,
    setInput,
    startNewSession,
  };
}
