import { invoke } from "@tauri-apps/api/core";
import type { HermesRuntimeConfig } from "../types/hermes";

type CoreResponse<T> = T & {
  ok: boolean;
  error?: string;
};

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

function coreBaseUrl(runtime?: HermesRuntimeConfig) {
  const base = (runtime?.managementApiUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

async function coreRequest<T>(
  runtime: HermesRuntimeConfig | undefined,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  options: { timeoutMs?: number; idempotencyKey?: string } = {},
): Promise<CoreResponse<T>> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${coreBaseUrl(runtime)}${normalizedPath}`;
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  let timedOut = false;
  const timeout = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? 2500)
    : null;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: controller?.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      return coreRequestViaBridge(runtime, method, normalizedPath, body);
    }
    if (!response.ok && parsed.ok !== false) {
      return { ...(parsed as T), ok: false, error: parsed.error || `HTTP ${response.status}` };
    }
    return parsed as CoreResponse<T>;
  } catch {
    if (timedOut && method !== "GET") {
      return { ok: false, error: "timed out" } as CoreResponse<T>;
    }
    return coreRequestViaBridge(runtime, method, normalizedPath, body);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function coreRequestViaBridge<T>(
  runtime: HermesRuntimeConfig | undefined,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) {
  return invoke<CoreResponse<T>>("hermes_bridge", {
    action: "core_request",
    payload: {
      method,
      path,
      body,
      runtime,
    },
  });
}

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

export async function getAgentUICoreConversation(conversationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ conversation: AgentUICoreConversation }>(runtime, "GET", `/conversations/${encodeURIComponent(conversationId)}`);
}

export async function getAgentUICoreConversationMessages(conversationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ conversationId: string; messages: AgentUICoreMessage[]; warning?: string }>(
    runtime,
    "GET",
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
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
