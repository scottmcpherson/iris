import type { ChatMessage, MessageAttachment, SendAcceptedResult } from "./types";

export function createClientRequestId(prefix = "mobile") {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function createOptimisticUserMessage(
  text: string,
  clientRequestId = createClientRequestId(),
  attachments: MessageAttachment[] = [],
): ChatMessage {
  return {
    id: clientRequestId,
    role: "user",
    content: text,
    ...(attachments.length ? { attachments } : {}),
    clientRequestId,
  };
}

export function createOptimisticAssistantMessage(clientRequestId: string): ChatMessage {
  return {
    id: `${clientRequestId}-assistant`,
    role: "assistant",
    content: "",
    streaming: true,
    clientRequestId,
  };
}

export function appendOptimisticSend(
  messages: ChatMessage[],
  text: string,
  clientRequestId = createClientRequestId(),
  attachments: MessageAttachment[] = [],
) {
  return {
    clientRequestId,
    messages: [
      ...messages,
      createOptimisticUserMessage(text, clientRequestId, attachments),
      createOptimisticAssistantMessage(clientRequestId),
    ],
  };
}

export function replaceOptimisticSend(messages: ChatMessage[], result: SendAcceptedResult, clientRequestId: string) {
  if (!result.messageId) return messages;
  return messages.map((message) =>
    message.role === "user" && message.clientRequestId === clientRequestId
      ? { ...message, id: result.messageId || message.id }
      : message,
  );
}
