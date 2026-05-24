import type { CoreMetadata, IrisCoreEvent, IrisCoreMessage, IrisCoreSession } from "./types";

export type HermesLikeSession = {
  id: string;
  source: "iris-core";
  model: string;
  title: string;
  preview: string;
  chatId: string;
  origin: CoreMetadata;
  metadata: CoreMetadata;
  readState?: IrisCoreSession["readState"];
  startedAt: number | null;
  endedAt: number | null;
  lastActiveAt: number | null;
  messageCount: number;
};

export function irisCoreSessionToHermes(session: IrisCoreSession): HermesLikeSession {
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
    sessionId,
    role: message.role,
    content: message.content,
    status: message.status,
    toolName: String(message.metadata?.toolName || message.toolName || ""),
    toolCallId: String(message.metadata?.toolCallId || message.toolCallId || ""),
    toolCalls: Array.isArray(message.metadata?.toolCalls) ? message.metadata.toolCalls : message.toolCalls || [],
    timestamp: message.createdAt || message.timestamp || null,
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
