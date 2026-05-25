import type { ChatMessage, ChatStreamToolEvent, CoreChatMessage, MessageAttachment } from "./types";
import {
  attachmentsFromMetadata,
  contentWithoutRenderedAttachmentMarkers,
} from "./streamMerging";
import {
  mergeStreamToolEvent,
  streamToolEventFromHistory,
  streamToolEventFromHistoryCall,
} from "./toolEvents";

export function toChatMessages(messages: CoreChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  let pendingToolEvents: ChatStreamToolEvent[] = [];
  let currentTurnClientRequestId = "";

  for (const message of messages) {
    if (isHiddenDeliveryMetadata(message.metadata || {})) continue;

    if (message.role === "assistant" && message.toolCalls?.length) {
      pendingToolEvents = message.toolCalls.reduce(
        (current, toolCall, index) =>
          mergeStreamToolEvent(current, streamToolEventFromHistoryCall(message, toolCall, index)),
        pendingToolEvents,
      );
      if (!message.content.trim()) continue;
    }

    if (message.role === "tool") {
      pendingToolEvents = mergeStreamToolEvent(pendingToolEvents, streamToolEventFromHistory(message));
      continue;
    }

    let chatMessage = toChatMessage(message);
    if (chatMessage.role === "assistant" && !chatMessage.content.trim() && !chatMessage.attachments?.length) {
      continue;
    }
    if (chatMessage.role === "user") {
      currentTurnClientRequestId = chatMessage.clientRequestId || "";
    } else if (chatMessage.role === "assistant" && !chatMessage.clientRequestId && currentTurnClientRequestId) {
      chatMessage = { ...chatMessage, clientRequestId: currentTurnClientRequestId };
    }

    if (chatMessage.role === "assistant" && pendingToolEvents.length) {
      normalized.push({
        ...chatMessage,
        streamEvents: pendingToolEvents,
      });
      pendingToolEvents = [];
      continue;
    }

    if (pendingToolEvents.length) {
      normalized.push(toolEventMessage(message.sessionId || message.id, pendingToolEvents));
      pendingToolEvents = [];
    }
    normalized.push(chatMessage);
  }

  if (pendingToolEvents.length) {
    normalized.push(toolEventMessage("history-tools", pendingToolEvents));
  }

  return normalized;
}

function toolEventMessage(id: string, streamEvents: ChatStreamToolEvent[]): ChatMessage {
  return {
    id: `${id}-tool-events`,
    role: "assistant",
    content: "",
    streamEvents,
  };
}

function toChatMessage(message: CoreChatMessage): ChatMessage {
  const attachments = message.role === "user" || message.role === "assistant"
    ? attachmentsFromMetadata(message.metadata)
    : [];
  const content = message.role === "user"
    ? stripModelSwitchNote(message.content)
    : message.content;
  const displayContent = message.role === "assistant"
    ? contentWithoutRenderedAttachmentMarkers(content, attachments, message.metadata)
    : displayContentForAttachments(content, attachments);
  const clientRequestId = clientRequestIdFromHistoryMessage(message);
  return {
    id: message.id,
    role: message.role,
    content: message.toolName ? `${message.toolName}\n${content}`.trim() : displayContent,
    attachments: attachments.length ? attachments : undefined,
    ...(clientRequestId ? { clientRequestId } : {}),
  };
}

export function isHiddenDeliveryMetadata(metadata: Record<string, unknown>) {
  return (
    booleanMetadata(metadata, "hidden") === true ||
    stringMetadata(metadata, "kind") === "model-switch" ||
    stringMetadata(metadata, "replyTo").endsWith("-model") ||
    stringMetadata(metadata, "reply_to").endsWith("-model")
  );
}

export function stripModelSwitchNote(content: string) {
  return content.replace(
    /^\s*\[Note:\s*model was just switched from [^\]]+\]\s*/i,
    "",
  );
}

export function stringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

export function booleanMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "boolean" ? value : null;
}

export function activeRequestCompletedByHistory(
  historyMessages: CoreChatMessage[],
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
    if (replyTo === activeRequestId || metadataReferencesRequest(metadata, activeRequestId)) return true;
    return !historyMessageHasRequestRoutingMetadata(metadata);
  });
}

function clientRequestIdFromHistoryMessage(message: CoreChatMessage) {
  const metadata = message.metadata || {};
  if (message.role === "user") {
    return stringMetadata(metadata, "clientRequestId") ||
      stringMetadata(metadata, "client_request_id") ||
      stringMetadata(metadata, "clientMessageId") ||
      stringMetadata(metadata, "client_message_id");
  }
  if (message.role === "assistant") {
    return stringMetadata(metadata, "replyTo") ||
      stringMetadata(metadata, "reply_to") ||
      stringMetadata(metadata, "clientRequestId") ||
      stringMetadata(metadata, "client_request_id") ||
      stringMetadata(metadata, "clientMessageId") ||
      stringMetadata(metadata, "client_message_id");
  }
  return "";
}

function metadataReferencesRequest(metadata: Record<string, unknown>, activeRequestId: string) {
  return [
    "clientRequestId",
    "client_request_id",
    "clientMessageId",
    "client_message_id",
    "idempotencyKey",
    "idempotency_key",
    "irisMessageId",
  ].some((key) => stringMetadata(metadata, key) === activeRequestId);
}

function historyMessageStillStreaming(metadata: Record<string, unknown>) {
  if (booleanMetadata(metadata, "streaming") === true) return true;
  if (booleanMetadata(metadata, "finalize") === false || booleanMetadata(metadata, "final") === false) return true;
  return false;
}

function historyMessageHasRequestRoutingMetadata(metadata: Record<string, unknown>) {
  return [
    "replyTo",
    "reply_to",
    "clientRequestId",
    "client_request_id",
    "clientMessageId",
    "client_message_id",
    "idempotencyKey",
    "idempotency_key",
    "irisMessageId",
    "streamMessageId",
    "stream_message_id",
  ].some((key) => Boolean(stringMetadata(metadata, key)));
}

function displayContentForAttachments(content: string, attachments: MessageAttachment[]) {
  if (!attachments.length) return content;
  const displayContent = stripAttachmentSummary(content);
  return isAttachmentOnlyContent(displayContent, attachments) ? "" : displayContent;
}

function stripAttachmentSummary(content: string) {
  const withoutTrailingSummary = content.replace(/\n\nAttached files:\n[\s\S]*$/u, "").trim();
  return withoutTrailingSummary.replace(/^Attached files:\n[\s\S]*$/u, "").trim();
}

function isAttachmentOnlyContent(content: string, attachments: MessageAttachment[]) {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (/^Use the attached files as context\.?$/iu.test(trimmed)) return true;
  const attachmentNames = new Set(attachments.map((attachment) => attachment.name).filter(Boolean));
  if (!attachmentNames.size) return false;
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => {
    if (/^Runtime path:\s+/iu.test(line)) return true;
    if (!/^\d+\.\s+/u.test(line)) return false;
    return Array.from(attachmentNames).some((name) => line.includes(name));
  });
}
