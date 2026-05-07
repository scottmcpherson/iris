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

export async function getHermesConversations(
  profile?: string,
  limit = 80,
  runtime?: HermesRuntimeConfig,
): Promise<HermesConversationsResult> {
  const targetProfile = profile || "default";
  try {
    const agentResult = await getAgentUICoreAgentForProfile(targetProfile, runtime);
    if (!agentResult.ok || !agentResult.agent) {
      return emptyConversations(
        targetProfile,
        agentResultError(agentResult, "Could not resolve Iris agent."),
        runtime,
      );
    }
    const result = await getAgentUICoreConversations(agentResult.agent.id, limit, runtime);
    if (!result.ok) {
      return emptyConversations(
        agentResult.agent.runtimeProfile,
        result.error || "Could not load conversations from Iris Core.",
        runtime,
      );
    }
    return {
      ok: true,
      profile: agentResult.agent.runtimeProfile,
      path: `${runtime?.managementApiUrl || "http://127.0.0.1:8765"}/v1/conversations`,
      source: "hermes-management" as const,
      schemaVersion: null,
      conversations: result.conversations.map(coreConversationToHermes),
    };
  } catch (error) {
    return emptyConversations(
      targetProfile,
      error instanceof Error ? error.message : "Could not load conversations from Iris Core.",
      runtime,
    );
  }
}

export async function getHermesModelCatalog(profile?: string, runtime?: HermesRuntimeConfig) {
  const targetProfile = profile || "default";
  try {
    const agentResult = await getAgentUICoreAgentForProfile(targetProfile, runtime);
    if (!agentResult.ok || !agentResult.agent) {
      return emptyModelCatalog(targetProfile, agentResultError(agentResult, "Could not resolve Iris agent."));
    }
    const result = await getAgentUICoreModels(agentResult.agent.id, runtime);
    return result.ok
      ? result as HermesModelCatalog
      : emptyModelCatalog(targetProfile, result.error || "Could not load model catalog from Iris Core.");
  } catch (error) {
    return emptyModelCatalog(
      targetProfile,
      error instanceof Error ? error.message : "Could not load model catalog from Iris Core.",
    );
  }
}

export async function getHermesSlashCommands(profile?: string, runtime?: HermesRuntimeConfig) {
  const targetProfile = profile || "default";
  try {
    const agentResult = await getAgentUICoreAgentForProfile(targetProfile, runtime);
    if (!agentResult.ok || !agentResult.agent) {
      return emptySlashCommands(targetProfile, agentResultError(agentResult, "Could not resolve Iris agent."));
    }
    const result = await getAgentUICoreSlashCommands(agentResult.agent.id, runtime);
    return result.ok
      ? result as HermesSlashCommandsResult
      : emptySlashCommands(targetProfile, result.error || "Could not load slash commands from Iris Core.");
  } catch (error) {
    return emptySlashCommands(
      targetProfile,
      error instanceof Error ? error.message : "Could not load slash commands from Iris Core.",
    );
  }
}

export async function completeHermesSlashCommand(
  text: string,
  profile?: string,
  runtime?: HermesRuntimeConfig,
) {
  try {
    const agentResult = await getAgentUICoreAgentForProfile(profile || "default", runtime);
    if (!agentResult.ok || !agentResult.agent) {
      return emptySlashCompletion(agentResultError(agentResult, "Could not resolve Iris agent."));
    }
    const result = await completeAgentUICoreSlashCommand(agentResult.agent.id, text, runtime);
    return result.ok
      ? result as HermesSlashCompletionResult
      : emptySlashCompletion(result.error || "Could not complete slash command through Iris Core.");
  } catch (error) {
    return emptySlashCompletion(
      error instanceof Error ? error.message : "Could not complete slash command through Iris Core.",
    );
  }
}

export async function getHermesConversationDetail(
  profile: string | undefined,
  conversationId: string,
  runtime?: HermesRuntimeConfig,
) {
  if (!conversationId.startsWith("conv_")) {
    return emptyConversationDetail(
      profile || "default",
      conversationId,
      "Legacy conversation history is no longer loaded directly. Start a follow-up to link it through Iris Core.",
      runtime,
    );
  }
  try {
    const [conversationResult, messagesResult] = await Promise.all([
      getAgentUICoreConversation(conversationId, runtime),
      getAgentUICoreConversationMessages(conversationId, runtime),
    ]);
    if (!conversationResult.ok || !messagesResult.ok) {
      return emptyConversationDetail(
        profile || "default",
        conversationId,
        conversationResult.error || messagesResult.error || "Could not load this conversation from Iris Core.",
        runtime,
      );
    }
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
  } catch (error) {
    return emptyConversationDetail(
      profile || "default",
      conversationId,
      error instanceof Error ? error.message : "Could not load this conversation from Iris Core.",
      runtime,
    );
  }
}

export async function getHermesInboxMessages(
  after = 0,
  limit = 50,
  runtime?: HermesRuntimeConfig,
  profile?: string,
) {
  try {
    let agentId = "";
    if (profile) {
      const agentResult = await getAgentUICoreAgentForProfile(profile, runtime);
      if (!agentResult.ok || !agentResult.agent) {
        return {
          ok: false,
          messages: [],
          cursor: after,
          error: agentResultError(agentResult, "Could not resolve Iris agent."),
        };
      }
      agentId = agentResult.agent.id;
    }
    const result = await getAgentUICoreEvents(after, limit, runtime, agentId);
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
    return {
      ok: false,
      messages: [],
      cursor: after,
      error: result.error || "Could not load events from Iris Core.",
    };
  } catch (error) {
    return {
      ok: false,
      messages: [],
      cursor: after,
      error: error instanceof Error ? error.message : "Could not load events from Iris Core.",
    };
  }
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

function emptyModelCatalog(profile: string, error: string): HermesModelCatalog {
  return {
    ok: false,
    profile,
    current: null,
    providers: [],
    generatedAt: Math.floor(Date.now() / 1000),
    error,
  };
}

function emptyConversations(profile: string, error: string, runtime?: HermesRuntimeConfig): HermesConversationsResult {
  return {
    ok: false,
    profile,
    path: `${runtime?.managementApiUrl || "http://127.0.0.1:8765"}/v1/conversations`,
    source: "hermes-management",
    schemaVersion: null,
    conversations: [],
    error,
  };
}

function emptyConversationDetail(
  profile: string,
  conversationId: string,
  error: string,
  runtime?: HermesRuntimeConfig,
): HermesConversationDetail {
  return {
    ok: false,
    profile,
    path: `${runtime?.managementApiUrl || "http://127.0.0.1:8765"}/v1/conversations/${conversationId}`,
    source: "hermes-management",
    schemaVersion: null,
    conversation: null,
    messages: [],
    error,
  };
}

function emptySlashCommands(profile: string, error: string): HermesSlashCommandsResult {
  return {
    ok: false,
    profile,
    commands: [],
    generatedAt: Math.floor(Date.now() / 1000),
    error,
  };
}

function emptySlashCompletion(error: string): HermesSlashCompletionResult {
  return {
    ok: false,
    items: [],
    replaceFrom: 1,
    error,
  };
}

function agentResultError(result: unknown, fallback: string) {
  if (result && typeof result === "object" && "error" in result) {
    const error = (result as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

function coreConversationToHermes(conversation: AgentUICoreConversation) {
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

function coreMessageToHermes(message: AgentUICoreMessage, conversationId: string) {
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
