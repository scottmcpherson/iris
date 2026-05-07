import { invoke } from "@tauri-apps/api/core";
import type { HermesRuntimeConfig } from "../types/hermes";
import { coreAttachmentUrl, coreBaseUrl, coreRequest, type CoreResponse } from "./coreTransport";

export type AgentUICoreAgent = {
  id: string;
  runtimeId: string;
  runtimeKind: string;
  displayName: string;
  runtimeProfile: string;
  isDefault: boolean;
  metadata?: Record<string, unknown>;
};

export type AgentUICoreConversation = {
  id: string;
  agentId: string;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
  runtimeId: string;
  runtimeProfile: string;
  externalSessionId: string;
  externalChatId: string;
  origin?: Record<string, unknown>;
};

export type AgentUICoreMessage = {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  status: "pending" | "streaming" | "completed" | "error";
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
};

export type AgentUICoreEvent = {
  cursor: number;
  id: string;
  conversationId: string;
  agentId: string;
  runtimeId: string;
  type: string;
  role: string;
  content: string;
  parentEventId: string;
  externalMessageId: string;
  createdAt: number;
  metadata: Record<string, unknown>;
};

export type AgentUICoreAutomation = {
  id: string;
  agentId: string;
  runtimeId: string;
  externalJobId: string;
  name: string;
  schedule: string;
  prompt: string;
  deliverToConversationId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  metadata: Record<string, unknown>;
};

export type AgentUICoreAttachment = {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType: string;
  size: number;
  sha256?: string;
  createdAt?: number;
  previewUrl?: string;
  downloadUrl?: string;
};

export async function getAgentUICoreAgents(runtime?: HermesRuntimeConfig) {
  return coreRequest<{ agents: AgentUICoreAgent[] }>(runtime, "GET", "/agents");
}

export async function getAgentUICoreAgentForProfile(profile = "default", runtime?: HermesRuntimeConfig) {
  const result = await getAgentUICoreAgents(runtime);
  if (!result.ok) return { ...result, agent: null };
  return {
    ok: true,
    agent:
      result.agents.find((agent) => agent.runtimeProfile === profile) ||
      result.agents.find((agent) => agent.isDefault) ||
      result.agents[0] ||
      null,
  };
}

export async function getAgentUICoreConversations(agentId: string, limit = 80, runtime?: HermesRuntimeConfig) {
  const query = new URLSearchParams({ agentId, limit: String(limit) });
  return coreRequest<{ conversations: AgentUICoreConversation[] }>(runtime, "GET", `/conversations?${query}`);
}

export async function createAgentUICoreConversation(
  payload: {
    agentId: string;
    title: string;
    externalChatId?: string;
    externalSessionId?: string;
    metadata?: Record<string, unknown>;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ conversation: AgentUICoreConversation }>(runtime, "POST", "/conversations", payload);
}

export async function getAgentUICoreConversation(
  conversationId: string,
  runtime?: HermesRuntimeConfig,
  reference: { externalSessionId?: string; externalChatId?: string } = {},
) {
  const query = conversationReferenceQuery(reference);
  return coreRequest<{ conversation: AgentUICoreConversation }>(
    runtime,
    "GET",
    `/conversations/${encodeURIComponent(conversationId)}${query}`,
  );
}

