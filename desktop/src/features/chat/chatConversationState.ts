import type { Message } from "../../app/types";
import type {
  HermesConversation,
  HermesConversationMessage,
  HermesModelSelection,
} from "../../types/hermes";
import { compactText } from "../../shared/strings";
import type { PendingProfileConversationSelection } from "./chatTypes";
import { booleanMetadata, stringMetadata } from "./chatHistory";
import { mergeMessageLists } from "./chatStreamMerging";

export function shouldSendModelSwitch(
  selected: HermesModelSelection | null,
  current: HermesModelSelection | null,
) {
  if (!selected?.model) return false;
  if (!current?.model) return true;
  return selected.model !== current.model || selected.provider !== current.provider;
}

export function selectionFromConversation(conversation: HermesConversation | null): HermesModelSelection | null {
  if (!conversation?.model) return null;
  return { provider: "", model: conversation.model };
}

export function migrateModelSelection(
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

export function upsertConversationForProfile(
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

export function removeConversationForProfile(
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

export function removeConversationsForProfile(
  current: Record<string, HermesConversation[]>,
  profile: string,
  conversationIds: string[],
) {
  const ids = new Set(conversationIds.filter(Boolean));
  if (!ids.size) return current;
  const conversations = current[profile] || [];
  const filtered = conversations.filter((item) => !ids.has(item.id));
  if (filtered.length === conversations.length) return current;
  return { ...current, [profile]: filtered };
}

export function mergeOptimisticConversations(
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

export function mergeConversationReadStates(
  current: Record<string, "read" | "unread">,
  conversations: HermesConversation[],
) {
  const next = { ...current };
  for (const conversation of conversations) {
    const state = conversation.readState?.state;
    if (state === "read" || state === "unread") next[conversation.id] = state;
  }
  return next;
}

export function updateConversationReadStateForProfiles(
  current: Record<string, HermesConversation[]>,
  conversationId: string,
  state: "read" | "unread",
) {
  let changed = false;
  const next: Record<string, HermesConversation[]> = {};
  for (const [profileName, conversations] of Object.entries(current)) {
    next[profileName] = conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      changed = true;
      return {
        ...conversation,
        readState: {
          ...(conversation.readState || {
            conversationId,
            createdAt: null,
            updatedAt: null,
            metadata: {},
          }),
          conversationId,
          state,
        },
      };
    });
  }
  return changed ? next : current;
}

export function preserveActiveConversationTitles(
  endpointConversations: HermesConversation[],
  currentConversations: HermesConversation[],
  activeRequestIdsByConversation: Record<string, string>,
  activeTitlesByConversation: Record<string, string>,
  chatIdsByConversation: Record<string, string>,
) {
  const preservedTitles = new Map<string, string>();
  for (const conversation of currentConversations) {
    const localTitle = conversation.title || "";
    if (!localTitle || isPlaceholderConversationTitle(localTitle)) continue;
    preservedTitles.set(`id:${conversation.id}`, localTitle);
    if (conversation.chatId) preservedTitles.set(`chat:${conversation.chatId}`, localTitle);
  }

  for (const conversationId of Object.keys(activeRequestIdsByConversation)) {
    const localConversation = currentConversations.find((conversation) => conversation.id === conversationId);
    const localConversationTitle = localConversation?.title || "";
    const localTitle = localConversationTitle && !isPlaceholderConversationTitle(localConversationTitle)
      ? localConversationTitle
      : activeTitlesByConversation[conversationId] || "";
    if (!localTitle || isPlaceholderConversationTitle(localTitle)) continue;
    preservedTitles.set(`id:${conversationId}`, localTitle);
    if (localConversation?.id) preservedTitles.set(`id:${localConversation.id}`, localTitle);
    const chatId = chatIdsByConversation[conversationId] || localConversation?.chatId || "";
    if (chatId) preservedTitles.set(`chat:${chatId}`, localTitle);
  }

  if (!preservedTitles.size) return endpointConversations;
  return endpointConversations.map((conversation) => {
    if (!isPlaceholderConversationTitle(conversation.title)) return conversation;
    const preservedTitle = preservedTitles.get(`id:${conversation.id}`) ||
      (conversation.chatId ? preservedTitles.get(`chat:${conversation.chatId}`) : "");
    return preservedTitle ? { ...conversation, title: preservedTitle } : conversation;
  });
}

export function preserveLocalConversationProjectMetadata(
  endpointConversations: HermesConversation[],
  currentConversations: HermesConversation[],
) {
  const projectMetadata = new Map<string, Record<string, unknown>>();
  for (const conversation of currentConversations) {
    const metadata = conversation.metadata || {};
    if (!conversationProjectId(conversation)) continue;
    projectMetadata.set(`id:${conversation.id}`, metadata);
    if (conversation.chatId) projectMetadata.set(`chat:${conversation.chatId}`, metadata);
  }
  if (!projectMetadata.size) return endpointConversations;
  return endpointConversations.map((conversation) => {
    if (conversationProjectId(conversation)) return conversation;
    const metadata = projectMetadata.get(`id:${conversation.id}`) ||
      (conversation.chatId ? projectMetadata.get(`chat:${conversation.chatId}`) : undefined) ||
      currentConversations.find((current) => conversationsLikelyMatch(current, conversation) && conversationProjectId(current))?.metadata;
    return metadata ? { ...conversation, metadata: { ...(conversation.metadata || {}), ...metadata } } : conversation;
  });
}

export function replacementForOptimisticConversation(
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

function conversationProjectId(conversation: HermesConversation) {
  const metadata = conversation.metadata || {};
  const project = metadata.project;
  if (typeof metadata.projectId === "string" && metadata.projectId) return metadata.projectId;
  if (project && typeof project === "object" && !Array.isArray(project)) {
    const id = (project as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

function normalizeConversationLabel(value: string | null | undefined) {
  return (value || "").trim();
}

function conversationActivityTimestamp(conversation: HermesConversation) {
  return conversation.lastActiveAt || conversation.startedAt || 0;
}

export function isOptimisticConversation(conversation: HermesConversation) {
  return conversation.source === "optimistic" || isOptimisticConversationId(conversation.id);
}

export function isOptimisticConversationId(conversationId: string) {
  return conversationId.startsWith("optimistic-");
}

export function isCoreConversationId(conversationId: string) {
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

export function visibleConversationForSelection(
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

export function preserveLocalScheduledDeliveries(
  historyMessages: Message[],
  localMessages: Message[],
) {
  const historyIds = new Set(historyMessages.map((message) => message.id));
  const historyContent = new Set(
    historyMessages.map((message) => message.content.trim()).filter(Boolean),
  );
  const localDeliveries = localMessages.filter((message) =>
    message.source === "hermes-cron" &&
    message.role === "assistant" &&
    !message.streaming &&
    !historyIds.has(message.id) &&
    !historyContent.has(message.content.trim()),
  );
  if (!localDeliveries.length) return historyMessages;

  let pendingHistory = [...historyMessages];
  const merged: Message[] = [];
  for (const localMessage of localMessages) {
    if (localDeliveries.includes(localMessage)) {
      merged.push(localMessage);
      continue;
    }
    const historyIndex = pendingHistory.findIndex((historyMessage) =>
      messagesLikelyRepresentSameTurn(historyMessage, localMessage),
    );
    if (historyIndex === -1) continue;
    merged.push(...pendingHistory.slice(0, historyIndex + 1));
    pendingHistory = pendingHistory.slice(historyIndex + 1);
  }
  merged.push(...pendingHistory);
  return mergeMessageLists([], merged);
}

function messagesLikelyRepresentSameTurn(left: Message, right: Message) {
  if (left.id === right.id) return true;
  return left.role === right.role &&
    left.content.trim() === right.content.trim() &&
    attachmentIds(left).join("|") === attachmentIds(right).join("|");
}

function attachmentIds(message: Message) {
  return (message.attachments || []).map((attachment) => attachment.id).sort();
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

export function conversationIdsForChatId(
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

export function mergeRelatedConversationMessages(
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

export function setConversationMessages(
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

export function migrateConversationMessages(
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

export function migrateActiveRequestId(
  current: Record<string, string>,
  fromConversationId: string,
  toConversationId: string,
) {
  return migrateConversationValue(current, fromConversationId, toConversationId);
}

export function migrateConversationValue(
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

export function removeActiveRequestIds(
  current: Record<string, string>,
  ...conversationIds: Array<string | null | undefined>
) {
  return removeConversationValues(current, ...conversationIds);
}

export function removeConversationValues<T>(
  current: Record<string, T>,
  ...conversationIds: Array<string | null | undefined>
) {
  const ids = new Set(conversationIds.filter(Boolean));
  if (!ids.size) return current;
  return Object.fromEntries(Object.entries(current).filter(([conversationId]) => !ids.has(conversationId)));
}

export function removeModelSelections(
  current: Record<string, HermesModelSelection>,
  ...conversationIds: Array<string | null | undefined>
) {
  return removeConversationValues(current, ...conversationIds);
}

export function removeReadStates(
  current: Record<string, "read" | "unread">,
  ...conversationIds: Array<string | null | undefined>
) {
  return removeConversationValues(current, ...conversationIds);
}

export function sortConversationsByActivity(conversations: HermesConversation[]) {
  return [...conversations].sort(
    (left, right) => conversationTimestamp(right) - conversationTimestamp(left),
  );
}

export function optimisticConversationFromPrompt(
  conversationId: string,
  prompt: string,
  startedAt: number,
  lastActiveAt: number,
  chatId: string,
  model: string,
  projectId: string | null = null,
): HermesConversation {
  return {
    id: conversationId,
    source: "optimistic",
    model,
    title: conversationTitleFromPrompt(prompt),
    preview: compactText(prompt, 180),
    chatId,
    origin: {},
    metadata: projectId ? { projectId } : {},
    startedAt,
    endedAt: null,
    lastActiveAt,
    messageCount: 1,
  };
}

function conversationTimestamp(conversation: HermesConversation) {
  return conversation.lastActiveAt || conversation.startedAt || 0;
}

export function conversationTitleFromPrompt(prompt: string) {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const attachmentTitle = titleFromAttachmentSummary(firstLine || "");
  if (attachmentTitle) return attachmentTitle;
  return compactText(firstLine || "New session", 90);
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
