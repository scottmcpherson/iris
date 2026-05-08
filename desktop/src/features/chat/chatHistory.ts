import type { Message, MessageAttachment } from "../../app/types";
import type { HermesConversationMessage, HermesStreamToolEvent } from "../../types/hermes";
import {
  attachmentsFromMetadata,
  contentWithoutRenderedAttachmentMarkers,
} from "./chatStreamMerging";
import {
  mergeStreamToolEvent,
  streamToolEventFromHistory,
  streamToolEventFromHistoryCall,
} from "./toolEvents";

export function toAppMessages(messages: HermesConversationMessage[]): Message[] {
  const normalized: Message[] = [];
  let pendingToolEvents: HermesStreamToolEvent[] = [];

  for (const message of messages) {
    if (isHiddenConversationMessage(message)) {
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

    const appMessage = toAppMessage(message);
    if (appMessage.role === "assistant" && !appMessage.content.trim() && !appMessage.attachments?.length) {
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
  const attachments = message.role === "user" || message.role === "assistant"
    ? attachmentsFromMetadata(message.metadata)
    : [];
  const content = message.role === "user"
    ? stripModelSwitchNote(message.content)
    : message.content;
  const displayContent = message.role === "assistant"
    ? contentWithoutRenderedAttachmentMarkers(content, attachments, message.metadata)
    : displayContentForAttachments(content, attachments);
  return {
    id: message.id,
    role: message.role,
    content: message.toolName ? `${message.toolName}\n${content}`.trim() : displayContent,
    attachments: attachments.length ? attachments : undefined,
  };
}

function displayContentForAttachments(content: string, attachments: MessageAttachment[]) {
  if (!attachments.length) return content;
  return stripAttachmentSummary(content) || "Use the attached files as context.";
}

function stripAttachmentSummary(content: string) {
  return content.replace(/\n\nAttached files:\n[\s\S]*$/u, "").trim();
}

function isHiddenConversationMessage(message: HermesConversationMessage) {
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
