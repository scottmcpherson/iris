import { invoke } from "@tauri-apps/api/core";
import {
  completeAgentUICoreSlashCommand,
  getAgentUICoreAgentForProfile,
  getAgentUICoreConversation,
  getAgentUICoreConversationMessages,
  getAgentUICoreConversations,
  getAgentUICoreEvents,
  getAgentUICoreModels,
  getAgentUICoreSlashCommands,
  type AgentUICoreConversation,
  type AgentUICoreEvent,
  type AgentUICoreMessage,
} from "./agentuiCore";
import type {
  HermesMemory,
  HermesMemorySaveResult,
  HermesModelCatalog,
  HermesInboxMessagesResult,
  HermesConversationDetail,
  HermesConversationsResult,
  HermesRuntimeConfig,
  HermesSkillDetail,
  HermesSkillSaveResult,
  HermesSkills,
  HermesSlashCommandsResult,
  HermesSlashCompletionResult,
  HermesStatus,
  RemoteCredentialKind,
  RemoteCredentialStatus,
} from "../types/hermes";

type BridgeResponse<T> = T & {
  ok: boolean;
  error?: string;
};

async function bridge<T>(action: string, payload: Record<string, unknown> = {}) {
  return invoke<BridgeResponse<T>>("hermes_bridge", { action, payload });
}

function runtimePayload(runtime?: HermesRuntimeConfig) {
  return runtime
    ? {
        runtime,
        provider: runtime.provider,
        model: runtime.model,
      }
    : {};
}

export async function getHermesStatus(runtime?: HermesRuntimeConfig, profile?: string) {
  return bridge<HermesStatus>("status", { ...runtimePayload(runtime), profile });
}

export async function getHermesMemory(profile?: string, runtime?: HermesRuntimeConfig) {
  return bridge<HermesMemory>("memory", { profile, ...runtimePayload(runtime) });
}

export async function saveHermesMemoryFile(payload: {
  profile?: string;
  file: "memory" | "user";
  content: string;
  expectedUpdatedAt?: number | null;
}) {
  return bridge<HermesMemorySaveResult>("memory_save", payload);
}

export async function resetHermesMemoryFile(payload: {
  profile?: string;
  file: "memory" | "user" | "all";
  confirm: string;
}) {
  return bridge<HermesMemorySaveResult>("memory_reset", payload);
}

export async function getHermesSkills(profile?: string, runtime?: HermesRuntimeConfig) {
  return bridge<HermesSkills>("skills", { profile, ...runtimePayload(runtime) });
}

export async function getHermesSkillDetail(
  profile: string | undefined,
  skillId: string,
  runtime?: HermesRuntimeConfig,
) {
  return bridge<HermesSkillDetail>("skill_detail", { profile, skillId, ...runtimePayload(runtime) });
}

export async function saveHermesSkill(payload: {
  profile?: string;
  path?: string;
  name: string;
  category: string;
  content: string;
}) {
  return bridge<HermesSkillSaveResult>("skill_save", payload);
}

export async function getHermesConversations(profile?: string, limit = 80, runtime?: HermesRuntimeConfig) {
  try {
    const agentResult = await getAgentUICoreAgentForProfile(profile || "default", runtime);
    if (agentResult.ok && agentResult.agent) {
      const result = await getAgentUICoreConversations(agentResult.agent.id, limit, runtime);
      if (result.ok) {
        return {
          ok: true,
          profile: agentResult.agent.runtimeProfile,
          path: `${runtime?.managementApiUrl || "http://127.0.0.1:8765"}/v1/conversations`,
          source: "hermes-management" as const,
          schemaVersion: null,
          conversations: result.conversations.map(coreConversationToHermes),
        };
      }
    }
  } catch {
    // Fall back to the legacy bridge below.
  }
  return bridge<HermesConversationsResult>("conversations", { profile, limit, ...runtimePayload(runtime) });
}

export async function getHermesModelCatalog(profile?: string, runtime?: HermesRuntimeConfig) {
  try {
    const agentResult = await getAgentUICoreAgentForProfile(profile || "default", runtime);
    if (agentResult.ok && agentResult.agent) {
      const result = await getAgentUICoreModels(agentResult.agent.id, runtime);
      if (result.ok) return result as HermesModelCatalog;
    }
  } catch {
    // Fall back to the legacy bridge below.
  }
  return bridge<HermesModelCatalog>("models", { profile, ...runtimePayload(runtime) });
}

export async function getHermesSlashCommands(profile?: string, runtime?: HermesRuntimeConfig) {
  try {
    const agentResult = await getAgentUICoreAgentForProfile(profile || "default", runtime);
    if (agentResult.ok && agentResult.agent) {
      const result = await getAgentUICoreSlashCommands(agentResult.agent.id, runtime);
      if (result.ok) return result as HermesSlashCommandsResult;
    }
  } catch {
    // Fall back to the legacy bridge below.
  }
  return bridge<HermesSlashCommandsResult>("slash_commands", { profile, ...runtimePayload(runtime) });
}

export async function completeHermesSlashCommand(
  text: string,
  profile?: string,
  runtime?: HermesRuntimeConfig,
) {
  try {
    const agentResult = await getAgentUICoreAgentForProfile(profile || "default", runtime);
    if (agentResult.ok && agentResult.agent) {
      const result = await completeAgentUICoreSlashCommand(agentResult.agent.id, text, runtime);
      if (result.ok) return result as HermesSlashCompletionResult;
    }
  } catch {
    // Fall back to the legacy bridge below.
  }
  return bridge<HermesSlashCompletionResult>("slash_complete", {
    text,
    profile,
    ...runtimePayload(runtime),
  });
}

