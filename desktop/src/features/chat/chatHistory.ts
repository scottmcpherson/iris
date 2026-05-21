import type { Message, MessageAttachment } from "../../app/types";
import type { HermesSessionMessage, HermesStreamToolEvent } from "../../types/hermes";
import {
  attachmentsFromMetadata,
  contentWithoutRenderedAttachmentMarkers,
} from "./chatStreamMerging";
import {
  mergeStreamToolEvent,
  streamToolEventFromHistory,
  streamToolEventFromHistoryCall,
} from "./toolEvents";

export function toAppMessages(messages: HermesSessionMessage[]): Message[] {
  const normalized: Message[] = [];
  let pendingToolEvents: HermesStreamToolEvent[] = [];
  let currentTurnClientRequestId = "";

  for (const message of messages) {
    if (isHiddenSessionMessage(message)) {
      continue;
    }

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

    let appMessage = toAppMessage(message);
    if (appMessage.role === "assistant" && !appMessage.content.trim() && !appMessage.attachments?.length) {
      continue;
    }
    if (appMessage.role === "user") {
      currentTurnClientRequestId = appMessage.clientRequestId || "";
    } else if (appMessage.role === "assistant" && !appMessage.clientRequestId && currentTurnClientRequestId) {
      appMessage = { ...appMessage, clientRequestId: currentTurnClientRequestId };
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

function toAppMessage(message: HermesSessionMessage): Message {
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

function clientRequestIdFromHistoryMessage(message: HermesSessionMessage) {
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

function isHiddenSessionMessage(message: HermesSessionMessage) {
  return isHiddenDeliveryMetadata(message.metadata || {});
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
