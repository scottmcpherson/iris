import type { ChatMessage, CoreChatMessage } from "./types";

export function toChatMessages(messages: CoreChatMessage[]): ChatMessage[] {
  return messages.flatMap((message) => {
    if (isHiddenDeliveryMetadata(message.metadata || {})) return [];
    const content = message.role === "user" ? stripModelSwitchNote(message.content) : message.content;
    if (message.role === "assistant" && !content.trim()) return [];
    return [{
      id: message.id,
      role: message.role,
      content,
      clientRequestId: clientRequestIdFromHistoryMessage(message) || undefined,
    }];
  });
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