export async function getHermesConversationDetail(
  profile: string | undefined,
  conversationId: string,
  runtime?: HermesRuntimeConfig,
) {
  if (conversationId.startsWith("conv_")) {
    try {
      const [conversationResult, messagesResult] = await Promise.all([
        getAgentUICoreConversation(conversationId, runtime),
        getAgentUICoreConversationMessages(conversationId, runtime),
      ]);
      if (conversationResult.ok && messagesResult.ok) {
        return {
          ok: true,
          profile: conversationResult.conversation.runtimeProfile || profile || "default",
          path: `${runtime?.managementApiUrl || "http://127.0.0.1:8765"}/v1/conversations/${conversationId}`,
          source: "hermes-management" as const,
          schemaVersion: null,
          conversation: coreConversationToHermes(conversationResult.conversation),
          messages: messagesResult.messages.map((message) => coreMessageToHermes(message, conversationId)),
          warning: messagesResult.warning,
          error: undefined,
        };
      }
    } catch {
      // Fall back to the legacy bridge below.
    }
  }
  return bridge<HermesConversationDetail>("conversation_detail", {
    profile,
    conversationId,
    ...runtimePayload(runtime),
  });
}

export async function getHermesInboxMessages(
  after = 0,
  limit = 50,
  runtime?: HermesRuntimeConfig,
  profile?: string,
) {
  try {
    const agentResult = profile
      ? await getAgentUICoreAgentForProfile(profile, runtime)
      : null;
    const result = await getAgentUICoreEvents(after, limit, runtime, agentResult?.agent?.id || "");
    if (result.ok) {
      const messages = result.events
        .filter((event) => event.type.startsWith("message.assistant") || event.type === "message.error")
        .map((event) => coreEventToInboxMessage(event, profile || "default"));
      return {
        ok: true,
        messages,
        cursor: result.cursor,
      };
    }
  } catch {
    // Fall back to the legacy inbox below.
  }
  return bridge<HermesInboxMessagesResult>("inbox_messages", { after, limit, profile, ...runtimePayload(runtime) });
}

export async function acknowledgeHermesInboxMessage(messageId: string, runtime?: HermesRuntimeConfig) {
  return bridge<{ ok: boolean; error?: string }>("inbox_ack", { messageId, ...runtimePayload(runtime) });
}

export async function sendHermesGatewayMessage(
  payload: {
    text: string;
    chatId: string;
    chatName?: string;
    messageId: string;
    profile?: string;
    userId?: string;
    userName?: string;
    metadata?: Record<string, unknown>;
  },
  runtime?: HermesRuntimeConfig,
) {
  return bridge<{
    accepted?: boolean;
    platform?: string;
    chatId?: string;
    messageId?: string;
    url?: string;
  }>("gateway_message", { ...payload, ...runtimePayload(runtime) });
}

export async function createHermesProfile(name: string, runtime?: HermesRuntimeConfig) {
  return bridge<{ profile: string }>("profile_create", { name, ...runtimePayload(runtime) });
}

export async function cloneHermesProfile(source: string, name: string, runtime?: HermesRuntimeConfig) {
  return bridge<{ profile: string }>("profile_clone", { source, name, ...runtimePayload(runtime) });
}

export async function renameHermesProfile(source: string, name: string, runtime?: HermesRuntimeConfig) {
  return bridge<{ profile: string }>("profile_rename", { source, name, ...runtimePayload(runtime) });
}

export async function switchHermesProfile(name: string, runtime?: HermesRuntimeConfig) {
  return bridge<{ profile: string }>("profile_switch", { name, ...runtimePayload(runtime) });
}

export async function deleteHermesProfile(name: string, runtime?: HermesRuntimeConfig) {
  return bridge<{ profile: string }>("profile_delete", { name, ...runtimePayload(runtime) });
}

export async function getRemoteCredentialStatus(kind: RemoteCredentialKind) {
  return bridge<RemoteCredentialStatus>("remote_credential_status", { kind });
}

export async function saveRemoteCredential(kind: RemoteCredentialKind, token: string) {
  return bridge<RemoteCredentialStatus>("remote_credential_save", { kind, token });
}

export async function deleteRemoteCredential(kind: RemoteCredentialKind) {
  return bridge<RemoteCredentialStatus>("remote_credential_delete", { kind });
}

function coreConversationToHermes(conversation: AgentUICoreConversation) {
  return {
    id: conversation.id,
    source: "agentui-core",
    model: String(conversation.metadata?.model || ""),
    title: conversation.title || conversation.summary || "Untitled session",
    preview: conversation.summary || String(conversation.metadata?.preview || ""),
    chatId: conversation.externalChatId || "",
    origin: conversation.origin || {},
    startedAt: conversation.createdAt || null,
    endedAt: null,
    lastActiveAt: conversation.updatedAt || conversation.createdAt || null,
    messageCount: Number(conversation.metadata?.messageCount || 0),
  };
}

function coreMessageToHermes(message: AgentUICoreMessage, conversationId: string) {
  return {
    id: message.id,
    sessionId: conversationId,
    role: message.role,
    content: message.content,
    toolName: String(message.metadata?.toolName || ""),
    toolCallId: String(message.metadata?.toolCallId || ""),
    toolCalls: Array.isArray(message.metadata?.toolCalls) ? message.metadata.toolCalls : [],
    timestamp: message.createdAt || null,
  };
}

export function coreEventToInboxMessage(event: AgentUICoreEvent, fallbackProfile: string) {
  const metadata = event.metadata || {};
  return {
    cursor: event.cursor,
    id: event.id,
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
