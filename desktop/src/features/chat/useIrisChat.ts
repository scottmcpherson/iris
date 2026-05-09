import { useEffect, useRef, useState } from "react";
import type { Message, MessageAttachment } from "../../app/types";
import {
  coreEventToInboxMessage,
  getIrisConversationDetail,
  getIrisConversations,
} from "../../lib/irisRuntime";
import {
  agentUICoreEventStreamUrl,
  cancelAgentUICoreMessage,
  createAgentUICoreConversation,
  getAgentUICoreEvents,
  getAgentUICoreAgentForProfile,
  sendAgentUICoreMessage,
  type AgentUICoreEvent,
} from "../../lib/agentuiCore";
import type {
  HermesConversation,
  HermesConversationMessage,
  HermesInboxMessage,
  HermesModelSelection,
  HermesRuntimeConfig,
} from "../../types/hermes";
import { compactText } from "../../shared/strings";
import { AttachmentUploadError, formatPromptWithAttachments, uploadAttachmentsForSend } from "./chatAttachments";
import type { PendingProfileConversationSelection, SendMessageOptions } from "./chatTypes";
import {
  booleanMetadata,
  isHiddenDeliveryMetadata,
  stringMetadata,
  toAppMessages,
} from "./chatHistory";
import {
  deliveryCompletesActiveStream,
  mergeCompletedDelivery,
  mergeMessageLists,
  mergeStreamDelivery,
} from "./chatStreamMerging";

export { isHiddenDeliveryMetadata, stripModelSwitchNote, toAppMessages } from "./chatHistory";
export {
  coalescePostStreamAttachments,
  deliveryCompletesActiveStream,
  mergeCompletedDelivery,
  mergeMessageLists,
  mergeStreamDelivery,
} from "./chatStreamMerging";
export { mergeUploadedAttachment } from "./chatAttachments";
export type { SendableAttachment } from "./chatTypes";

type UseIrisChatOptions = {
  profile: string;
  runtimeConfig: HermesRuntimeConfig;
};

const coreDeliveryEventNames = [
  "message.assistant.delta",
  "message.assistant.completed",
  "message.error",
];