export async function getAgentUICoreConversationMessages(
  conversationId: string,
  runtime?: HermesRuntimeConfig,
  reference: { externalSessionId?: string; externalChatId?: string } = {},
) {
  const query = conversationReferenceQuery(reference);
  return coreRequest<{ conversationId: string; messages: AgentUICoreMessage[]; warning?: string }>(
    runtime,
    "GET",
    `/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
  );
}

function conversationReferenceQuery(reference: { externalSessionId?: string; externalChatId?: string }) {
  const query = new URLSearchParams();
  if (reference.externalSessionId) query.set("externalSessionId", reference.externalSessionId);
  if (reference.externalChatId) query.set("externalChatId", reference.externalChatId);
  const value = query.toString();
  return value ? `?${value}` : "";
}

export async function sendAgentUICoreMessage(
  conversationId: string,
  payload: {
    text: string;
    attachments?: unknown[];
    model?: Record<string, unknown> | null;
    clientMessageId?: string;
    metadata?: Record<string, unknown>;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{
    conversationId: string;
    messageId: string;
    accepted: boolean;
    eventCursor: number;
    runtime?: Record<string, unknown>;
  }>(
    runtime,
    "POST",
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    payload,
    { idempotencyKey: payload.clientMessageId, timeoutMs: 12_000 },
  );
}

export async function uploadAgentUICoreAttachment(
  payload: {
    file?: File;
    localPath?: string;
    name: string;
    mimeType?: string;
    kind?: "image" | "file";
    profile: string;
    conversationId?: string;
    messageId?: string;
    runtimeId?: string;
    metadata?: Record<string, unknown>;
  },
  runtime?: HermesRuntimeConfig,
) {
  if (payload.file) {
    const form = new FormData();
    form.set("file", payload.file, payload.name || payload.file.name);
    form.set("profile", payload.profile);
    form.set("runtimeId", payload.runtimeId || "runtime_local_hermes");
    form.set("kind", payload.kind || (payload.mimeType?.startsWith("image/") ? "image" : "file"));
    if (payload.conversationId) form.set("conversationId", payload.conversationId);
    if (payload.messageId) form.set("messageId", payload.messageId);
    if (payload.metadata) form.set("metadata", JSON.stringify(payload.metadata));
    try {
      const response = await fetch(`${coreBaseUrl(runtime)}/attachments`, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: form,
      });
      const parsed = await response.json().catch(() => ({}));
      if (!response.ok && parsed.ok !== false) {
        return { ok: false, error: parsed.error || `HTTP ${response.status}` } as CoreResponse<{ attachment: AgentUICoreAttachment }>;
      }
      return normalizeAttachmentUploadResponse(parsed as CoreResponse<{ attachment: AgentUICoreAttachment }>, runtime);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Attachment upload failed.",
      } as CoreResponse<{ attachment: AgentUICoreAttachment }>;
    }
  }

  if (payload.localPath) {
    const result = await invoke<CoreResponse<{ attachment: AgentUICoreAttachment }>>("hermes_bridge", {
      action: "core_upload_path",
      payload: { ...payload, runtime },
    });
    return normalizeAttachmentUploadResponse(result, runtime);
  }

  return { ok: false, error: "Attachment file is required." } as CoreResponse<{ attachment: AgentUICoreAttachment }>;
}

export function agentUICoreAttachmentUrl(runtime: HermesRuntimeConfig | undefined, path: string | undefined) {
  return coreAttachmentUrl(runtime, path);
}

function normalizeAttachmentUploadResponse(
  result: CoreResponse<{ attachment: AgentUICoreAttachment }>,
  runtime: HermesRuntimeConfig | undefined,
) {
  if (!result.ok || !result.attachment) return result;
  return {
    ...result,
    attachment: {
      ...result.attachment,
      previewUrl: coreAttachmentUrl(runtime, result.attachment.previewUrl),
      downloadUrl: coreAttachmentUrl(runtime, result.attachment.downloadUrl),
    },
  };
}

export async function cancelAgentUICoreMessage(conversationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ conversationId: string; runtime?: Record<string, unknown> }>(
    runtime,
    "POST",
    `/conversations/${encodeURIComponent(conversationId)}/cancel`,
    {},
  );
}

export async function getAgentUICoreEvents(
  after = 0,
  limit = 200,
  runtime?: HermesRuntimeConfig,
  agentId = "",
) {
  const query = new URLSearchParams({ after: String(after), limit: String(limit) });
  if (agentId) query.set("agentId", agentId);
  return coreRequest<{ events: AgentUICoreEvent[]; cursor: number }>(runtime, "GET", `/events?${query}`);
}

export function agentUICoreEventStreamUrl(
  runtime: HermesRuntimeConfig | undefined,
  after = 0,
  limit = 200,
  agentId = "",
) {
  const query = new URLSearchParams({ after: String(after), limit: String(limit) });
  if (agentId) query.set("agentId", agentId);
  return `${coreBaseUrl(runtime)}/events/stream?${query}`;
}

export async function getAgentUICoreModels(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<Record<string, unknown>>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/models`);
}

export async function getAgentUICoreSlashCommands(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<Record<string, unknown>>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/slash-commands`);
}

export async function completeAgentUICoreSlashCommand(
  agentId: string,
  text: string,
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<Record<string, unknown>>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/slash-complete`,
    { text },
  );
}

export async function getAgentUICoreAutomations(agentId: string, runtime?: HermesRuntimeConfig) {
  const query = new URLSearchParams({ agentId });
  return coreRequest<{ automations: AgentUICoreAutomation[] }>(runtime, "GET", `/automations?${query}`);
}

export async function createAgentUICoreAutomation(
  payload: {
    agentId: string;
    name: string;
    schedule: string;
    prompt: string;
    repeat?: number;
    deliver?: string;
    deliverToConversationId?: string;
    metadata?: Record<string, unknown>;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ automation: AgentUICoreAutomation; runtime?: Record<string, unknown> }>(
    runtime,
    "POST",
    "/automations",
    payload,
  );
}

export async function updateAgentUICoreAutomation(
  automationId: string,
  payload: {
    name?: string;
    schedule?: string;
    prompt?: string;
    repeat?: number;
    deliver?: string;
    deliverToConversationId?: string;
    status?: string;
    metadata?: Record<string, unknown>;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ automation: AgentUICoreAutomation; runtime?: Record<string, unknown> }>(
    runtime,
    "PATCH",
    `/automations/${encodeURIComponent(automationId)}`,
    payload,
  );
}

export async function deleteAgentUICoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automationId: string; runtime?: Record<string, unknown> }>(
    runtime,
    "DELETE",
    `/automations/${encodeURIComponent(automationId)}`,
  );
}

export async function pauseAgentUICoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automation: AgentUICoreAutomation; runtime?: Record<string, unknown> }>(
    runtime,
    "POST",
    `/automations/${encodeURIComponent(automationId)}/pause`,
    {},
  );
}

export async function resumeAgentUICoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automation: AgentUICoreAutomation; runtime?: Record<string, unknown> }>(
    runtime,
    "POST",
    `/automations/${encodeURIComponent(automationId)}/resume`,
    {},
  );
}

export async function runAgentUICoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automation: AgentUICoreAutomation; runtime?: Record<string, unknown> }>(
    runtime,
    "POST",
    `/automations/${encodeURIComponent(automationId)}/run`,
    {},
  );
}
