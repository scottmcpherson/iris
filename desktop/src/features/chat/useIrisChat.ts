import { useEffect, useMemo, useRef, useState } from "react";
import type { Message, MessageAttachment } from "../../app/types";
import {
  coreEventToInboxMessage,
  deleteIrisConversation,
  getIrisConversationDetail,
  getIrisConversations,
  renameIrisConversation,
} from "../../lib/irisRuntime";
import {
  agentUICoreEventStreamUrl,
  cancelAgentUICoreMessage,
  createAgentUICoreConversation,
  getAgentUICoreEvents,
  getAgentUICoreAgentForProfile,
  sendAgentUICoreMessage,
  updateAgentUICoreConversationReadState,
  type AgentUICoreEvent,
  type CoreMetadata,
} from "../../lib/agentuiCore";
import type {
  HermesConversation,
  HermesInboxMessage,
  HermesModelSelection,
  HermesRuntimeConfig,
} from "../../types/hermes";
import { compactText } from "../../shared/strings";
import { AttachmentUploadError, formatPromptWithAttachments, uploadAttachmentsForSend } from "./chatAttachments";
import type { PendingProfileConversationSelection, SendMessageOptions } from "./chatTypes";
import {
  isHiddenDeliveryMetadata,
  stringMetadata,
  toAppMessages,
} from "./chatHistory";
import {
  deliveryCompletesActiveStream,
  mergeCompletedDelivery,
  mergeStreamDelivery,
} from "./chatStreamMerging";
import {
  activeConversationReplacements,
  activeRequestCompletedByHistory,
  conversationIdsForChatId,
  conversationTitleFromPrompt,
  isCoreConversationId,
  isOptimisticConversation,
  isOptimisticConversationId,
  isTransientConversationLoadError,
  mergeConversationChatIdMap,
  mergeConversationReadStates,
  mergeOptimisticConversations,
  mergeRelatedConversationMessages,
  migrateActiveRequestId,
  migrateConversationMessages,
  migrateConversationValue,
  migrateModelSelection,
  optimisticConversationFromPrompt,
  preserveActiveConversationTitles,
  preserveLocalConversationProjectMetadata,
  preserveLocalScheduledDeliveries,
  removeActiveRequestIds,
  removeConversationForProfile,
  removeConversationsForProfile,
  removeConversationValues,
  removeModelSelections,
  removeReadStates,
  replacementForOptimisticConversation,
  selectionFromConversation,
  setConversationMessages,
  shouldApplyConversationDetailSelection,
  shouldPreserveLocalMessagesOnEmptyHistory,
  shouldPreserveProfileConversationSelection,
  shouldRetryUnmappedDelivery,
  shouldSendModelSwitch,
  shouldSkipConversationDetailLoad,
  updateConversationReadStateForProfiles,
  upsertConversationForProfile,
  visibleConversationForSelection,
} from "./chatConversationState";
import {
  dedupeInboxDeliveries,
  parseCoreEvent,
  runtimeChatId,
  streamDeliveryFinalized,
} from "./chatCoreEvents";

export { isHiddenDeliveryMetadata, stripModelSwitchNote, toAppMessages } from "./chatHistory";
export {
  coalescePostStreamAttachments,
  deliveryCompletesActiveStream,
  mergeCompletedDelivery,
  mergeMessageLists,
  mergeStreamDelivery,
} from "./chatStreamMerging";
export { mergeUploadedAttachment } from "./chatAttachments";
export {
  activeConversationReplacements,
  activeRequestCompletedByHistory,
  isTransientConversationLoadError,
  mergeConversationChatIdMap,
  mergeConversationReadStates,
  preserveActiveConversationTitles,
  preserveLocalConversationProjectMetadata,
  preserveLocalScheduledDeliveries,
  shouldApplyConversationDetailSelection,
  shouldPreserveLocalMessagesOnEmptyHistory,
  shouldPreserveProfileConversationSelection,
  shouldRetryUnmappedDelivery,
  shouldSendModelSwitch,
  shouldSkipConversationDetailLoad,
} from "./chatConversationState";
export type { SendableAttachment } from "./chatTypes";

type UseIrisChatOptions = {
  profile: string;
  runtimeConfig: HermesRuntimeConfig;
  isChatViewActive?: boolean;
};

const coreDeliveryEventNames = [
  "message.assistant.delta",
  "message.assistant.completed",
  "message.error",
];