export function useAgentUIChat({ profile, runtimeConfig }: UseIrisChatOptions) {
  const [input, setInput] = useState("");
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, Message[]>>({});
  const [activeRequestIdsByConversation, setActiveRequestIdsByConversation] = useState<Record<string, string>>({});
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
  const hasActiveRequest = Object.keys(activeRequestIdsByConversation).length > 0;
  const selectedConversation = visibleConversationId
    ? conversations.find((conversation) => conversation.id === visibleConversationId) || null
    : null;
  const selectedModelSelection = visibleConversationId
    ? modelSelectionByConversation[visibleConversationId] || selectionFromConversation(selectedConversation)
    : null;

  messagesByConversationRef.current = messagesByConversation;
  activeRequestIdsByConversationRef.current = activeRequestIdsByConversation;
  selectedConversationIdRef.current = selectedConversationId;
  conversationChatIdsByConversationRef.current = conversationChatIdsByConversation;
  conversationsByProfileRef.current = conversationsByProfile;

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
            previousId && !isOptimisticConversationId(previousId)
              ? {
                  externalChatId: gatewayChatId,
                  externalSessionId: previousId,
                  createdBy: "desktop-legacy-link",
                }
              : undefined,
          );
        if (!coreConversation) throw new Error("Iris Core chat is unavailable. Message was not sent.");
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
      const coreMetadata: Record<string, unknown> = {};
      if (gatewayChatId) coreMetadata.chatId = gatewayChatId;
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
          : "Iris Core chat is not available yet.";
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
          result.conversations || [],
          currentProfileConversations,
          activeRequestIdsByConversationRef.current,
          activeConversationTitlesByConversationRef.current,
          conversationChatIdsByConversationRef.current,
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
          [targetProfile]: result.error || "Could not load Hermes conversations.",
        }));
        setConversationsLoadedByProfile((current) => ({ ...current, [targetProfile]: true }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load Hermes conversations.";
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
    setInput("");
    if (shouldSkipConversationDetailLoad(conversationId, activeRequestIdsByConversation)) {
      setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
      return;
    }
    await refreshConversationDetail(conversationId, profileName, { select: true });
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
          [profileName]: result.error || "Could not load this conversation.",
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
          return {
            ...current,
            [loadedConversation.id]: toAppMessages(result.messages),
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
        [profileName]: error instanceof Error ? error.message : "Could not load this conversation.",
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
          metadata: { model, ...(link?.createdBy ? { createdBy: link.createdBy } : {}) },
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

  return {
    activeRequestId,
    activeConversationIds: Object.keys(activeRequestIdsByConversation),
    cancelMessage,
    conversations,
    conversationsByProfile,
    conversationsLoadedByProfile,
    conversationsLoading,
    conversationsLoadingByProfile,
    historyError,
    historyErrorsByProfile,
    historySchemaVersion,
    historySource,
    input,
    loadConversation,
    messages,
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

export function shouldSendModelSwitch(
  selected: HermesModelSelection | null,
  current: HermesModelSelection | null,
) {
  if (!selected?.model) return false;
  if (!current?.model) return true;
  return selected.model !== current.model || selected.provider !== current.provider;
}

function selectionFromConversation(conversation: HermesConversation | null): HermesModelSelection | null {
  if (!conversation?.model) return null;
  return { provider: "", model: conversation.model };
}

function migrateModelSelection(
  current: Record<string, HermesModelSelection>,
  sourceId: string,
  targetId: string,
) {
  const selection = current[sourceId];
  if (!selection) return current;
  const next = { ...current, [targetId]: selection };
  delete next[sourceId];
  return next;
}

function upsertConversationForProfile(
  current: Record<string, HermesConversation[]>,
  profile: string,
  conversation: HermesConversation,
) {
  return {
    ...current,
    [profile]: sortConversationsByActivity([
      conversation,
      ...(current[profile] || []).filter((item) => item.id !== conversation.id),
    ]),
  };
}

function removeConversationForProfile(
  current: Record<string, HermesConversation[]>,
  profile: string,
  conversationId: string,
) {
  if (!conversationId) return current;
  const conversations = current[profile] || [];
  const filtered = conversations.filter((item) => item.id !== conversationId);
  if (filtered.length === conversations.length) return current;
  return { ...current, [profile]: filtered };
}

function mergeOptimisticConversations(
  current: HermesConversation[],
  endpointConversations: HermesConversation[],
) {
  const endpointIds = new Set(endpointConversations.map((conversation) => conversation.id));
  const endpointChatIds = new Set(endpointConversations.map((conversation) => conversation.chatId).filter(Boolean));
  const optimisticConversations = current.filter(
    (conversation) =>
      isOptimisticConversation(conversation) &&
      !endpointIds.has(conversation.id) &&
      (!conversation.chatId || !endpointChatIds.has(conversation.chatId)) &&
      !endpointConversations.some((endpointConversation) =>
        conversationsLikelyMatch(conversation, endpointConversation),
      ),
  );
  return sortConversationsByActivity([...optimisticConversations, ...endpointConversations]);
}

export function preserveActiveConversationTitles(
  endpointConversations: HermesConversation[],
  currentConversations: HermesConversation[],
  activeRequestIdsByConversation: Record<string, string>,
  activeTitlesByConversation: Record<string, string>,
  chatIdsByConversation: Record<string, string>,
) {
  if (!Object.keys(activeRequestIdsByConversation).length) return endpointConversations;
  const activeLocalTitles = new Map<string, string>();
  for (const conversationId of Object.keys(activeRequestIdsByConversation)) {
    const localConversation = currentConversations.find((conversation) => conversation.id === conversationId);
    const localTitle = activeTitlesByConversation[conversationId] || localConversation?.title || "";
    if (!localTitle || isPlaceholderConversationTitle(localTitle)) continue;
    activeLocalTitles.set(`id:${conversationId}`, localTitle);
    if (localConversation?.id) activeLocalTitles.set(`id:${localConversation.id}`, localTitle);
    const chatId = chatIdsByConversation[conversationId] || localConversation?.chatId || "";
    if (chatId) activeLocalTitles.set(`chat:${chatId}`, localTitle);
  }
  if (!activeLocalTitles.size) return endpointConversations;
  return endpointConversations.map((conversation) => {
    if (!isPlaceholderConversationTitle(conversation.title)) return conversation;
    const preservedTitle = activeLocalTitles.get(`id:${conversation.id}`) ||
      (conversation.chatId ? activeLocalTitles.get(`chat:${conversation.chatId}`) : "");
    return preservedTitle ? { ...conversation, title: preservedTitle } : conversation;
  });
}

function replacementForOptimisticConversation(
  conversationId: string,
  endpointConversations: HermesConversation[],
  currentConversations: HermesConversation[],
  selectedChatId = "",
) {
  if (!isOptimisticConversationId(conversationId)) return null;
  if (selectedChatId) {
    const chatMatch = endpointConversations.find((conversation) => conversation.chatId === selectedChatId);
    if (chatMatch) return chatMatch;
  }
  const optimisticConversation = currentConversations.find((conversation) => conversation.id === conversationId);
  if (!optimisticConversation) return null;
  return endpointConversations.find((conversation) =>
    conversationsLikelyMatch(optimisticConversation, conversation),
  ) || null;
}

export function activeConversationReplacements(
  activeRequestIdsByConversation: Record<string, string>,
  endpointConversations: HermesConversation[],
  currentConversations: HermesConversation[],
  chatIdsByConversation: Record<string, string>,
) {
  const replacements: Array<{ fromId: string; to: HermesConversation; chatId: string }> = [];
  const endpointIds = new Set(endpointConversations.map((conversation) => conversation.id));
  const claimedIds = new Set<string>();
  for (const conversationId of Object.keys(activeRequestIdsByConversation)) {
    if (endpointIds.has(conversationId)) continue;
    const chatId = chatIdsByConversation[conversationId] ||
      currentConversations.find((conversation) => conversation.id === conversationId)?.chatId ||
      "";
    if (!chatId) continue;
    const replacement = endpointConversations.find(
      (conversation) => conversation.chatId === chatId && !claimedIds.has(conversation.id),
    );
    if (!replacement) continue;
    claimedIds.add(replacement.id);
    replacements.push({ fromId: conversationId, to: replacement, chatId });
  }
  return replacements;
}

function isPlaceholderConversationTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  return normalized === "untitled conversation" ||
    normalized === "untitled session" ||
    normalized === "new conversation";
}

function conversationsLikelyMatch(left: HermesConversation, right: HermesConversation) {
  if (isOptimisticConversation(right)) return false;
  if (left.chatId && right.chatId && left.chatId === right.chatId) return true;
  const leftTitle = normalizeConversationLabel(left.title);
  const rightTitle = normalizeConversationLabel(right.title);
  const leftPreview = normalizeConversationLabel(left.preview);
  const rightPreview = normalizeConversationLabel(right.preview);
  const labelMatches = Boolean(
    (leftTitle && leftTitle === rightTitle) ||
    (leftPreview && leftPreview === rightPreview) ||
    (leftTitle && rightPreview && leftTitle === rightPreview) ||
    (leftPreview && rightTitle && leftPreview === rightTitle),
  );
  if (!labelMatches) return false;
  return conversationActivityTimestamp(right) >= conversationActivityTimestamp(left) - 2;
}

function normalizeConversationLabel(value: string | null | undefined) {
  return (value || "").trim();
}

function conversationActivityTimestamp(conversation: HermesConversation) {
  return conversation.lastActiveAt || conversation.startedAt || 0;
}

function isOptimisticConversation(conversation: HermesConversation) {
  return conversation.source === "optimistic" || isOptimisticConversationId(conversation.id);
}

function isOptimisticConversationId(conversationId: string) {
  return conversationId.startsWith("optimistic-");
}

function isCoreConversationId(conversationId: string) {
  return conversationId.startsWith("conv_");
}

export function mergeConversationChatIdMap(
  current: Record<string, string>,
  conversations: Pick<HermesConversation, "id" | "chatId">[],
) {
  let changed = false;
  const next = { ...current };
  for (const conversation of conversations) {
    if (!conversation.chatId || current[conversation.id] === conversation.chatId) continue;
    next[conversation.id] = conversation.chatId;
    changed = true;
  }
  return changed ? next : current;
}

export function shouldRetryUnmappedDelivery(attempts: number, maxAttempts = 2) {
  return attempts < maxAttempts;
}

function visibleConversationForSelection(
  selectedConversationId: string | null,
  conversations: HermesConversation[],
  chatIdsByConversation: Record<string, string>,
  messagesByConversation: Record<string, Message[]>,
) {
  if (!selectedConversationId) return null;
  if (messagesByConversation[selectedConversationId]?.length) return selectedConversationId;

  const selectedChatId =
    chatIdsByConversation[selectedConversationId] ||
    conversations.find((conversation) => conversation.id === selectedConversationId)?.chatId ||
    "";
  if (!selectedChatId) return selectedConversationId;

  const fallback = Object.entries(chatIdsByConversation).find(
    ([conversationId, chatId]) =>
      conversationId !== selectedConversationId &&
      chatId === selectedChatId &&
      Boolean(messagesByConversation[conversationId]?.length),
  );
  return fallback?.[0] || selectedConversationId;
}

export function shouldPreserveProfileConversationSelection(
  profile: string,
  selectedConversationId: string | null,
  pendingSelection: PendingProfileConversationSelection | null,
) {
  return Boolean(
    selectedConversationId &&
      pendingSelection &&
      pendingSelection.profile === profile &&
      pendingSelection.conversationId === selectedConversationId,
  );
}

export function shouldApplyConversationDetailSelection(
  selectedConversationId: string | null,
  selectedChatId: string,
  requestedConversationId: string,
  loadedConversation: Pick<HermesConversation, "id" | "chatId">,
) {
  return Boolean(
    selectedConversationId &&
      (selectedConversationId === requestedConversationId ||
        selectedConversationId === loadedConversation.id ||
        Boolean(loadedConversation.chatId && selectedChatId === loadedConversation.chatId)),
  );
}

export function shouldSkipConversationDetailLoad(
  conversationId: string,
  activeRequestIdsByConversation: Record<string, string>,
) {
  return Boolean(activeRequestIdsByConversation[conversationId] || isOptimisticConversationId(conversationId));
}

export function shouldPreserveLocalMessagesOnEmptyHistory(
  localMessages: Message[],
  historyMessages: HermesConversationMessage[],
) {
  return localMessages.length > 0 && historyMessages.length === 0;
}

export function activeRequestCompletedByHistory(
  historyMessages: HermesConversationMessage[],
  activeRequestId: string,
) {
  if (!activeRequestId) return false;
  let sawActiveUser = false;
  return historyMessages.some((message) => {
    if (message.role === "user" && message.id === activeRequestId) {
      sawActiveUser = true;
      return false;
    }
    if (message.role !== "assistant" || message.status !== "completed" || !message.content.trim()) return false;
    const metadata = message.metadata || {};
    if (historyMessageStillStreaming(metadata)) return false;
    const replyTo = stringMetadata(metadata, "replyTo") || stringMetadata(metadata, "reply_to");
    return replyTo === activeRequestId || sawActiveUser;
  });
}

function historyMessageStillStreaming(metadata: Record<string, unknown>) {
  if (booleanMetadata(metadata, "streaming") === true) return true;
  if (booleanMetadata(metadata, "finalize") === false || booleanMetadata(metadata, "final") === false) return true;
  return false;
}

function parseCoreEvent(data: string): AgentUICoreEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const event = parsed as Partial<AgentUICoreEvent>;
    if (typeof event.cursor !== "number" || typeof event.type !== "string") return null;
    return event as AgentUICoreEvent;
  } catch {
    return null;
  }
}

function runtimeChatId(runtime: Record<string, unknown> | undefined) {
  const value = runtime?.chatId;
  return typeof value === "string" ? value : "";
}

function streamDeliveryFinalized(metadata: Record<string, unknown>) {
  return booleanMetadata(metadata, "finalize") === true || booleanMetadata(metadata, "streaming") === false;
}

function dedupeInboxDeliveries(deliveries: HermesInboxMessage[]) {
  const byId = new Map<string, HermesInboxMessage>();
  for (const delivery of deliveries) {
    byId.set(delivery.id, delivery);
  }
  return Array.from(byId.values()).sort((left, right) => left.cursor - right.cursor);
}

function conversationIdsForChatId(
  chatId: string,
  fallbackConversationId: string,
  chatIdsByConversation: Record<string, string>,
) {
  const ids = Object.entries(chatIdsByConversation)
    .filter(([, mappedChatId]) => mappedChatId === chatId)
    .map(([conversationId]) => conversationId);
  if (!ids.includes(fallbackConversationId)) ids.push(fallbackConversationId);
  return ids;
}

function mergeRelatedConversationMessages(
  current: Record<string, Message[]>,
  conversationIds: string[],
) {
  const orderedIds = [...conversationIds].sort((left, right) => {
    const leftHasUser = current[left]?.some((message) => message.role === "user") ? 1 : 0;
    const rightHasUser = current[right]?.some((message) => message.role === "user") ? 1 : 0;
    if (leftHasUser !== rightHasUser) return rightHasUser - leftHasUser;
    const leftOptimistic = isOptimisticConversationId(left) ? 1 : 0;
    const rightOptimistic = isOptimisticConversationId(right) ? 1 : 0;
    return rightOptimistic - leftOptimistic;
  });
  return orderedIds.reduce<Message[]>(
    (messages, conversationId) => mergeMessageLists(messages, current[conversationId] || []),
    [],
  );
}

function setConversationMessages(
  current: Record<string, Message[]>,
  relatedConversationIds: string[],
  targetConversationId: string,
  messages: Message[],
) {
  const next = { ...current };
  for (const conversationId of relatedConversationIds) {
    if (conversationId !== targetConversationId) delete next[conversationId];
  }
  next[targetConversationId] = messages;
  return next;
}

function migrateConversationMessages(
  current: Record<string, Message[]>,
  fromConversationId: string,
  toConversationId: string,
) {
  if (fromConversationId === toConversationId) return current;
  const next = { ...current };
  const fromMessages = next[fromConversationId] || [];
  delete next[fromConversationId];
  next[toConversationId] = mergeMessageLists(fromMessages, next[toConversationId] || []);
  return next;
}

function migrateActiveRequestId(
  current: Record<string, string>,
  fromConversationId: string,
  toConversationId: string,
) {
  return migrateConversationValue(current, fromConversationId, toConversationId);
}

function migrateConversationValue(
  current: Record<string, string>,
  fromConversationId: string,
  toConversationId: string,
) {
  if (fromConversationId === toConversationId || !current[fromConversationId]) return current;
  const next = { ...current };
  next[toConversationId] = next[fromConversationId];
  delete next[fromConversationId];
  return next;
}

function removeActiveRequestIds(
  current: Record<string, string>,
  ...conversationIds: Array<string | null | undefined>
) {
  return removeConversationValues(current, ...conversationIds);
}

function removeConversationValues(
  current: Record<string, string>,
  ...conversationIds: Array<string | null | undefined>
) {
  const ids = new Set(conversationIds.filter(Boolean));
  if (!ids.size) return current;
  return Object.fromEntries(Object.entries(current).filter(([conversationId]) => !ids.has(conversationId)));
}

function sortConversationsByActivity(conversations: HermesConversation[]) {
  return [...conversations].sort(
    (left, right) => conversationTimestamp(right) - conversationTimestamp(left),
  );
}

function optimisticConversationFromPrompt(
  conversationId: string,
  prompt: string,
  startedAt: number,
  lastActiveAt: number,
  chatId: string,
  model: string,
): HermesConversation {
  return {
    id: conversationId,
    source: "optimistic",
    model,
    title: conversationTitleFromPrompt(prompt),
    preview: compactText(prompt, 180),
    chatId,
    origin: {},
    startedAt,
    endedAt: null,
    lastActiveAt,
    messageCount: 1,
  };
}

function conversationTimestamp(conversation: HermesConversation) {
  return conversation.lastActiveAt || conversation.startedAt || 0;
}

function conversationTitleFromPrompt(prompt: string) {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const attachmentTitle = titleFromAttachmentSummary(firstLine || "");
  if (attachmentTitle) return attachmentTitle;
  return compactText(firstLine || "New conversation", 90);
}

function titleFromAttachmentSummary(firstLine: string) {
  const match = firstLine.match(/^\d+\.\s+(.+?)\s+\(([^)]*)\)/u);
  if (!match) return "";
  const name = match[1].trim();
  const detail = match[2].toLowerCase();
  if (detail.includes("audio/") || /\.(aac|flac|m4a|mp3|mp4|mpeg|mpga|ogg|wav|webm)$/i.test(name)) {
    return "Voice message";
  }
  return compactText(name || "Attached file", 90);
}

export function isTransientConversationLoadError(message?: string | null) {
  if (typeof message !== "string") return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unable to open database file") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("aborterror") ||
    normalized.includes("networkerror") ||
    normalized.includes("failed to fetch")
  );
}
