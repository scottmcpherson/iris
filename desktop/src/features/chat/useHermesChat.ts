import { useEffect, useState } from "react";
import type { Message, MessageAttachment } from "../../app/types";
import {
  cancelHermesMessage,
  getHermesConversationDetail,
  getHermesConversations,
  streamHermesMessage,
} from "../../lib/hermes";
import type {
  HermesConversation,
  HermesConversationMessage,
  HermesHistoryToolCall,
  HermesRuntimeConfig,
  HermesStreamEvent,
  HermesStreamToolEvent,
} from "../../types/hermes";

type UseHermesChatOptions = {
  profile: string;
  runtimeConfig: HermesRuntimeConfig;
};

export function useHermesChat({ profile, runtimeConfig }: UseHermesChatOptions) {
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
  const conversations = conversationsByProfile[profile] || [];
  const conversationsLoading = Boolean(conversationsLoadingByProfile[profile]);
  const historyError = historyErrorsByProfile[profile] || null;
  const messages = selectedConversationId ? messagesByConversation[selectedConversationId] || [] : [];
  const activeRequestId = selectedConversationId
    ? activeRequestIdsByConversation[selectedConversationId] || null
    : null;

  useEffect(() => {
    startNewConversation();
    void refreshConversations();
  }, [profile]);

  async function sendMessage(attachments: MessageAttachment[] = []) {
    const prompt = input.trim();
    if (!prompt && !attachments.length) return;
    const promptWithAttachments = formatPromptWithAttachments(prompt, attachments);
    const previousConversationId = selectedConversationId;
    const optimisticConversationId = previousConversationId ? null : `optimistic-${crypto.randomUUID()}`;
    const conversationId = previousConversationId || optimisticConversationId;
    if (!conversationId || activeRequestIdsByConversation[conversationId]) return;
    const optimisticTimestamp = Math.floor(Date.now() / 1000);

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
    setInput("");
    if (optimisticConversationId) {
      const optimisticConversation = optimisticConversationFromPrompt(
        optimisticConversationId,
        promptWithAttachments,
        optimisticTimestamp,
      );
      setSelectedConversationId(optimisticConversationId);
      setConversationsByProfile((current) =>
        upsertConversationForProfile(current, profile, optimisticConversation),
      );
      setConversationsLoadedByProfile((current) => ({ ...current, [profile]: true }));
      setHistoryErrorsByProfile((current) => ({ ...current, [profile]: null }));
    }

    try {
      let cleanup: (() => void) | null = null;
      const stream = await streamHermesMessage(promptWithAttachments, profile, runtimeConfig, previousConversationId, (event) => {
        if (event.type === "delta" && event.delta) {
          updateConversationMessage(conversationId, assistantId, (message) => ({
            ...message,
            content:
              message.content === "Thinking..."
                ? event.delta || ""
                : `${message.content}${event.delta || ""}`,
            streaming: true,
          }));
        }

        if (event.type === "tool") {
          const toolEvent = streamToolEventFromHermes(event);
          updateConversationMessage(conversationId, assistantId, (message) => ({
            ...message,
            content: message.content === "Thinking..." ? "" : message.content,
            streaming: true,
            streamEvents: mergeStreamToolEvent(message.streamEvents || [], toolEvent),
          }));
        }

        if (event.type === "done") {
          const completedSessionId = event.sessionId || null;
          updateConversationMessage(conversationId, assistantId, (message) => ({
            ...message,
            content: event.response || message.content,
            streaming: false,
            events: event.events,
            streamEvents: message.streamEvents,
          }));
          if (completedSessionId) {
            if (optimisticConversationId) {
              setSelectedConversationId((current) =>
                current === optimisticConversationId ? completedSessionId : current,
              );
              setMessagesByConversation((current) =>
                migrateConversationMessages(current, optimisticConversationId, completedSessionId),
              );
            }
            if (optimisticConversationId) {
              setConversationsByProfile((current) =>
                replaceOptimisticConversationForProfile(
                  current,
                  profile,
                  optimisticConversationId,
                  optimisticConversationFromPrompt(
                    completedSessionId,
                    promptWithAttachments,
                    optimisticTimestamp,
                    Math.floor(Date.now() / 1000),
                  ),
                ),
              );
            }
            void refreshConversations({
              profileName: profile,
              silent: true,
            });
          }
          setActiveRequestIdsByConversation((current) =>
            removeActiveRequestIds(current, conversationId, completedSessionId),
          );
          cleanup?.();
        }

        if (event.type === "error") {
          updateConversationMessage(conversationId, assistantId, (message) => ({
            ...message,
            content: event.error || "Hermes returned an error.",
            streaming: false,
          }));
          setActiveRequestIdsByConversation((current) => removeActiveRequestIds(current, conversationId));
          cleanup?.();
        }
      });
      cleanup = stream.unlisten;
      setActiveRequestIdsByConversation((current) => ({
        ...current,
        [conversationId]: stream.requestId,
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Hermes is not connected yet. The bridge is ready once the app runs inside Tauri.";
      setActiveRequestIdsByConversation((current) => removeActiveRequestIds(current, conversationId));
      streamFallbackMessage(conversationId, assistantId, message);
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
    setSelectedConversationId(conversationId);
    setInput("");
    if (
      activeRequestIdsByConversation[conversationId] ||
      messagesByConversation[conversationId]?.length ||
      isOptimisticConversationId(conversationId)
    ) {
      setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
      return;
    }
    setConversationsLoadingByProfile((current) => ({ ...current, [profileName]: true }));
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
        return;
      }
      const loadedConversation = result.conversation;
      setSelectedConversationId(loadedConversation.id);
      setMessagesByConversation((current) => ({
        ...current,
        [loadedConversation.id]: toAppMessages(result.messages),
      }));
      setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: result.warning || null }));
    } catch (error) {
      setHistoryErrorsByProfile((current) => ({
        ...current,
        [profileName]: error instanceof Error ? error.message : "Could not load this conversation.",
      }));
    } finally {
      setConversationsLoadingByProfile((current) => ({ ...current, [profileName]: false }));
    }
  }

  function startNewConversation(profileName = profile) {
    setSelectedConversationId(null);
    setInput("");
    setHistoryErrorsByProfile((current) => ({ ...current, [profileName]: null }));
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
    await cancelHermesMessage(activeRequestId);
    setActiveRequestIdsByConversation((current) => removeActiveRequestIds(current, conversationId));
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

  function streamFallbackMessage(conversationId: string, messageId: string, finalText: string) {
    let cursor = 0;
    const interval = window.setInterval(() => {
      cursor += Math.max(3, Math.ceil(finalText.length / 42));
      updateConversationMessage(conversationId, messageId, (message) => ({
        ...message,
        content: finalText.slice(0, cursor),
        streaming: cursor < finalText.length,
      }));
      if (cursor >= finalText.length) {
        window.clearInterval(interval);
      }
    }, 18);
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
    requestActive: Boolean(activeRequestId),
    refreshConversations,
    selectedConversationId,
    sendMessage,
    setInput,
    startNewConversation,
  };
}

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