export function useAgentUIChat({ profile, runtimeConfig, isChatViewActive = true }: UseIrisChatOptions) {
  const [input, setInput] = useState("");
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, Message[]>>({});
  const [activeRequestIdsByConversation, setActiveRequestIdsByConversation] = useState<Record<string, string>>({});
  const [conversationReadStates, setConversationReadStates] = useState<Record<string, "read" | "unread">>({});
  const [conversationsByProfile, setConversationsByProfile] = useState<Record<string, HermesConversation[]>>({});
  const [conversationsLoadedByProfile, setConversationsLoadedByProfile] = useState<Record<string, boolean>>({});
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [conversationsLoadingByProfile, setConversationsLoadingByProfile] = useState<Record<string, boolean>>({});
  const [historyErrorsByProfile, setHistoryErrorsByProfile] = useState<Record<string, string | null>>({});
  const [historySource, setHistorySource] = useState<string | null>(null);
  const [historySchemaVersion, setHistorySchemaVersion] = useState<number | null>(null);
  const [conversationChatIdsByConversation, setConversationChatIdsByConversation] = useState<Record<string, string>>({});
  const [modelSelectionByConversation, setModelSelectionByConversation] = useState<Record<string, HermesModelSelection>>({});
  const eventCursorsByProfileRef = useRef<Record<string, number>>({});
  const processedInboxEventIdsRef = useRef<Set<string>>(new Set());
  const pendingGatewayDeliveriesRef = useRef<HermesInboxMessage[]>([]);
  const pendingUnmappedDeliveryAttemptsRef = useRef<Record<string, number>>({});
  const pendingProfileSelectionRef = useRef<PendingProfileConversationSelection | null>(null);
  const coreEventSourceRef = useRef<EventSource | null>(null);
  const activeDetailReconcileAtRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const messagesByConversationRef = useRef(messagesByConversation);
  const activeRequestIdsByConversationRef = useRef(activeRequestIdsByConversation);
  const activeConversationTitlesByConversationRef = useRef<Record<string, string>>({});
  const selectedConversationIdRef = useRef(selectedConversationId);
  const isChatViewActiveRef = useRef(isChatViewActive);
  const conversationChatIdsByConversationRef = useRef(conversationChatIdsByConversation);
  const conversationsByProfileRef = useRef(conversationsByProfile);
  const conversations = conversationsByProfile[profile] || [];
  const conversationsLoading = Boolean(conversationsLoadingByProfile[profile]);
  const historyError = historyErrorsByProfile[profile] || null;
  const visibleConversationId = visibleConversationForSelection(
    selectedConversationId,
    conversations,
    conversationChatIdsByConversation,
    messagesByConversation,
  );
  const messages = visibleConversationId ? messagesByConversation[visibleConversationId] || [] : [];
  const activeRequestId = visibleConversationId
    ? activeRequestIdsByConversation[visibleConversationId] || null
    : null;
  const activeConversationIds = useMemo(
    () => Object.keys(activeRequestIdsByConversation),
    [activeRequestIdsByConversation],
  );
  const hasActiveRequest = activeConversationIds.length > 0;
  const selectedConversation = visibleConversationId
    ? conversations.find((conversation) => conversation.id === visibleConversationId) || null
    : null;
  const selectedModelSelection = visibleConversationId
    ? modelSelectionByConversation[visibleConversationId] || selectionFromConversation(selectedConversation)
    : null;

  messagesByConversationRef.current = messagesByConversation;
  activeRequestIdsByConversationRef.current = activeRequestIdsByConversation;
  selectedConversationIdRef.current = selectedConversationId;
  isChatViewActiveRef.current = isChatViewActive;
  conversationChatIdsByConversationRef.current = conversationChatIdsByConversation;
  conversationsByProfileRef.current = conversationsByProfile;

  useEffect(() => {
    if (!isChatViewActive || !selectedConversationId) return;
    markConversationRead(selectedConversationId, { reason: "active-selection" });
  }, [isChatViewActive, selectedConversationId]);

  useEffect(() => {
    const pendingSelection = pendingProfileSelectionRef.current;
    if (shouldPreserveProfileConversationSelection(profile, selectedConversationId, pendingSelection)) {
      pendingProfileSelectionRef.current = null;
      setInput("");
      setHistoryErrorsByProfile((current) => ({ ...current, [profile]: null }));
    } else {
      pendingProfileSelectionRef.current = null;
      startNewConversation();
    }
    void refreshConversations();
  }, [profile]);

  useEffect(() => {
    let closed = false;
    let fallbackTimer: number | null = null;
    const startPollingFallback = () => {
      if (closed || fallbackTimer !== null) return;
      void pollCoreEvents();
      fallbackTimer = window.setInterval(() => {
        void pollCoreEvents();
      }, hasActiveRequest ? 400 : 2000);
    };

    void getAgentUICoreAgentForProfile(profile, runtimeConfig)
      .then((agentResult) => {
        if (closed || !agentResult.ok || !agentResult.agent) {
          startPollingFallback();
          return;
        }
        const cursor = eventCursorsByProfileRef.current[profile] || 0;
        const source = new EventSource(
          agentUICoreEventStreamUrl(runtimeConfig, cursor, 200, agentResult.agent.id),
        );
        coreEventSourceRef.current = source;
        const onCoreEvent = (event: MessageEvent<string>) => {
          const parsed = parseCoreEvent(event.data);
          if (parsed) handleCoreEvents([parsed]);
        };
        for (const eventName of coreDeliveryEventNames) {
          source.addEventListener(eventName, onCoreEvent as EventListener);
        }
        source.onerror = () => {
          source.close();
          if (coreEventSourceRef.current === source) coreEventSourceRef.current = null;
          startPollingFallback();
        };
      })
      .catch(startPollingFallback);

    return () => {
      closed = true;
      if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
      if (coreEventSourceRef.current) {
        coreEventSourceRef.current.close();
        coreEventSourceRef.current = null;
      }
    };
  }, [runtimeConfig.coreApiUrl, profile, hasActiveRequest]);

  async function sendMessage(options: SendMessageOptions | MessageAttachment[] = {}) {
    const draftAttachments = Array.isArray(options) ? options : options.attachments || [];
    const modelSelection = Array.isArray(options) ? null : options.modelSelection || null;
    const currentModelSelection = Array.isArray(options) ? null : options.currentModelSelection || null;
    const projectId = Array.isArray(options) ? null : options.projectId || null;
    const prompt = (Array.isArray(options) ? input : options.text ?? input).trim();
    if (!prompt && !draftAttachments.length) return false;
    if (sendInFlightRef.current) return false;
    sendInFlightRef.current = true;
    const previousConversationId = selectedConversationIdRef.current;
    const userMessageId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const optimisticConversationId = previousConversationId ? "" : `optimistic-${userMessageId}`;
    let conversationId = previousConversationId || optimisticConversationId;
    let activeConversationId = conversationId;
    let attachments: MessageAttachment[] = [];
    try {
      attachments = await uploadAttachmentsForSend(draftAttachments, {
        profile,
        messageId: userMessageId,
        conversationId: isCoreConversationId(conversationId) ? conversationId : "",
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
    };
    const assistantMessage: Message = {
      id: assistantId,
      role: "assistant",
      content: "Thinking...",
      streaming: true,
    };
    const activeConversationTitle = conversationTitleFromPrompt(promptWithAttachments);
    let coreCreatedConversation: HermesConversation | null = null;
    let linkedFromConversationId = "";
    let gatewayChatId = previousConversationId ? chatIdForConversation(previousConversationId) : "";
    if (!conversationId || activeRequestIdsByConversationRef.current[conversationId]) {
      sendInFlightRef.current = false;
      return false;
    }
    const optimisticTimestamp = Math.floor(Date.now() / 1000);
    setMessagesByConversation((current) => ({
      ...current,
      [activeConversationId]: [
        ...(current[activeConversationId] || []),
        userMessage,
        assistantMessage,
      ],
    }));
    setConversationChatIdsByConversation((current) => ({ ...current, [activeConversationId]: gatewayChatId }));
    activeRequestIdsByConversationRef.current = {
      ...activeRequestIdsByConversationRef.current,
      [activeConversationId]: userMessage.id,
    };
    activeConversationTitlesByConversationRef.current = {
      ...activeConversationTitlesByConversationRef.current,
      [activeConversationId]: activeConversationTitle,
    };
    setActiveRequestIdsByConversation((current) => ({
      ...current,
      [activeConversationId]: userMessage.id,
    }));
    setInput("");
    if (optimisticConversationId) {
      selectedConversationIdRef.current = optimisticConversationId;
      setSelectedConversationId(optimisticConversationId);
      setConversationsByProfile((current) =>
        upsertConversationForProfile(
          current,
          profile,
          optimisticConversationFromPrompt(
            optimisticConversationId,
            promptWithAttachments,
            optimisticTimestamp,
            optimisticTimestamp,
            gatewayChatId,
            modelSelection?.model || "",
            projectId,
          ),
        ),
      );
      setConversationsLoadedByProfile((current) => ({ ...current, [profile]: true }));
      setHistoryErrorsByProfile((current) => ({ ...current, [profile]: null }));
    }

    try {
      if (!conversationId || !isCoreConversationId(conversationId)) {
        const previousId = conversationId;
        const existingCoreConversation = previousId && !isOptimisticConversationId(previousId)
          ? coreConversationForLegacySelection(previousId, gatewayChatId)
          : null;
        const coreConversation = existingCoreConversation ||
          await createCoreConversationForPrompt(
            promptWithAttachments,
            modelSelection?.model || "",
            projectId,
            previousId && !isOptimisticConversationId(previousId)
              ? {
                  externalChatId: gatewayChatId,
                  externalSessionId: previousId,
                  createdBy: "desktop-legacy-link",
                }
              : undefined,
          );
        if (!coreConversation) throw new Error("Iris Core session is unavailable. Message was not sent.");
        coreCreatedConversation = coreConversation;
        linkedFromConversationId = previousId && previousId !== coreConversation.id ? previousId : "";
        conversationId = coreConversation.id;
        activeConversationId = conversationId;
        gatewayChatId = coreConversation.chatId || gatewayChatId;
        if (linkedFromConversationId) {
          selectedConversationIdRef.current = conversationId;
          setSelectedConversationId(conversationId);
          setMessagesByConversation((current) =>
            migrateConversationMessages(current, linkedFromConversationId, conversationId),
          );
          activeRequestIdsByConversationRef.current = migrateActiveRequestId(
            activeRequestIdsByConversationRef.current,
            linkedFromConversationId,
            conversationId,
          );
          activeConversationTitlesByConversationRef.current = migrateConversationValue(
            activeConversationTitlesByConversationRef.current,
            linkedFromConversationId,
            conversationId,
          );
          setActiveRequestIdsByConversation((current) =>
            migrateActiveRequestId(current, linkedFromConversationId, conversationId),
          );
          setConversationChatIdsByConversation((current) => {
            const next = { ...current, [conversationId]: gatewayChatId };
            delete next[linkedFromConversationId];
            return next;
          });
          setModelSelectionByConversation((current) =>
            migrateModelSelection(current, linkedFromConversationId, conversationId),
          );
        }
      }
      if (coreCreatedConversation) {
        const localConversation = {
          ...coreCreatedConversation,
          lastActiveAt: Math.max(coreCreatedConversation.lastActiveAt || 0, optimisticTimestamp),
          preview: compactText(promptWithAttachments, 180) || coreCreatedConversation.preview,
          messageCount: Math.max(coreCreatedConversation.messageCount || 0, 1),
        };
        setConversationsByProfile((current) =>
          upsertConversationForProfile(
            removeConversationForProfile(current, profile, linkedFromConversationId),
            profile,
            localConversation,
          ),
        );
        setConversationsLoadedByProfile((current) => ({ ...current, [profile]: true }));
        setHistoryErrorsByProfile((current) => ({ ...current, [profile]: null }));
      }
      const switchSelection =
        !previousConversationId && shouldSendModelSwitch(modelSelection, currentModelSelection)
          ? modelSelection
          : null;
      const coreMetadata: CoreMetadata = {};
      if (gatewayChatId) coreMetadata.chatId = gatewayChatId;
      if (projectId) coreMetadata.projectId = projectId;
      if (switchSelection) coreMetadata.modelSwitch = switchSelection;
      const result = await sendAgentUICoreMessage(
        conversationId,
        {
          text: displayedPrompt,
          attachments: attachmentRefs,
          model: modelSelection || null,
          clientMessageId: userMessage.id,
          metadata: coreMetadata,
        },
        runtimeConfig,
      );
      if (!result.ok) throw new Error(result.error || "Iris Core did not accept the message.");
      const acceptedChatId = ("runtime" in result ? runtimeChatId(result.runtime) : "") || gatewayChatId;
      if (acceptedChatId) {
        setConversationChatIdsByConversation((current) => ({ ...current, [conversationId]: acceptedChatId }));
      }
      if (modelSelection) {
        setModelSelectionByConversation((current) => ({ ...current, [conversationId]: modelSelection }));
      }
      window.setTimeout(() => {
        void pollCoreEvents();
        void refreshConversations({ profileName: profile, silent: true });
        refreshConversationDetailSoon(conversationId, profile, gatewayChatId);
      }, 1200);
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Iris Core session is not available yet.";
      activeRequestIdsByConversationRef.current = removeActiveRequestIds(
        activeRequestIdsByConversationRef.current,
        activeConversationId,
        conversationId,
      );
      activeConversationTitlesByConversationRef.current = removeConversationValues(
        activeConversationTitlesByConversationRef.current,
        activeConversationId,
        conversationId,
      );
      setActiveRequestIdsByConversation((current) =>
        removeActiveRequestIds(current, activeConversationId, conversationId),
      );
      updateConversationMessage(activeConversationId, assistantId, (current) => ({
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

  async function refreshConversations(
    options: {
      silent?: boolean;
      profileName?: string;
      selectConversationId?: string | null;
      transientRetries?: number;
    } = {},
  ) {
    const targetProfile = options.profileName || profile;
    if (!options.silent) {
      setConversationsLoadingByProfile((current) => ({ ...current, [targetProfile]: true }));
    }
    try {
      const result = await getIrisConversations(targetProfile, 80, runtimeConfig);
      if (targetProfile === profile) {
        setHistorySource(result.source || null);
        setHistorySchemaVersion(result.schemaVersion ?? null);
      }
      if (result.ok) {
        const currentProfileConversations = conversationsByProfileRef.current[targetProfile] || [];
        const endpointConversations = preserveActiveConversationTitles(
          preserveLocalConversationProjectMetadata(result.conversations || [], currentProfileConversations),
          currentProfileConversations,
          activeRequestIdsByConversationRef.current,
          activeConversationTitlesByConversationRef.current,
          conversationChatIdsByConversationRef.current,
        );
        setConversationReadStates((current) =>
          mergeConversationReadStates(current, endpointConversations),
        );
        setConversationChatIdsByConversation((current) =>
          mergeConversationChatIdMap(current, endpointConversations),
        );
        const currentSelectedConversationId = selectedConversationIdRef.current || selectedConversationId;
        const selectedChatId = currentSelectedConversationId
          ? conversationChatIdsByConversationRef.current[currentSelectedConversationId] ||
            conversationChatIdsByConversation[currentSelectedConversationId]
          : "";
        const selectedReplacement = currentSelectedConversationId
          ? replacementForOptimisticConversation(
              currentSelectedConversationId,
              endpointConversations,
              currentProfileConversations,
              selectedChatId,
            )
          : null;
        if (
          currentSelectedConversationId &&
          isOptimisticConversationId(currentSelectedConversationId) &&
          selectedReplacement
        ) {
          selectedConversationIdRef.current = selectedReplacement.id;
          setSelectedConversationId(selectedReplacement.id);
          setMessagesByConversation((current) =>
            migrateConversationMessages(current, currentSelectedConversationId, selectedReplacement.id),
          );
          setModelSelectionByConversation((current) =>
            migrateModelSelection(current, currentSelectedConversationId, selectedReplacement.id),
          );
          activeRequestIdsByConversationRef.current = migrateActiveRequestId(
            activeRequestIdsByConversationRef.current,
            currentSelectedConversationId,
            selectedReplacement.id,
          );
          activeConversationTitlesByConversationRef.current = migrateConversationValue(
            activeConversationTitlesByConversationRef.current,
            currentSelectedConversationId,
            selectedReplacement.id,
          );
          setActiveRequestIdsByConversation((current) =>
            migrateActiveRequestId(current, currentSelectedConversationId, selectedReplacement.id),
          );
          setConversationChatIdsByConversation((current) => ({
            ...current,
            [selectedReplacement.id]: selectedReplacement.chatId || selectedChatId,
          }));
        }
        const activeReplacements = activeConversationReplacements(
          activeRequestIdsByConversationRef.current,
          endpointConversations,
          currentProfileConversations,
          conversationChatIdsByConversationRef.current,
        );
        if (activeReplacements.length) {
          for (const replacement of activeReplacements) {
            if (selectedConversationIdRef.current === replacement.fromId) {
              selectedConversationIdRef.current = replacement.to.id;
              setSelectedConversationId(replacement.to.id);
            }
            setMessagesByConversation((current) =>
              migrateConversationMessages(current, replacement.fromId, replacement.to.id),
            );
            setModelSelectionByConversation((current) =>
              migrateModelSelection(current, replacement.fromId, replacement.to.id),
            );
            activeRequestIdsByConversationRef.current = migrateActiveRequestId(
              activeRequestIdsByConversationRef.current,
              replacement.fromId,
              replacement.to.id,
            );
            activeConversationTitlesByConversationRef.current = migrateConversationValue(
              activeConversationTitlesByConversationRef.current,
              replacement.fromId,
              replacement.to.id,
            );
            setActiveRequestIdsByConversation((current) =>
              migrateActiveRequestId(current, replacement.fromId, replacement.to.id),
            );
            setConversationChatIdsByConversation((current) => ({
              ...current,
              [replacement.to.id]: replacement.to.chatId || replacement.chatId,
            }));
          }
        }
        setConversationsByProfile((current) => ({
          ...current,
          [targetProfile]: mergeOptimisticConversations(
            current[targetProfile] || [],
            endpointConversations,
          ),
        }));
        if (options.selectConversationId && targetProfile === profile) {
          const hasSelectedConversation = result.conversations.some(
            (conversation) => conversation.id === options.selectConversationId,
          );
          if (hasSelectedConversation) setSelectedConversationId(options.selectConversationId);
        }
        setHistoryErrorsByProfile((current) => ({ ...current, [targetProfile]: result.warning || null }));
        setConversationsLoadedByProfile((current) => ({ ...current, [targetProfile]: true }));
      } else {
        if (isTransientConversationLoadError(result.error) && (options.transientRetries ?? 3) > 0) {
          scheduleConversationRetry(targetProfile, options.selectConversationId, options.transientRetries ?? 3);
          return;
        }
        if (isTransientConversationLoadError(result.error)) {
          setHistoryErrorsByProfile((current) => ({ ...current, [targetProfile]: null }));
          return;
        }
        setConversationsByProfile((current) => ({ ...current, [targetProfile]: [] }));
        setHistoryErrorsByProfile((current) => ({
          ...current,
          [targetProfile]: result.error || "Could not load Hermes sessions.",
        }));
        setConversationsLoadedByProfile((current) => ({ ...current, [targetProfile]: true }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load Hermes sessions.";
      if (isTransientConversationLoadError(message) && (options.transientRetries ?? 3) > 0) {
        scheduleConversationRetry(targetProfile, options.selectConversationId, options.transientRetries ?? 3);
        return;
      }
      if (isTransientConversationLoadError(message)) {
        setHistoryErrorsByProfile((current) => ({ ...current, [targetProfile]: null }));
        return;
      }
      setConversationsByProfile((current) => ({ ...current, [targetProfile]: [] }));
      setHistoryErrorsByProfile((current) => ({
        ...current,
        [targetProfile]: message,
      }));
      setConversationsLoadedByProfile((current) => ({ ...current, [targetProfile]: true }));
    } finally {
      if (!options.silent) {
        setConversationsLoadingByProfile((current) => ({ ...current, [targetProfile]: false }));
      }
    }
  }

  async function loadConversation(conversationId: string, profileName = profile) {
    if (!conversationId) return;
    pendingProfileSelectionRef.current =
      profileName !== profile ? { profile: profileName, conversationId } : null;
    setSelectedConversationId(conversationId);
    markConversationRead(conversationId, { reason: "conversation-opened" });
    setInput("");
    if (shouldSkipConversationDetailLoad(conversationId, activeRequestIdsByConversation)) {
      setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
      return;
    }
    await refreshConversationDetail(conversationId, profileName, { select: true });
  }

  async function renameConversation(profileName: string, conversationId: string, title: string) {
    const cleanTitle = title.trim();
    if (!cleanTitle) return "Enter a session name.";
    const result = await renameIrisConversation(profileName, conversationId, cleanTitle, runtimeConfig);
    if (!result.ok || !result.conversation) {
      return result.error || "Could not rename this session.";
    }
    setConversationsByProfile((current) =>
      upsertConversationForProfile(current, profileName, result.conversation),
    );
    setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
    return "Session renamed.";
  }

  async function deleteConversation(profileName: string, conversationId: string) {
    if (!conversationId) return "Session was not found.";
    if (activeRequestIdsByConversationRef.current[conversationId]) {
      return "Wait for the active response to finish before deleting this session.";
    }
    const result = await deleteIrisConversation(profileName, conversationId, runtimeConfig);
    if (!result.ok) {
      return result.error || "Could not delete this session.";
    }
    const chatId = latestChatIdForConversation(conversationId, profileName);
    const relatedConversationIds = conversationIdsForChatId(
      chatId,
      conversationId,
      conversationChatIdsByConversationRef.current,
    );
    const idsToRemove = [conversationId, ...relatedConversationIds];
    setConversationsByProfile((current) =>
      removeConversationsForProfile(current, profileName, idsToRemove),
    );
    setMessagesByConversation((current) => removeConversationValues(current, ...idsToRemove));
    setConversationChatIdsByConversation((current) => removeConversationValues(current, ...idsToRemove));
    setModelSelectionByConversation((current) => removeModelSelections(current, ...idsToRemove));
    setConversationReadStates((current) => removeReadStates(current, ...idsToRemove));
    activeRequestIdsByConversationRef.current = removeActiveRequestIds(
      activeRequestIdsByConversationRef.current,
      ...idsToRemove,
    );
    activeConversationTitlesByConversationRef.current = removeConversationValues(
      activeConversationTitlesByConversationRef.current,
      ...idsToRemove,
    );
    setActiveRequestIdsByConversation((current) =>
      removeActiveRequestIds(current, ...idsToRemove),
    );
    if (selectedConversationIdRef.current && idsToRemove.includes(selectedConversationIdRef.current)) {
      startNewConversation(profileName);
    }
    setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
    return "Session deleted.";
  }

  async function refreshConversationDetail(
    conversationId: string,
    profileName = profile,
    options: { silent?: boolean; select?: boolean; reconcileActive?: boolean } = {},
  ) {
    if (!conversationId) return false;
    if (
      isOptimisticConversationId(conversationId) ||
      (activeRequestIdsByConversationRef.current[conversationId] && !options.reconcileActive)
    ) {
      setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
      return false;
    }
    if (!options.silent) {
      setConversationsLoadingByProfile((current) => ({ ...current, [profileName]: true }));
    }
    try {
      const result = await getIrisConversationDetail(profileName, conversationId, runtimeConfig);
      if (profileName === profile) {
        setHistorySource(result.source || null);
        setHistorySchemaVersion(result.schemaVersion ?? null);
      }
      if (!result.ok || !result.conversation) {
        setHistoryErrorsByProfile((current) => ({
          ...current,
          [profileName]: result.error || "Could not load this session.",
        }));
        return false;
      }
      const loadedConversation = result.conversation;
      const selectedId = selectedConversationIdRef.current;
      const selectedChatId = selectedId ? latestChatIdForConversation(selectedId, profileName) : "";
      const selectionStillTargetsThisLoad = shouldApplyConversationDetailSelection(
        selectedId,
        selectedChatId,
        conversationId,
        loadedConversation,
      );
      const shouldUpdateSelection =
        selectionStillTargetsThisLoad &&
        (options.select ||
          selectedId === conversationId ||
          selectedId === loadedConversation.id ||
          Boolean(loadedConversation.chatId && selectedChatId === loadedConversation.chatId));
      if (shouldUpdateSelection) {
        setSelectedConversationId(loadedConversation.id);
      }
      if (loadedConversation.chatId) {
        setConversationChatIdsByConversation((current) => ({
          ...current,
          [loadedConversation.id]: loadedConversation.chatId || "",
        }));
      }
      const activeRequestId =
        activeRequestIdsByConversationRef.current[loadedConversation.id] ||
        activeRequestIdsByConversationRef.current[conversationId] ||
        "";
      const canReconcileActive = activeRequestCompletedByHistory(result.messages, activeRequestId);
      if (!activeRequestId || canReconcileActive) {
        setMessagesByConversation((current) => {
          const localMessages = current[loadedConversation.id] || [];
          if (shouldPreserveLocalMessagesOnEmptyHistory(localMessages, result.messages)) {
            return current;
          }
          const historyMessages = preserveLocalScheduledDeliveries(
            toAppMessages(result.messages),
            localMessages,
          );
          return {
            ...current,
            [loadedConversation.id]: historyMessages,
          };
        });
      }
      if (canReconcileActive) {
        const relatedConversationIds = conversationIdsForChatId(
          loadedConversation.chatId || "",
          loadedConversation.id,
          conversationChatIdsByConversationRef.current,
        );
        activeRequestIdsByConversationRef.current = removeActiveRequestIds(
          activeRequestIdsByConversationRef.current,
          conversationId,
          loadedConversation.id,
          ...relatedConversationIds,
        );
        activeConversationTitlesByConversationRef.current = removeConversationValues(
          activeConversationTitlesByConversationRef.current,
          conversationId,
          loadedConversation.id,
          ...relatedConversationIds,
        );
        setActiveRequestIdsByConversation((current) =>
          removeActiveRequestIds(current, conversationId, loadedConversation.id, ...relatedConversationIds),
        );
      }
      setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: result.warning || null }));
      return true;
    } catch (error) {
      setHistoryErrorsByProfile((current) => ({
        ...current,
        [profileName]: error instanceof Error ? error.message : "Could not load this session.",
      }));
      return false;
    } finally {
      if (!options.silent) {
        setConversationsLoadingByProfile((current) => ({ ...current, [profileName]: false }));
      }
    }
  }

  function refreshConversationDetailSoon(conversationId: string, profileName = profile, chatId = "") {
    window.setTimeout(() => {
      const targetConversationId = latestRealConversationIdForChatId(chatId, profileName) ||
        (isOptimisticConversationId(conversationId) ? "" : conversationId);
      if (targetConversationId) {
        void refreshConversationDetail(targetConversationId, profileName, { silent: true });
      }
    }, 600);
  }

  function startNewConversation(profileName = profile) {
    pendingProfileSelectionRef.current = null;
    setSelectedConversationId(null);
    setInput("");
    setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
  }

  async function createCoreConversationForPrompt(
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
      const agentResult = await getAgentUICoreAgentForProfile(profile, runtimeConfig);
      if (!agentResult.ok || !agentResult.agent) return null;
      const created = await createAgentUICoreConversation(
        {
          agentId: agentResult.agent.id,
          title: conversationTitleFromPrompt(promptText),
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
      if (!created.ok || !created.conversation) return null;
      return {
        id: created.conversation.id,
        source: "agentui-core",
        model,
        title: created.conversation.title,
        preview: compactText(promptText, 180),
        chatId: created.conversation.externalChatId,
        origin: created.conversation.origin || {},
        metadata: created.conversation.metadata || {},
        startedAt: created.conversation.createdAt,
        endedAt: null,
        lastActiveAt: created.conversation.updatedAt,
        messageCount: 1,
      } satisfies HermesConversation;
    } catch {
      return null;
    }
  }

  function coreConversationForLegacySelection(conversationId: string, chatId = "") {
    if (!conversationId || isCoreConversationId(conversationId)) return null;
    if (chatId) {
      const byChatId = conversations.find(
        (conversation) => isCoreConversationId(conversation.id) && conversation.chatId === chatId,
      );
      if (byChatId) return byChatId;
    }
    return null;
  }

  function scheduleConversationRetry(
    targetProfile: string,
    selectConversationId: string | null | undefined,
    remainingRetries: number,
  ) {
    window.setTimeout(() => {
      void refreshConversations({
        profileName: targetProfile,
        selectConversationId,
        silent: true,
        transientRetries: remainingRetries - 1,
      });
    }, 1200 * (4 - remainingRetries));
  }

  async function cancelMessage() {
    if (!selectedConversationId || !activeRequestId) return;
    const conversationId = selectedConversationId;
    if (isCoreConversationId(conversationId)) await cancelAgentUICoreMessage(conversationId, runtimeConfig);
    activeRequestIdsByConversationRef.current = removeActiveRequestIds(
      activeRequestIdsByConversationRef.current,
      conversationId,
    );
    activeConversationTitlesByConversationRef.current = removeConversationValues(
      activeConversationTitlesByConversationRef.current,
      conversationId,
    );
    setActiveRequestIdsByConversation((current) => removeActiveRequestIds(current, conversationId));
  }

  async function pollCoreEvents() {
    const cursor = eventCursorsByProfileRef.current[profile] || 0;
    const agentResult = await getAgentUICoreAgentForProfile(profile, runtimeConfig);
    if (!agentResult.ok || !agentResult.agent) return;
    const result = await getAgentUICoreEvents(cursor, 50, runtimeConfig, agentResult.agent.id);
    if (!result.ok) return;
    eventCursorsByProfileRef.current = {
      ...eventCursorsByProfileRef.current,
      [profile]: result.cursor || cursor,
    };
    handleCoreEvents(result.events);
    reconcileActiveConversationDetails();
  }

  function handleCoreEvents(events: AgentUICoreEvent[]) {
    const deliveries = events
      .filter((event) => event.type.startsWith("message.assistant") || event.type === "message.error")
      .map((event) => coreEventToInboxMessage(event, profile));
    if (!deliveries.length) return;
    const cursor = deliveries.reduce(
      (current, delivery) => Math.max(current, delivery.cursor),
      eventCursorsByProfileRef.current[profile] || 0,
    );
    eventCursorsByProfileRef.current = {
      ...eventCursorsByProfileRef.current,
      [profile]: cursor,
    };
    handleCoreDeliveries(deliveries);
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

    for (const delivery of deliveries) {
      if (processedInboxEventIdsRef.current.has(delivery.id)) continue;
      if (delivery.profile && delivery.profile !== profile) {
        remaining.push(delivery);
        continue;
      }
      const replyTo = stringMetadata(delivery.metadata, "replyTo") || stringMetadata(delivery.metadata, "reply_to");
      const hidden = isHiddenDeliveryMetadata(delivery.metadata);
      if (hidden) {
        processedInboxEventIdsRef.current.add(delivery.id);
        handledDelivery = true;
        continue;
      }
      const streamMessageId = stringMetadata(delivery.metadata, "streamMessageId") ||
        stringMetadata(delivery.metadata, "stream_message_id");
      const isStreamDelivery = Boolean(streamMessageId);
      const isFinalStreamDelivery = isStreamDelivery && streamDeliveryFinalized(delivery.metadata);
      const conversationId =
        conversationIdForActiveRequest(replyTo) ||
        conversationIdForChatId(delivery.chatId);
      if (!conversationId) {
        if (markUnmappedDeliveryForRetry(delivery.id)) {
          remaining.push(delivery);
          unmappedDelivery = true;
        } else {
          processedInboxEventIdsRef.current.add(delivery.id);
          delete pendingUnmappedDeliveryAttemptsRef.current[delivery.id];
        }
        continue;
      }
      const relatedConversationIds = conversationIdsForChatId(
        delivery.chatId,
        conversationId,
        conversationChatIdsByConversationRef.current,
      );
      const existingBeforeMerge = mergeRelatedConversationMessages(
        messagesByConversationRef.current,
        relatedConversationIds,
      );
      const completesActiveStream = !isStreamDelivery &&
        deliveryCompletesActiveStream(existingBeforeMerge, delivery);

      handledDelivery = true;
      processedInboxEventIdsRef.current.add(delivery.id);
      delete pendingUnmappedDeliveryAttemptsRef.current[delivery.id];
      if (processedInboxEventIdsRef.current.size > 500) {
        processedInboxEventIdsRef.current = new Set(
          Array.from(processedInboxEventIdsRef.current).slice(-250),
        );
      }
      setMessagesByConversation((current) => {
        const existing = mergeRelatedConversationMessages(
          current,
          relatedConversationIds,
        );
        if (!isStreamDelivery && existing.some((message) => message.id === delivery.id)) return current;
        const nextMessages = isStreamDelivery
          ? mergeStreamDelivery(existing, delivery, streamMessageId, isFinalStreamDelivery)
          : mergeCompletedDelivery(existing, delivery, replyTo);
        return setConversationMessages(current, relatedConversationIds, conversationId, nextMessages);
      });
      if (replyTo && (!isStreamDelivery || isFinalStreamDelivery)) {
        activeRequestIdsByConversationRef.current = removeActiveRequestIds(
          activeRequestIdsByConversationRef.current,
          ...relatedConversationIds,
        );
        activeConversationTitlesByConversationRef.current = removeConversationValues(
          activeConversationTitlesByConversationRef.current,
          ...relatedConversationIds,
        );
        setActiveRequestIdsByConversation((current) =>
          removeActiveRequestIds(current, ...relatedConversationIds),
        );
      } else if (isFinalStreamDelivery || completesActiveStream) {
        activeRequestIdsByConversationRef.current = removeActiveRequestIds(
          activeRequestIdsByConversationRef.current,
          ...relatedConversationIds,
        );
        activeConversationTitlesByConversationRef.current = removeConversationValues(
          activeConversationTitlesByConversationRef.current,
          ...relatedConversationIds,
        );
        setActiveRequestIdsByConversation((current) =>
          removeActiveRequestIds(current, ...relatedConversationIds),
        );
      }
      if (!isStreamDelivery || isFinalStreamDelivery) {
        markDeliveredConversationReadState(relatedConversationIds, delivery.cursor);
        refreshConversationDetailSoon(conversationId, profile, delivery.chatId);
      }
    }

    pendingGatewayDeliveriesRef.current = remaining.slice(-100);
    if (handledDelivery || unmappedDelivery) {
      void refreshConversations({ profileName: profile, silent: true });
    }
  }

  function reconcileActiveConversationDetails() {
    const nowMs = Date.now();
    for (const conversationId of Object.keys(activeRequestIdsByConversationRef.current)) {
      if (isOptimisticConversationId(conversationId)) continue;
      if (nowMs - (activeDetailReconcileAtRef.current[conversationId] || 0) < 1500) continue;
      activeDetailReconcileAtRef.current = {
        ...activeDetailReconcileAtRef.current,
        [conversationId]: nowMs,
      };
      void refreshConversationDetail(conversationId, profile, { silent: true, reconcileActive: true });
    }
  }

  function chatIdForConversation(conversationId: string | null | undefined) {
    if (!conversationId) return "";
    return (
      conversationChatIdsByConversation[conversationId] ||
      conversations.find((conversation) => conversation.id === conversationId)?.chatId ||
      ""
    );
  }

  function conversationIdForChatId(chatId: string) {
    if (!chatId) return "";
    const selectedId = selectedConversationIdRef.current;
    if (selectedId && latestChatIdForConversation(selectedId) === chatId) {
      return selectedId;
    }
    const profileConversations = conversationsByProfileRef.current[profile] || [];
    const realConversation = profileConversations.find(
      (conversation) => !isOptimisticConversation(conversation) && conversation.chatId === chatId,
    );
    if (realConversation) return realConversation.id;
    for (const [conversationId, mappedChatId] of Object.entries(conversationChatIdsByConversationRef.current)) {
      if (mappedChatId === chatId && !isOptimisticConversationId(conversationId)) return conversationId;
    }
    for (const [conversationId, mappedChatId] of Object.entries(conversationChatIdsByConversationRef.current)) {
      if (mappedChatId === chatId) return conversationId;
    }
    return profileConversations.find((conversation) => conversation.chatId === chatId)?.id || "";
  }

  function conversationIdForActiveRequest(requestId: string) {
    if (!requestId) return "";
    for (const [conversationId, activeId] of Object.entries(activeRequestIdsByConversationRef.current)) {
      if (activeId === requestId) return conversationId;
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

  function latestChatIdForConversation(conversationId: string, profileName = profile) {
    return (
      conversationChatIdsByConversationRef.current[conversationId] ||
      (conversationsByProfileRef.current[profileName] || [])
        .find((conversation) => conversation.id === conversationId)?.chatId ||
      ""
    );
  }

  function latestRealConversationIdForChatId(chatId: string, profileName = profile) {
    if (!chatId) return "";
    const realConversation = (conversationsByProfileRef.current[profileName] || []).find(
      (conversation) => !isOptimisticConversation(conversation) && conversation.chatId === chatId,
    );
    if (realConversation) return realConversation.id;
    for (const [conversationId, mappedChatId] of Object.entries(conversationChatIdsByConversationRef.current)) {
      if (mappedChatId === chatId && !isOptimisticConversationId(conversationId)) return conversationId;
    }
    return "";
  }

  function updateConversationMessage(
    conversationId: string,
    messageId: string,
    updater: (message: Message) => Message,
  ) {
    setMessagesByConversation((current) => ({
      ...current,
      [conversationId]: (current[conversationId] || []).map((message) =>
        message.id === messageId ? updater(message) : message,
      ),
    }));
  }

  function markDeliveredConversationReadState(conversationIds: string[], eventCursor: number) {
    const selectedId = selectedConversationIdRef.current;
    const visible = Boolean(isChatViewActiveRef.current && selectedId && conversationIds.includes(selectedId));
    const state = visible ? "read" : "unread";
    for (const conversationId of conversationIds) {
      markConversationReadState(conversationId, state, {
        reason: visible ? "active-delivery" : "background-delivery",
        eventCursor,
      });
    }
  }

  function markConversationRead(conversationId: string, metadata: CoreMetadata = {}) {
    markConversationReadState(conversationId, "read", metadata);
  }

  function markConversationReadState(
    conversationId: string,
    state: "read" | "unread",
    metadata: CoreMetadata = {},
  ) {
    if (!isCoreConversationId(conversationId)) return;
    setConversationReadStates((current) => ({ ...current, [conversationId]: state }));
    setConversationsByProfile((current) =>
      updateConversationReadStateForProfiles(current, conversationId, state),
    );
    void updateAgentUICoreConversationReadState(conversationId, state, runtimeConfig, metadata);
  }

  return {
    activeRequestId,
    activeConversationIds,
    cancelMessage,
    conversations,
    conversationsByProfile,
    conversationReadStates,
    conversationsLoadedByProfile,
    conversationsLoading,
    conversationsLoadingByProfile,
    historyError,
    historyErrorsByProfile,
    historySchemaVersion,
    historySource,
    input,
    deleteConversation,
    loadConversation,
    messages,
    renameConversation,
    selectedModelSelection,
    requestActive: Boolean(activeRequestId),
    refreshConversations,
    selectedConversationId,
    sendMessage,
    setInput,
    startNewConversation,
  };
}

export const useIrisChat = useAgentUIChat;
