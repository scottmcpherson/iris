import type {
  IrisCoreSession,
  IrisCoreEvent,
  IrisCoreMessage,
} from "./irisCore";

export function irisCoreSessionToHermes(session: IrisCoreSession) {
  const origin = {
    ...(session.origin || {}),
    runtimeId: session.runtimeId,
    runtimeProfile: session.runtimeProfile,
    externalSessionId: session.externalSessionId,
    externalChatId: session.externalChatId,
  };
  return {
    id: session.id,
    source: "iris-core",
    model: String(session.metadata?.model || ""),
    title: session.title || session.summary || "Untitled session",
    preview: session.summary || String(session.metadata?.preview || ""),
    chatId: session.externalChatId || "",
    origin,
    metadata: session.metadata || {},
    readState: session.readState,
    startedAt: session.createdAt || null,
    endedAt: null,
    lastActiveAt: session.updatedAt || session.createdAt || null,
    messageCount: Number(session.metadata?.messageCount || 0),
  };
}

export function irisCoreMessageToHermes(message: IrisCoreMessage, sessionId: string) {
  return {
    id: message.id,
    sessionId: sessionId,
    role: message.role,
    content: message.content,
    status: message.status,
    toolName: String(message.metadata?.toolName || ""),
    toolCallId: String(message.metadata?.toolCallId || ""),
    toolCalls: Array.isArray(message.metadata?.toolCalls) ? message.metadata.toolCalls : [],
    timestamp: message.createdAt || null,
    metadata: message.metadata || {},
  };
}

export function irisCoreEventToDeliveryMessage(event: IrisCoreEvent, fallbackProfile: string) {
  const metadata = event.metadata || {};
  return {
    cursor: event.cursor,
    id: event.externalMessageId || event.id,
    source: String(metadata.source || "iris-core-events"),
    platform: "iris",
    profile: String(metadata.profile || fallbackProfile),
    chatId: String(metadata.chatId || event.sessionId),
    content: event.content,
    metadata: {
      ...metadata,
      eventType: event.type,
      replyTo: metadata.replyTo || event.parentEventId || undefined,
    },
    createdAt: event.createdAt,
    acknowledgedAt: null,
  };
}