function toAppMessages(messages: HermesConversationMessage[]): Message[] {
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
  return {
    id: message.id,
    role: message.role,
    content: message.toolName ? `${message.toolName}\n${message.content}`.trim() : message.content,
  };
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

function streamToolEventFromHermes(event: HermesStreamEvent): HermesStreamToolEvent {
  return {
    id: event.callId || crypto.randomUUID(),
    callId: event.callId,
    toolName: event.toolName || "tool",
    label: event.label || titleCase(event.toolName || "Tool"),
    status: event.status || "running",
    arguments: event.arguments,
    output: event.output,
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
): HermesConversation {
  const title = conversationTitleFromPrompt(prompt);
  return {
    id,
    source: "optimistic",
    model: "",
    title,
    preview: compactConversationText(prompt, 180) || title,
    startedAt,
    endedAt: null,
    lastActiveAt,
    messageCount: id.startsWith("optimistic-") ? 1 : 2,
  };
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

function replaceOptimisticConversationForProfile(
  current: Record<string, HermesConversation[]>,
  profile: string,
  optimisticId: string,
  replacement: HermesConversation,
) {
  return {
    ...current,
    [profile]: sortConversationsByActivity([
      replacement,
      ...(current[profile] || []).filter(
        (item) => item.id !== optimisticId && item.id !== replacement.id,
      ),
    ]),
  };
}

function mergeOptimisticConversations(
  current: HermesConversation[],
  endpointConversations: HermesConversation[],
) {
  const endpointIds = new Set(endpointConversations.map((conversation) => conversation.id));
  const optimisticConversations = current.filter(
    (conversation) => isOptimisticConversation(conversation) && !endpointIds.has(conversation.id),
  );
  return sortConversationsByActivity([...optimisticConversations, ...endpointConversations]);
}

function isOptimisticConversation(conversation: HermesConversation) {
  return conversation.source === "optimistic" || isOptimisticConversationId(conversation.id);
}

function isOptimisticConversationId(conversationId: string) {
  return conversationId.startsWith("optimistic-");
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
  next[toConversationId] = fromMessages;
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
