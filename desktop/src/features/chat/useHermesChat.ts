import { useEffect, useRef, useState } from "react";
import type { Message, MessageAttachment } from "../../app/types";
import {
  coreEventToInboxMessage,
  getHermesConversationDetail,
  getHermesConversations,
  sendHermesGatewayMessage,
} from "../../lib/hermes";
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
  HermesHistoryToolCall,
  HermesInboxMessage,
  HermesModelSelection,
  HermesRuntimeConfig,
  HermesStreamToolEvent,
} from "../../types/hermes";

type UseHermesChatOptions = {
  profile: string;
  runtimeConfig: HermesRuntimeConfig;
};

type PendingProfileConversationSelection = {
  profile: string;
  conversationId: string;
};

type SendMessageOptions = {
  attachments?: MessageAttachment[];
  modelSelection?: HermesModelSelection | null;
  currentModelSelection?: HermesModelSelection | null;
};

const coreDeliveryEventNames = [
  "message.assistant.delta",
  "message.assistant.completed",
  "message.error",
];

export function useAgentUIChat({ profile, runtimeConfig }: UseHermesChatOptions) {
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
  const hiddenGatewayMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingGatewayDeliveriesRef = useRef<HermesInboxMessage[]>([]);
  const pendingUnmappedDeliveryAttemptsRef = useRef<Record<string, number>>({});
  const pendingProfileSelectionRef = useRef<PendingProfileConversationSelection | null>(null);
  const coreEventSourceRef = useRef<EventSource | null>(null);
  const activeRequestIdsByConversationRef = useRef(activeRequestIdsByConversation);
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
  }, [runtimeConfig.managementApiUrl, profile, hasActiveRequest]);

  async function sendMessage(options: SendMessageOptions | MessageAttachment[] = {}) {
    const attachments = Array.isArray(options) ? options : options.attachments || [];
    const modelSelection = Array.isArray(options) ? null : options.modelSelection || null;
    const currentModelSelection = Array.isArray(options) ? null : options.currentModelSelection || null;
    const prompt = input.trim();
    if (!prompt && !attachments.length) return false;
    const promptWithAttachments = formatPromptWithAttachments(prompt, attachments);
    const previousConversationId = selectedConversationId;
    let coreCreatedConversation: HermesConversation | null = null;
    let conversationId = previousConversationId || "";
    let gatewayChatId = previousConversationId ? chatIdForConversation(previousConversationId) : "";
    if (!conversationId) {
      const coreConversation = await createCoreConversationForPrompt(promptWithAttachments, modelSelection?.model || "");
      if (coreConversation) {
        coreCreatedConversation = coreConversation;
        conversationId = coreConversation.id;
        gatewayChatId = coreConversation.chatId || "";
      }
    }
    const optimisticConversationId = conversationId ? null : `optimistic-${crypto.randomUUID()}`;
    conversationId = conversationId || optimisticConversationId || "";
    if (!conversationId || activeRequestIdsByConversation[conversationId]) return false;
    const optimisticTimestamp = Math.floor(Date.now() / 1000);
    const shouldSendViaCore = isCoreConversationId(conversationId);
    if (!shouldSendViaCore) {
      gatewayChatId = gatewayChatId || `desktop-${crypto.randomUUID()}`;
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: promptWithAttachments,
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: Message = {
      id: assistantId,
      role: "assistant",
      content: "Thinking...",
      streaming: true,
    };
    setMessagesByConversation((current) => ({
      ...current,
      [conversationId]: [...(current[conversationId] || []), userMessage, assistantMessage],
    }));
    setConversationChatIdsByConversation((current) => ({ ...current, [conversationId]: gatewayChatId }));
    setActiveRequestIdsByConversation((current) => ({
      ...current,
      [conversationId]: userMessage.id,
    }));
    setInput("");
    if (optimisticConversationId || coreCreatedConversation) {
      const localConversation = coreCreatedConversation || optimisticConversationFromPrompt(
        conversationId,
        promptWithAttachments,
        optimisticTimestamp,
        optimisticTimestamp,
        gatewayChatId,
        modelSelection?.model || "",
      );
      setSelectedConversationId(conversationId);
      setConversationsByProfile((current) =>
        upsertConversationForProfile(current, profile, localConversation),
      );
      setConversationsLoadedByProfile((current) => ({ ...current, [profile]: true }));
      setHistoryErrorsByProfile((current) => ({ ...current, [profile]: null }));
    }

    try {
      const switchSelection =
        !previousConversationId && shouldSendModelSwitch(modelSelection, currentModelSelection)
          ? modelSelection
          : null;
      if (switchSelection && !shouldSendViaCore) {
        const hiddenMessageId = crypto.randomUUID();
        hiddenGatewayMessageIdsRef.current.add(hiddenMessageId);
        const switchResult = await sendHermesGatewayMessage(
          {
            text: modelCommand(switchSelection),
            chatId: gatewayChatId,
            chatName: conversationTitleFromPrompt(promptWithAttachments),
            messageId: hiddenMessageId,
            profile,
            userId: "agentui-user",
            userName: "Iris User",
            metadata: { hidden: true, kind: "model-switch" },
          },
          runtimeConfig,
          );
        if (!switchResult.ok) {
          throw new Error(switchResult.error || "Hermes did not accept the model switch.");
        }
      }
      const coreMetadata: Record<string, unknown> = {};
      if (gatewayChatId) coreMetadata.chatId = gatewayChatId;
      if (switchSelection) coreMetadata.modelSwitch = switchSelection;
      const result = shouldSendViaCore
        ? await sendAgentUICoreMessage(
            conversationId,
            {
              text: promptWithAttachments,
              attachments,
              model: modelSelection || null,
              clientMessageId: userMessage.id,
              metadata: coreMetadata,
            },
            runtimeConfig,
          )
        : await sendHermesGatewayMessage(
            {
              text: promptWithAttachments,
              chatId: gatewayChatId,
              chatName: conversationTitleFromPrompt(promptWithAttachments),
              messageId: userMessage.id,
              profile,
              userId: "agentui-user",
              userName: "Iris User",
            },
            runtimeConfig,
          );
      if (!result.ok) throw new Error(result.error || "Hermes gateway did not accept the message.");
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
          : "Hermes gateway chat is not available yet.";
      setActiveRequestIdsByConversation((current) => removeActiveRequestIds(current, conversationId));
      updateConversationMessage(conversationId, assistantId, (current) => ({
        ...current,
        content: message,
        streaming: false,
      }));
      setInput(prompt);
      return false;
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
      const result = await getHermesConversations(targetProfile, 80, runtimeConfig);
      if (targetProfile === profile) {
        setHistorySource(result.source || null);
        setHistorySchemaVersion(result.schemaVersion ?? null);
      }
      if (result.ok) {
        const endpointConversations = result.conversations || [];
        setConversationChatIdsByConversation((current) =>
          mergeConversationChatIdMap(current, endpointConversations),
        );
        const selectedChatId = selectedConversationId
          ? conversationChatIdsByConversation[selectedConversationId]
          : "";
        const selectedReplacement = selectedChatId
          ? endpointConversations.find((conversation) => conversation.chatId === selectedChatId)
          : null;
        if (
          selectedConversationId &&
          isOptimisticConversationId(selectedConversationId) &&
          selectedReplacement
        ) {
          setSelectedConversationId(selectedReplacement.id);
          setMessagesByConversation((current) =>
            migrateConversationMessages(current, selectedConversationId, selectedReplacement.id),
          );
          setModelSelectionByConversation((current) =>
            migrateModelSelection(current, selectedConversationId, selectedReplacement.id),
          );
          setActiveRequestIdsByConversation((current) =>
            migrateActiveRequestId(current, selectedConversationId, selectedReplacement.id),
          );
          setConversationChatIdsByConversation((current) => ({
            ...current,
            [selectedReplacement.id]: selectedReplacement.chatId || selectedChatId,
          }));
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
    options: { silent?: boolean; select?: boolean } = {},
  ) {
    if (!conversationId) return false;
    if (activeRequestIdsByConversationRef.current[conversationId] || isOptimisticConversationId(conversationId)) {
      setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
      return false;
    }
    if (!options.silent) {
      setConversationsLoadingByProfile((current) => ({ ...current, [profileName]: true }));
    }
    try {
      const result = await getHermesConversationDetail(profileName, conversationId, runtimeConfig);
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
      if (!activeRequestIdsByConversationRef.current[loadedConversation.id]) {
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

  async function createCoreConversationForPrompt(promptText: string, model = "") {
    try {
      const agentResult = await getAgentUICoreAgentForProfile(profile, runtimeConfig);
      if (!agentResult.ok || !agentResult.agent) return null;
      const created = await createAgentUICoreConversation(
        {
          agentId: agentResult.agent.id,
          title: conversationTitleFromPrompt(promptText),
          metadata: { model },
        },
        runtimeConfig,
      );
      if (!created.ok || !created.conversation) return null;
      return {
        id: created.conversation.id,
        source: "agentui-core",
        model,
        title: created.conversation.title,
        preview: compactConversationText(promptText, 180),
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
    const chatId = chatIdForConversation(conversationId);
    if (isCoreConversationId(conversationId)) {
      await cancelAgentUICoreMessage(conversationId, runtimeConfig);
    } else if (chatId) {
      await sendHermesGatewayMessage(
        {
          text: "/stop",
          chatId,
          chatName: "Iris",
          messageId: crypto.randomUUID(),
          profile,
          userId: "agentui-user",
          userName: "Iris User",
        },
        runtimeConfig,
      );
    }
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
      const hidden = booleanMetadata(delivery.metadata, "hidden") === true ||
        hiddenGatewayMessageIdsRef.current.has(replyTo);
      if (hidden) {
        processedInboxEventIdsRef.current.add(delivery.id);
        if (replyTo) hiddenGatewayMessageIdsRef.current.delete(replyTo);
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
        setActiveRequestIdsByConversation((current) =>
          removeActiveRequestIds(current, ...relatedConversationIds),
        );
      } else if (isFinalStreamDelivery) {
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

export const useHermesChat = useAgentUIChat;

function formatPromptWithAttachments(prompt: string, attachments: MessageAttachment[]) {
  if (!attachments.length) return prompt;
  const attachmentSummary = attachments
    .map((attachment, index) => {
      const type = attachment.mimeType || (attachment.kind === "image" ? "image" : "file");
      const size = attachment.size >= 0 ? formatAttachmentSize(attachment.size) : "size unknown";
      const path = attachment.path ? `, path: ${attachment.path}` : "";
      return `${index + 1}. ${attachment.name} (${type}, ${size}${path})`;
    })
    .join("\n");

  return [prompt || "Use the attached files as context.", `Attached files:\n${attachmentSummary}`].join("\n\n");
}

function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function toAppMessages(messages: HermesConversationMessage[]): Message[] {
  const normalized: Message[] = [];
  let pendingToolEvents: HermesStreamToolEvent[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      pendingToolEvents = message.toolCalls.reduce(
        (current, toolCall, index) =>
          mergeStreamToolEvent(current, streamToolEventFromHistoryCall(message, toolCall, index)),
        pendingToolEvents,
      );
      if (!message.content.trim()) {
        continue;
      }
    }

    if (message.role === "tool") {
      pendingToolEvents = mergeStreamToolEvent(pendingToolEvents, streamToolEventFromHistory(message));
      continue;
    }

    const appMessage = toAppMessage(message);
    if (appMessage.role === "assistant" && !appMessage.content.trim()) {
      continue;
    }

    if (appMessage.role === "assistant" && pendingToolEvents.length) {
      normalized.push({
        ...appMessage,
        streamEvents: pendingToolEvents,
      });
      pendingToolEvents = [];
      continue;
    }

    if (pendingToolEvents.length) {
      normalized.push(toolEventMessage(message.sessionId || message.id, pendingToolEvents));
      pendingToolEvents = [];
    }
    normalized.push(appMessage);
  }

  if (pendingToolEvents.length) {
    normalized.push(toolEventMessage("history-tools", pendingToolEvents));
  }

  return normalized;
}

function toolEventMessage(id: string, streamEvents: HermesStreamToolEvent[]): Message {
  return {
    id: `${id}-tool-events`,
    role: "assistant",
    content: "",
    streamEvents,
  };
}

function toAppMessage(message: HermesConversationMessage): Message {
  const content = message.role === "user"
    ? stripModelSwitchNote(message.content)
    : message.content;
  return {
    id: message.id,
    role: message.role,
    content: message.toolName ? `${message.toolName}\n${content}`.trim() : content,
  };
}

export function stripModelSwitchNote(content: string) {
  return content.replace(
    /^\s*\[Note:\s*model was just switched from [^\]]+\]\s*/i,
    "",
  );
}

function streamToolEventFromHistory(message: HermesConversationMessage): HermesStreamToolEvent {
  const parsed = parseHistoryToolPayload(message.content);
  const toolName = historyToolName(message, parsed);
  const status = historyToolStatus(parsed);

  return {
    id: message.id,
    callId: message.toolCallId || message.id,
    toolName,
    label: historyToolLabel(toolName, parsed),
    status,
    output: message.content,
  };
}

function streamToolEventFromHistoryCall(
  message: HermesConversationMessage,
  toolCall: HermesHistoryToolCall,
  index: number,
): HermesStreamToolEvent {
  const functionCall = toolCall.function || {};
  const toolName = stringValue(functionCall.name) || stringValue(toolCall.name) || "tool";
  const argumentsText = stringValue(functionCall.arguments) || stringValue(toolCall.arguments);
  const callId = stringValue(toolCall.call_id) || stringValue(toolCall.id) || `${message.id}-call-${index}`;

  return {
    id: callId,
    callId,
    toolName,
    label: historyToolLabel(toolName, parseHistoryToolPayload(argumentsText)),
    status: "running",
    arguments: argumentsText || undefined,
  };
}

function mergeStreamToolEvent(
  current: HermesStreamToolEvent[],
  next: HermesStreamToolEvent,
): HermesStreamToolEvent[] {
  const key = next.callId || next.id;
  const index = current.findIndex((event) => (event.callId || event.id) === key);
  if (index === -1) return [...current, next];
  return current.map((event, itemIndex) =>
    itemIndex === index
      ? {
          ...event,
          ...next,
          id: event.id || next.id,
          toolName: next.toolName === "tool" ? event.toolName : next.toolName,
          label: next.output && !next.arguments ? event.label : next.label || event.label,
          arguments: next.arguments || event.arguments,
          output: next.output || event.output,
        }
      : event,
  );
}

function parseHistoryToolPayload(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function historyToolName(message: HermesConversationMessage, data: Record<string, unknown> | null) {
  if (message.toolName) return message.toolName;
  if (!data) return "tool";
  if (isSkillViewPayload(data)) return "skill_view";
  if (stringValue(data.snapshot) || stringValue(data.url) || typeof data.element_count === "number") return "browser";
  if (
    stringValue(data.output) ||
    typeof data.exit_code === "number" ||
    typeof data.duration_seconds === "number" ||
    typeof data.tool_calls_made === "number"
  ) {
    return "terminal";
  }
  return stringValue(data.name) || "tool";
}

function historyToolLabel(toolName: string, data: Record<string, unknown> | null) {
  if (toolName === "skill_view") return skillDisplayName(data) || "skill";
  if (toolName === "terminal") {
    const command = stringValue(data?.command);
    return command ? `terminal: ${command}` : "terminal";
  }
  if (toolName === "browser") {
    const title = stringValue(data?.title);
    const url = stringValue(data?.url);
    return title && !/just a moment/i.test(title) ? `browser: ${title}` : url ? `browser: ${url}` : "browser";
  }
  return titleCase(toolName);
}

function historyToolStatus(data: Record<string, unknown> | null): HermesStreamToolEvent["status"] {
  if (!data) return "completed";
  const status = stringValue(data.status).toLowerCase();
  const error = data.error;
  const exitCode = typeof data.exit_code === "number" ? data.exit_code : null;
  if (
    status.includes("error") ||
    status.includes("fail") ||
    data.success === false ||
    (exitCode !== null && exitCode !== 0) ||
    (error !== null && error !== undefined && String(error).trim())
  ) {
    return "error";
  }
  return "completed";
}

function isSkillViewPayload(data: Record<string, unknown>) {
  return (
    data.success === true &&
    typeof data.name === "string" &&
    (typeof data.content === "string" || typeof data.file === "string" || typeof data.skill_dir === "string")
  );
}

function skillDisplayName(data: Record<string, unknown> | null) {
  const name = stringValue(data?.name);
  if (name) return name;
  const path = stringValue(data?.path);
  if (path) return parentOrLastPathSegment(path.split("/").filter(Boolean));
  const skillDir = stringValue(data?.skill_dir);
  if (skillDir) return lastPathSegment(skillDir.split(/[\\/]/).filter(Boolean));
  return "";
}

function parentOrLastPathSegment(parts: string[]) {
  return parts.length > 1 ? parts[parts.length - 2] : lastPathSegment(parts);
}

function lastPathSegment(parts: string[]) {
  return parts.length ? parts[parts.length - 1] : "";
}

function optimisticConversationFromPrompt(
  id: string,
  prompt: string,
  startedAt: number,
  lastActiveAt = startedAt,
  chatId = "",
  model = "",
): HermesConversation {
  const title = conversationTitleFromPrompt(prompt);
  return {
    id,
    source: "optimistic",
    model,
    title,
    preview: compactConversationText(prompt, 180) || title,
    chatId,
    origin: chatId ? { platform: "agentui", chat_id: chatId } : {},
    startedAt,
    endedAt: null,
    lastActiveAt,
    messageCount: id.startsWith("optimistic-") ? 1 : 2,
  };
}

export function shouldSendModelSwitch(
  selected: HermesModelSelection | null,
  current: HermesModelSelection | null,
) {
  if (!selected?.model) return false;
  if (!current?.model) return true;
  return selected.model !== current.model || selected.provider !== current.provider;
}

export function modelCommand(selection: HermesModelSelection) {
  const provider = selection.provider ? ` --provider ${selection.provider}` : "";
  return `/model ${selection.model}${provider}`;
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
      (!conversation.chatId || !endpointChatIds.has(conversation.chatId)),
  );
  return sortConversationsByActivity([...optimisticConversations, ...endpointConversations]);
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

function stringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

function booleanMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "boolean" ? value : null;
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

export function mergeStreamDelivery(
  existing: Message[],
  delivery: HermesInboxMessage,
  streamMessageId: string,
  finalized: boolean,
) {
  const content = delivery.content;
  const streaming = !finalized;
  const updateMessage = (message: Message): Message => ({
    ...message,
    id: message.id || streamMessageId,
    streamMessageId,
    content,
    streaming,
  });
  const streamIndex = existing.findIndex(
    (message) => message.streamMessageId === streamMessageId || message.id === streamMessageId,
  );
  if (streamIndex !== -1) {
    return existing.map((message, index) => (index === streamIndex ? updateMessage(message) : message));
  }

  const placeholderIndex = existing.findIndex(
    (message) => message.role === "assistant" && message.streaming && !message.streamMessageId,
  );
  const assistantMessage: Message = {
    id: streamMessageId,
    role: "assistant",
    content,
    streaming,
    streamMessageId,
  };
  if (placeholderIndex !== -1) {
    return coalescePostStreamAttachments(existing.map((message, index) => (index === placeholderIndex ? assistantMessage : message)));
  }
  return coalescePostStreamAttachments([...existing, assistantMessage]);
}

export function mergeCompletedDelivery(
  existing: Message[],
  delivery: HermesInboxMessage,
  replyTo: string,
) {
  const streamingIndex = lastStreamingAssistantIndex(existing);
  if (streamingIndex === -1) {
    if (duplicateCompletedDeliveryIndex(existing, delivery, replyTo) !== -1) {
      return coalescePostStreamAttachments(existing);
    }

    const attachIndex = postStreamAttachmentIndex(existing, delivery);
    if (attachIndex !== -1) {
      return coalescePostStreamAttachments(
        existing.map((message, index) =>
          index === attachIndex
            ? {
                ...message,
                content: appendMessageContent(message.content, delivery.content),
              }
            : message,
        ),
      );
    }

    const assistantMessage: Message = {
      id: delivery.id,
      role: "assistant",
      content: delivery.content,
      streaming: false,
    };
    return coalescePostStreamAttachments([
      ...existing,
      assistantMessage,
    ]);
  }

  return coalescePostStreamAttachments(
    existing.map((message, index) =>
      index === streamingIndex
        ? {
            ...message,
            id: delivery.id,
            content: delivery.content,
            streaming: false,
          }
        : message,
    ),
  );
}

function lastStreamingAssistantIndex(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.streaming) return index;
  }
  return -1;
}

function postStreamAttachmentIndex(messages: Message[], delivery: HermesInboxMessage) {
  if (delivery.source !== "hermes-gateway" || !delivery.content.trim()) return -1;
  if (!isPostStreamAttachmentContent(delivery.content)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return -1;
    if (message.role === "assistant" && message.streamMessageId) return index;
  }
  return -1;
}

function duplicateCompletedDeliveryIndex(messages: Message[], delivery: HermesInboxMessage, replyTo: string) {
  const content = normalizeMessageContent(delivery.content);
  if (!content || isPostStreamAttachmentContent(delivery.content)) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return -1;
    if (message.role !== "assistant") continue;
    const canCoalesce = Boolean(message.streamMessageId || replyTo);
    if (canCoalesce && normalizeMessageContent(message.content) === content) return index;
  }
  return -1;
}

function normalizeMessageContent(content: string) {
  return content.trim().split("\n").map((line) => line.trimEnd()).join("\n");
}

function appendMessageContent(content: string, addition: string) {
  const left = content.trimEnd();
  const right = addition.trim();
  if (!left) return right;
  if (!right || left.includes(right)) return left;
  return `${left}\n\n${right}`;
}

export function coalescePostStreamAttachments(messages: Message[]) {
  const coalesced: Message[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const next = messages[index + 1];

    if (isPostStreamAttachmentMessage(message) && next && next.role === "assistant" && next.streamMessageId) {
      coalesced.push({
        ...next,
        content: appendMessageContent(next.content, message.content),
      });
      index += 1;
      continue;
    }

    if (message.role === "assistant" && message.streamMessageId && next && isPostStreamAttachmentMessage(next)) {
      coalesced.push({
        ...message,
        content: appendMessageContent(message.content, next.content),
      });
      index += 1;
      continue;
    }

    coalesced.push(message);
  }
  return coalesced;
}

function isPostStreamAttachmentMessage(message: Message) {
  return message.role === "assistant" && isPostStreamAttachmentContent(message.content);
}

function isPostStreamAttachmentContent(content: string) {
  const trimmed = content.trim();
  return (
    /^(?:🖼️\s*)?Image:\s+/i.test(trimmed) ||
    /^(?:📎\s*)?File:\s+/i.test(trimmed) ||
    /^Media:\s+/i.test(trimmed)
  );
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

function mergeMessageLists(primary: Message[], secondary: Message[]) {
  const byId = new Set(primary.map((message) => message.id));
  const merged = [...primary];
  for (const message of secondary) {
    if (byId.has(message.id)) continue;
    byId.add(message.id);
    merged.push(message);
  }
  return merged;
}

function migrateActiveRequestId(
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
  const ids = new Set(conversationIds.filter(Boolean));
  if (!ids.size) return current;
  return Object.fromEntries(Object.entries(current).filter(([conversationId]) => !ids.has(conversationId)));
}

function sortConversationsByActivity(conversations: HermesConversation[]) {
  return [...conversations].sort(
    (left, right) => conversationTimestamp(right) - conversationTimestamp(left),
  );
}

function conversationTimestamp(conversation: HermesConversation) {
  return conversation.lastActiveAt || conversation.startedAt || 0;
}

function conversationTitleFromPrompt(prompt: string) {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return compactConversationText(firstLine || "New conversation", 90);
}

function compactConversationText(value: string, maxLength: number) {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function isTransientConversationLoadError(message?: string | null) {
  return typeof message === "string" && message.toLowerCase().includes("unable to open database file");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}
