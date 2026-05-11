import type { Message } from "../../app/types";
import type {
  HermesSession,
  HermesSessionMessage,
  HermesModelSelection,
} from "../../types/hermes";
import { compactText } from "../../shared/strings";
import type { PendingProfileSessionSelection } from "./chatTypes";
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

export function selectionFromSession(session: HermesSession | null): HermesModelSelection | null {
  if (!session?.model) return null;
  return { provider: "", model: session.model };
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

export function upsertSessionForProfile(
  current: Record<string, HermesSession[]>,
  profile: string,
  session: HermesSession,
) {
  return {
    ...current,
    [profile]: sortSessionsByActivity([
      session,
      ...(current[profile] || []).filter((item) => item.id !== session.id),
    ]),
  };
}

export function removeSessionForProfile(
  current: Record<string, HermesSession[]>,
  profile: string,
  sessionId: string,
) {
  if (!sessionId) return current;
  const sessions = current[profile] || [];
  const filtered = sessions.filter((item) => item.id !== sessionId);
  if (filtered.length === sessions.length) return current;
  return { ...current, [profile]: filtered };
}

export function removeSessionsForProfile(
  current: Record<string, HermesSession[]>,
  profile: string,
  sessionIds: string[],
) {
  const ids = new Set(sessionIds.filter(Boolean));
  if (!ids.size) return current;
  const sessions = current[profile] || [];
  const filtered = sessions.filter((item) => !ids.has(item.id));
  if (filtered.length === sessions.length) return current;
  return { ...current, [profile]: filtered };
}

export function sessionMetadataShouldPropagate(title: string | null | undefined) {
  const normalized = (title || "").trim();
  if (!normalized) return false;
  return !isPlaceholderSessionTitle(normalized);
}

export function scheduleDedupedTimer(options: {
  key: string;
  pending: Set<string>;
  delayMs: number;
  run: () => Promise<void> | void;
}) {
  const { key, pending, delayMs, run } = options;
  if (!key) return false;
  if (pending.has(key)) return false;
  pending.add(key);
  setTimeout(async () => {
    try {
      await run();
    } catch {
      // Best-effort scheduler: callers must not crash the scheduler if their
      // run() throws. The pending key is still cleared in finally.
    } finally {
      pending.delete(key);
    }
  }, delayMs);
  return true;
}

export function upsertSessionMetadataForProfile(
  current: Record<string, HermesSession[]>,
  profile: string,
  loadedSession: HermesSession,
) {
  const sessions = current[profile] || [];
  let matched = false;
  const updated = sessions.map((session) => {
    const matches = session.id === loadedSession.id ||
      (Boolean(loadedSession.chatId) && session.chatId === loadedSession.chatId);
    if (!matches) return session;
    matched = true;
    return {
      ...session,
      title: loadedSession.title || session.title,
      preview: loadedSession.preview || session.preview,
      lastActiveAt: loadedSession.lastActiveAt ?? session.lastActiveAt,
      metadata: {
        ...(session.metadata || {}),
        ...(loadedSession.metadata || {}),
      },
    };
  });
  if (!matched) return current;
  return { ...current, [profile]: updated };
}

export function mergeOptimisticSessions(
  current: HermesSession[],
  endpointSessions: HermesSession[],
) {
  const endpointIds = new Set(endpointSessions.map((session) => session.id));
  const endpointChatIds = new Set(endpointSessions.map((session) => session.chatId).filter(Boolean));
  const optimisticSessions = current.filter(
    (session) =>
      isOptimisticSession(session) &&
      !endpointIds.has(session.id) &&
      (!session.chatId || !endpointChatIds.has(session.chatId)) &&
      !endpointSessions.some((endpointSession) =>
        sessionsLikelyMatch(session, endpointSession),
      ),
  );
  return sortSessionsByActivity([...optimisticSessions, ...endpointSessions]);
}

export function mergeSessionReadStates(
  current: Record<string, "read" | "unread">,
  sessions: HermesSession[],
) {
  const next = { ...current };
  for (const session of sessions) {
    const state = session.readState?.state;
    if (state === "read" || state === "unread") next[session.id] = state;
  }
  return next;
}

export function updateSessionReadStateForProfiles(
  current: Record<string, HermesSession[]>,
  sessionId: string,
  state: "read" | "unread",
) {
  let changed = false;
  const next: Record<string, HermesSession[]> = {};
  for (const [profileName, sessions] of Object.entries(current)) {
    next[profileName] = sessions.map((session) => {
      if (session.id !== sessionId) return session;
      changed = true;
      return {
        ...session,
        readState: {
          ...(session.readState || {
            sessionId,
            createdAt: null,
            updatedAt: null,
            metadata: {},
          }),
          sessionId,
          state,
        },
      };
    });
  }
  return changed ? next : current;
}

export function preserveActiveSessionTitles(
  endpointSessions: HermesSession[],
  currentSessions: HermesSession[],
  activeRequestIdsBySession: Record<string, string>,
  activeTitlesBySession: Record<string, string>,
  chatIdsBySession: Record<string, string>,
) {
  const preservedTitles = new Map<string, string>();
  for (const session of currentSessions) {
    const localTitle = session.title || "";
    if (!localTitle || isPlaceholderSessionTitle(localTitle)) continue;
    preservedTitles.set(`id:${session.id}`, localTitle);
    if (session.chatId) preservedTitles.set(`chat:${session.chatId}`, localTitle);
  }

  for (const sessionId of Object.keys(activeRequestIdsBySession)) {
    const localSession = currentSessions.find((session) => session.id === sessionId);
    const localSessionTitle = localSession?.title || "";
    const localTitle = localSessionTitle && !isPlaceholderSessionTitle(localSessionTitle)
      ? localSessionTitle
      : activeTitlesBySession[sessionId] || "";
    if (!localTitle || isPlaceholderSessionTitle(localTitle)) continue;
    preservedTitles.set(`id:${sessionId}`, localTitle);
    if (localSession?.id) preservedTitles.set(`id:${localSession.id}`, localTitle);
    const chatId = chatIdsBySession[sessionId] || localSession?.chatId || "";
    if (chatId) preservedTitles.set(`chat:${chatId}`, localTitle);
  }

  if (!preservedTitles.size) return endpointSessions;
  return endpointSessions.map((session) => {
    if (!isPlaceholderSessionTitle(session.title)) return session;
    const preservedTitle = preservedTitles.get(`id:${session.id}`) ||
      (session.chatId ? preservedTitles.get(`chat:${session.chatId}`) : "");
    return preservedTitle ? { ...session, title: preservedTitle } : session;
  });
}

export function preserveLocalSessionProjectMetadata(
  endpointSessions: HermesSession[],
  currentSessions: HermesSession[],
) {
  const projectMetadata = new Map<string, Record<string, unknown>>();
  for (const session of currentSessions) {
    const metadata = session.metadata || {};
    if (!sessionProjectId(session)) continue;
    projectMetadata.set(`id:${session.id}`, metadata);
    if (session.chatId) projectMetadata.set(`chat:${session.chatId}`, metadata);
  }
  if (!projectMetadata.size) return endpointSessions;
  return endpointSessions.map((session) => {
    if (sessionProjectId(session)) return session;
    const metadata = projectMetadata.get(`id:${session.id}`) ||
      (session.chatId ? projectMetadata.get(`chat:${session.chatId}`) : undefined) ||
      currentSessions.find((current) => sessionsLikelyMatch(current, session) && sessionProjectId(current))?.metadata;
    return metadata ? { ...session, metadata: { ...(session.metadata || {}), ...metadata } } : session;
  });
}

export function replacementForOptimisticSession(
  sessionId: string,
  endpointSessions: HermesSession[],
  currentSessions: HermesSession[],
  selectedChatId = "",
) {
  if (!isOptimisticSessionId(sessionId)) return null;
  if (selectedChatId) {
    const chatMatch = endpointSessions.find((session) => session.chatId === selectedChatId);
    if (chatMatch) return chatMatch;
  }
  const optimisticSession = currentSessions.find((session) => session.id === sessionId);
  if (!optimisticSession) return null;
  return endpointSessions.find((session) =>
    sessionsLikelyMatch(optimisticSession, session),
  ) || null;
}

export function activeSessionReplacements(
  activeRequestIdsBySession: Record<string, string>,
  endpointSessions: HermesSession[],
  currentSessions: HermesSession[],
  chatIdsBySession: Record<string, string>,
) {
  const replacements: Array<{ fromId: string; to: HermesSession; chatId: string }> = [];
  const endpointIds = new Set(endpointSessions.map((session) => session.id));
  const claimedIds = new Set<string>();
  for (const sessionId of Object.keys(activeRequestIdsBySession)) {
    if (endpointIds.has(sessionId)) continue;
    const chatId = chatIdsBySession[sessionId] ||
      currentSessions.find((session) => session.id === sessionId)?.chatId ||
      "";
    if (!chatId) continue;
    const replacement = endpointSessions.find(
      (session) => session.chatId === chatId && !claimedIds.has(session.id),
    );
    if (!replacement) continue;
    claimedIds.add(replacement.id);
    replacements.push({ fromId: sessionId, to: replacement, chatId });
  }
  return replacements;
}

function isPlaceholderSessionTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  return normalized === "untitled session" ||
    normalized === "untitled session" ||
    normalized === "new session";
}

