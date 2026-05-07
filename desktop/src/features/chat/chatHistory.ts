import type { Message, MessageAttachment } from "../../app/types";
import type { HermesConversationMessage, HermesStreamToolEvent } from "../../types/hermes";
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
  const attachments = message.role === "user" ? attachmentsFromMetadata(message.metadata) : [];
  const content = message.role === "user"
    ? stripModelSwitchNote(message.content)
    : message.content;
  return {
    id: message.id,
    role: message.role,
    content: message.toolName ? `${message.toolName}\n${content}`.trim() : displayContentForAttachments(content, attachments),
    attachments: attachments.length ? attachments : undefined,
  };
}

function attachmentsFromMetadata(metadata: Record<string, unknown> | undefined): MessageAttachment[] {
  if (!metadata || !Array.isArray(metadata.attachments)) return [];
  return metadata.attachments.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === "string" && candidate.id ? candidate.id : crypto.randomUUID();
    const name = typeof candidate.name === "string" && candidate.name ? candidate.name : "Attached file";
    const kind = candidate.kind === "image" ? "image" : "file";
    const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : "";
    const size = typeof candidate.size === "number" ? candidate.size : -1;
    const lastModified = typeof candidate.lastModified === "number" ? candidate.lastModified : 0;
    const previewUrl = typeof candidate.previewUrl === "string" ? candidate.previewUrl : undefined;
    const downloadUrl = typeof candidate.downloadUrl === "string" ? candidate.downloadUrl : undefined;
    const localPath = typeof candidate.localPath === "string"
      ? candidate.localPath
      : typeof candidate.path === "string"
        ? candidate.path
        : undefined;
    const legacyLocalPath = candidate.legacyLocalPath === true || (Boolean(localPath) && !previewUrl);
    return [{ id, name, kind, mimeType, size, lastModified, previewUrl, downloadUrl, localPath, legacyLocalPath }];
  });
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
