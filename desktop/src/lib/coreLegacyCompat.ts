import type {
  AgentUICoreConversation,
  AgentUICoreEvent,
  AgentUICoreMessage,
} from "./agentuiCore";

export function coreConversationToLegacy(conversation: AgentUICoreConversation) {
  const origin = {
    ...(conversation.origin || {}),
    runtimeId: conversation.runtimeId,
    runtimeProfile: conversation.runtimeProfile,
    externalSessionId: conversation.externalSessionId,
    externalChatId: conversation.externalChatId,
  };
  return {
    id: conversation.id,
    source: "agentui-core",
    model: String(conversation.metadata?.model || ""),
    title: conversation.title || conversation.summary || "Untitled session",
    preview: conversation.summary || String(conversation.metadata?.preview || ""),
    chatId: conversation.externalChatId || "",
    origin,
    startedAt: conversation.createdAt || null,
    endedAt: null,
    lastActiveAt: conversation.updatedAt || conversation.createdAt || null,
    messageCount: Number(conversation.metadata?.messageCount || 0),
  };
}

export function coreMessageToLegacy(message: AgentUICoreMessage, conversationId: string) {
  return {
    id: message.id,
    sessionId: conversationId,
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

export function coreEventToInboxMessage(event: AgentUICoreEvent, fallbackProfile: string) {
  const metadata = event.metadata || {};
  return {
    cursor: event.cursor,
    id: event.externalMessageId || event.id,
    source: String(metadata.source || "agentui-core-events"),
    platform: "agentui",
    profile: String(metadata.profile || fallbackProfile),
    chatId: String(metadata.chatId || event.conversationId),
    content: event.content,
    metadata: {
      ...metadata,
      replyTo: metadata.replyTo || event.parentEventId || undefined,
    },
    createdAt: event.createdAt,
    acknowledgedAt: null,
  };
}