function sessionsLikelyMatch(left: HermesSession, right: HermesSession) {
  if (isOptimisticSession(right)) return false;
  if (left.chatId && right.chatId && left.chatId === right.chatId) return true;
  const leftTitle = normalizeSessionLabel(left.title);
  const rightTitle = normalizeSessionLabel(right.title);
  const leftPreview = normalizeSessionLabel(left.preview);
  const rightPreview = normalizeSessionLabel(right.preview);
  const labelMatches = Boolean(
    (leftTitle && leftTitle === rightTitle) ||
    (leftPreview && leftPreview === rightPreview) ||
    (leftTitle && rightPreview && leftTitle === rightPreview) ||
    (leftPreview && rightTitle && leftPreview === rightTitle),
  );
  if (!labelMatches) return false;
  return sessionActivityTimestamp(right) >= sessionActivityTimestamp(left) - 2;
}

function sessionProjectId(session: HermesSession) {
  const metadata = session.metadata || {};
  const project = metadata.project;
  if (typeof metadata.projectId === "string" && metadata.projectId) return metadata.projectId;
  if (project && typeof project === "object" && !Array.isArray(project)) {
    const id = (project as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

function normalizeSessionLabel(value: string | null | undefined) {
  return (value || "").trim();
}

function sessionActivityTimestamp(session: HermesSession) {
  return session.lastActiveAt || session.startedAt || 0;
}

export function isOptimisticSession(session: HermesSession) {
  return session.source === "optimistic" || isOptimisticSessionId(session.id);
}

export function isOptimisticSessionId(sessionId: string) {
  return sessionId.startsWith("optimistic-");
}

export function isCoreSessionId(sessionId: string) {
  return sessionId.startsWith("session_");
}

export function mergeSessionChatIdMap(
  current: Record<string, string>,
  sessions: Pick<HermesSession, "id" | "chatId">[],
) {
  let changed = false;
  const next = { ...current };
  for (const session of sessions) {
    if (!session.chatId || current[session.id] === session.chatId) continue;
    next[session.id] = session.chatId;
    changed = true;
  }
  return changed ? next : current;
}

export function shouldRetryUnmappedDelivery(attempts: number, maxAttempts = 2) {
  return attempts < maxAttempts;
}

export function visibleSessionForSelection(
  selectedSessionId: string | null,
  sessions: HermesSession[],
  chatIdsBySession: Record<string, string>,
  messagesBySession: Record<string, Message[]>,
) {
  if (!selectedSessionId) return null;
  if (messagesBySession[selectedSessionId]?.length) return selectedSessionId;

  const selectedChatId =
    chatIdsBySession[selectedSessionId] ||
    sessions.find((session) => session.id === selectedSessionId)?.chatId ||
    "";
  if (!selectedChatId) return selectedSessionId;

  const fallback = Object.entries(chatIdsBySession).find(
    ([sessionId, chatId]) =>
      sessionId !== selectedSessionId &&
      chatId === selectedChatId &&
      Boolean(messagesBySession[sessionId]?.length),
  );
  return fallback?.[0] || selectedSessionId;
}

export function shouldPreserveProfileSessionSelection(
  profile: string,
  selectedSessionId: string | null,
  pendingSelection: PendingProfileSessionSelection | null,
) {
  return Boolean(
    selectedSessionId &&
      pendingSelection &&
      pendingSelection.profile === profile &&
      pendingSelection.sessionId === selectedSessionId,
  );
}

export function shouldApplySessionDetailSelection(
  selectedSessionId: string | null,
  selectedChatId: string,
  requestedSessionId: string,
  loadedSession: Pick<HermesSession, "id" | "chatId">,
) {
  return Boolean(
    selectedSessionId &&
      (selectedSessionId === requestedSessionId ||
        selectedSessionId === loadedSession.id ||
        Boolean(loadedSession.chatId && selectedChatId === loadedSession.chatId)),
  );
}

export function shouldSkipSessionDetailLoad(
  sessionId: string,
  activeRequestIdsBySession: Record<string, string>,
) {
  return Boolean(activeRequestIdsBySession[sessionId] || isOptimisticSessionId(sessionId));
}

export function shouldPreserveLocalMessagesOnEmptyHistory(
  localMessages: Message[],
  historyMessages: HermesSessionMessage[],
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
  if (left.role !== right.role) return false;
  if (left.clientRequestId && left.clientRequestId === right.clientRequestId) return true;
  return left.content.trim() === right.content.trim() &&
    attachmentIds(left).join("|") === attachmentIds(right).join("|");
}

function attachmentIds(message: Message) {
  return (message.attachments || []).map((attachment) => attachment.id).sort();
}

export function activeRequestCompletedByHistory(
  historyMessages: HermesSessionMessage[],
  activeRequestId: string,
) {
  if (!activeRequestId) return false;
  let sawActiveUser = false;
  return historyMessages.some((message) => {
    const metadata = message.metadata || {};
    if (
      message.role === "user" &&
      (message.id === activeRequestId || metadataReferencesRequest(metadata, activeRequestId))
    ) {
      sawActiveUser = true;
      return false;
    }
    if (!sawActiveUser) return false;
    if (message.role !== "assistant" || message.status !== "completed" || !message.content.trim()) return false;
    if (historyMessageStillStreaming(metadata)) return false;
    const replyTo = stringMetadata(metadata, "replyTo") || stringMetadata(metadata, "reply_to");
    return replyTo === activeRequestId || metadataReferencesRequest(metadata, activeRequestId);
  });
}

function metadataReferencesRequest(metadata: Record<string, unknown>, activeRequestId: string) {
  return [
    "clientMessageId",
    "client_message_id",
    "idempotencyKey",
    "idempotency_key",
    "agentuiMessageId",
  ].some((key) => stringMetadata(metadata, key) === activeRequestId);
}

function historyMessageStillStreaming(metadata: Record<string, unknown>) {
  if (booleanMetadata(metadata, "streaming") === true) return true;
  if (booleanMetadata(metadata, "finalize") === false || booleanMetadata(metadata, "final") === false) return true;
  return false;
}

export function sessionIdsForChatId(
  chatId: string,
  fallbackSessionId: string,
  chatIdsBySession: Record<string, string>,
) {
  const ids = Object.entries(chatIdsBySession)
    .filter(([, mappedChatId]) => mappedChatId === chatId)
    .map(([sessionId]) => sessionId);
  if (!ids.includes(fallbackSessionId)) ids.push(fallbackSessionId);
  return ids;
}

export function mergeRelatedSessionMessages(
  current: Record<string, Message[]>,
  sessionIds: string[],
) {
  const orderedIds = [...sessionIds].sort((left, right) => {
    const leftHasUser = current[left]?.some((message) => message.role === "user") ? 1 : 0;
    const rightHasUser = current[right]?.some((message) => message.role === "user") ? 1 : 0;
    if (leftHasUser !== rightHasUser) return rightHasUser - leftHasUser;
    const leftOptimistic = isOptimisticSessionId(left) ? 1 : 0;
    const rightOptimistic = isOptimisticSessionId(right) ? 1 : 0;
    return rightOptimistic - leftOptimistic;
  });
  return orderedIds.reduce<Message[]>(
    (messages, sessionId) => mergeMessageLists(messages, current[sessionId] || []),
    [],
  );
}

export function setSessionMessages(
  current: Record<string, Message[]>,
  relatedSessionIds: string[],
  targetSessionId: string,
  messages: Message[],
) {
  const next = { ...current };
  for (const sessionId of relatedSessionIds) {
    if (sessionId !== targetSessionId) delete next[sessionId];
  }
  next[targetSessionId] = messages;
  return next;
}

export function migrateSessionMessages(
  current: Record<string, Message[]>,
  fromSessionId: string,
  toSessionId: string,
) {
  if (fromSessionId === toSessionId) return current;
  const next = { ...current };
  const fromMessages = next[fromSessionId] || [];
  delete next[fromSessionId];
  next[toSessionId] = mergeMessageLists(fromMessages, next[toSessionId] || []);
  return next;
}

export function migrateActiveRequestId(
  current: Record<string, string>,
  fromSessionId: string,
  toSessionId: string,
) {
  return migrateSessionValue(current, fromSessionId, toSessionId);
}

export function migrateSessionValue<T>(
  current: Record<string, T>,
  fromSessionId: string,
  toSessionId: string,
) {
  if (fromSessionId === toSessionId || !current[fromSessionId]) return current;
  const next = { ...current };
  next[toSessionId] = next[fromSessionId];
  delete next[fromSessionId];
  return next;
}

export function removeActiveRequestIds(
  current: Record<string, string>,
  ...sessionIds: Array<string | null | undefined>
) {
  return removeSessionValues(current, ...sessionIds);
}

export function removeSessionValues<T>(
  current: Record<string, T>,
  ...sessionIds: Array<string | null | undefined>
) {
  const ids = new Set(sessionIds.filter(Boolean));
  if (!ids.size) return current;
  return Object.fromEntries(Object.entries(current).filter(([sessionId]) => !ids.has(sessionId)));
}

export function removeModelSelections(
  current: Record<string, HermesModelSelection>,
  ...sessionIds: Array<string | null | undefined>
) {
  return removeSessionValues(current, ...sessionIds);
}

export function removeReadStates(
  current: Record<string, "read" | "unread">,
  ...sessionIds: Array<string | null | undefined>
) {
  return removeSessionValues(current, ...sessionIds);
}

export function sortSessionsByActivity(sessions: HermesSession[]) {
  return [...sessions].sort(
    (left, right) => sessionTimestamp(right) - sessionTimestamp(left),
  );
}

export function optimisticSessionFromPrompt(
  sessionId: string,
  prompt: string,
  startedAt: number,
  lastActiveAt: number,
  chatId: string,
  model: string,
  projectId: string | null = null,
): HermesSession {
  return {
    id: sessionId,
    source: "optimistic",
    model,
    title: sessionTitleFromPrompt(prompt),
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

function sessionTimestamp(session: HermesSession) {
  return session.lastActiveAt || session.startedAt || 0;
}

export function sessionTitleFromPrompt(prompt: string) {
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

export function isTransientSessionLoadError(message?: string | null) {
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
