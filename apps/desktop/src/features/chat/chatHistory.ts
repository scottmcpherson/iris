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

    // A tool call a message makes belongs to the NEXT round — its result streams in
    // after this message — so it must not be attached to this message as a running
    // card. That mis-attribution is what produced the reopen "duplicate": the agent
    // emits one assistant turn carrying [previous round's text + this round's tool
    // call], so the call was rendered shimmering on the prior bubble AND again,
    // completed, once its result merged onto the next. Hold a message's own calls
    // separately and attach only the EXISTING pending events (the prior round's
    // completed call+result) to it.
    let ownToolCalls: HermesStreamToolEvent[] = [];
    if (message.role === "assistant" && message.toolCalls?.length) {
      ownToolCalls = message.toolCalls.map((toolCall, index) =>
        streamToolEventFromHistoryCall(message, toolCall, index),
      );
      if (!message.content.trim()) {
        // Call-only assistant message: stage its calls for the next round, render nothing.
        pendingToolEvents = ownToolCalls.reduce(
          (current, event) => mergeStreamToolEvent(current, event),
          pendingToolEvents,
        );
        continue;
      }
    }

    if (message.role === "tool") {
      // A tool result merges into its matching pending call (by callId), completing it.
      pendingToolEvents = mergeStreamToolEvent(pendingToolEvents, streamToolEventFromHistory(message));
      continue;
    }

    let appMessage = toAppMessage(message);
    if (appMessage.role === "assistant" && !appMessage.content.trim() && !appMessage.attachments?.length) {
      // No visible body: carry forward any calls it staged rather than dropping them.
      pendingToolEvents = ownToolCalls.reduce(
        (current, event) => mergeStreamToolEvent(current, event),
        pendingToolEvents,
      );
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
      // This message's own calls become the pending set for the next round.
      pendingToolEvents = ownToolCalls;
      continue;
    }

    if (pendingToolEvents.length) {
      normalized.push(toolEventMessage(message.sessionId || message.id, pendingToolEvents));
    }
    normalized.push(appMessage);
    pendingToolEvents = ownToolCalls;
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
