import { invoke } from "@tauri-apps/api/core";
import type {
  HermesSessionMessage,
  HermesModelProvider,
  HermesModelSelection,
  HermesRuntimeConfig,
} from "../types/hermes";
import type {
  HermesMemory,
  HermesMemorySaveResult,
  HermesSkillDetail,
  HermesSkillSaveResult,
  HermesSkills,
  HermesStatus,
} from "../types/hermes";
import { coreAttachmentUrl, coreBaseUrl, coreRequest, type CoreResponse } from "./coreTransport";
import type { AttachmentKind } from "../app/types";
import { attachmentKindFromMime } from "../shared/files";

type CorePrimitive = string | number | boolean | null;
type CoreJsonValue = CorePrimitive | CoreJsonValue[] | { [key: string]: CoreJsonValue };
export type CoreMetadata = { [key: string]: CoreJsonValue };

type CoreEndpointProbe = {
  ok: boolean;
  url?: string;
  error?: string;
};

type CoreRuntimeProbe = {
  gateway: CoreEndpointProbe;
  management: CoreEndpointProbe;
  agentuiAdapter: CoreEndpointProbe;
};

type CoreRuntimeRow = {
  id?: string;
  kind?: string;
  name?: string;
  enabled?: boolean;
  lastProbe?: CoreRuntimeProbe;
  last_probe?: CoreRuntimeProbe;
};

type CoreStatusResponse = {
  ok?: boolean;
  error?: string;
};

type CoreHealthResponse = CoreStatusResponse & {
  status?: string;
};

export type CoreMessageAttachmentRef = {
  id: string;
};

export type CoreRuntimeResult = {
  ok?: boolean;
  accepted?: boolean;
  chatId?: string;
  messageId?: string;
  error?: string;
};

export type AgentUICoreSendMessageResult = {
  sessionId: string;
  messageId: string;
  accepted: boolean;
  eventCursor: number;
  duplicate?: boolean;
  runtime?: CoreRuntimeResult;
};

export type AgentUICoreModelCatalog = {
  profile: string;
  current: HermesModelSelection | null;
  providers: HermesModelProvider[];
  generatedAt: number;
  url?: string;
  status?: number;
};

export type AgentUICoreSlashCommandCatalog = {
  commands?: Array<{
    id?: string;
    name?: string;
    text?: string;
    label?: string;
    description?: string;
    category?: string;
    source?: string;
    aliases?: string[];
    argsHint?: string;
    subcommands?: string[];
    requiresArgument?: boolean;
  }>;
  warning?: string;
};

export type AgentUICoreAgent = {
  id: string;
  runtimeId: string;
  runtimeKind: string;
  displayName: string;
  runtimeProfile: string;
  isDefault: boolean;
  metadata?: CoreMetadata;
};

export type AgentUICoreSession = {
  id: string;
  agentId: string;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  metadata?: CoreMetadata;
  runtimeId: string;
  runtimeProfile: string;
  externalSessionId: string;
  externalChatId: string;
  origin?: CoreMetadata;
  readState?: AgentUICoreSessionReadState;
};

export type AgentUICoreSessionReadState = {
  sessionId: string;
  state: "read" | "unread";
  createdAt: number | null;
  updatedAt: number | null;
  metadata?: CoreMetadata;
};

export type IrisProject = {
  id: string;
  name: string;
  slug: string;
  defaultAgentId: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  metadata?: CoreMetadata;
};

export type AgentUICoreMessage = HermesSessionMessage & {
  sessionId?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type AgentUICoreEvent = {
  cursor: number;
  id: string;
  sessionId: string;
  agentId: string;
  runtimeId: string;
  type: string;
  role: string;
  content: string;
  parentEventId: string;
  externalMessageId: string;
  createdAt: number;
  metadata: CoreMetadata;
};

export type AgentUICoreAutomation = {
  id: string;
  agentId: string;
  runtimeId: string;
  externalJobId: string;
  name: string;
  schedule: string;
  prompt: string;
  deliverToSessionId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  metadata: CoreMetadata;
};

export type AgentUICoreAttachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
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

export async function getAgentUICoreStatus(runtime?: HermesRuntimeConfig) {
  const [health, status, agents, runtimes] = await Promise.all([
    coreRequest<CoreHealthResponse>(runtime, "GET", "/health"),
    coreRequest<CoreStatusResponse>(runtime, "GET", "/status"),
    getAgentUICoreAgents(runtime),
    coreRequest<{ runtimes: CoreRuntimeRow[] }>(runtime, "GET", "/runtimes"),
  ]);
  const ok = Boolean(health.ok || status.ok || agents.ok);
  const agentRows = agents.ok ? agents.agents : [];
  const activeAgent = agentRows.find((agent) => agent.isDefault) || agentRows[0] || null;
  const profiles = agentRows.map(coreAgentToHermesProfile);
  const runtimeRows = runtimes.ok ? runtimes.runtimes || [] : [];
  const probe = firstRuntimeProbe(runtimeRows);
  const coreStatus = endpointFromResponse(status, coreBaseUrl(runtime));
  return {
    ok,
    connected: ok,
    root: "",
    hermesPath: null,
    hermesPathSource: null,
    hermesPathCandidates: [],
    version: null,
    activeProfile: activeAgent ? coreAgentToHermesProfile(activeAgent) : profiles[0] || null,
    profiles,
    checkedAt: Math.floor(Date.now() / 1000),
    connectionMode: runtime?.connectionMode || "local",
    remoteUrl: runtime?.remoteUrl || "",
    coreApiUrl: coreBaseUrl(runtime).replace(/\/v1$/, ""),
    activeApiUrl: "",
    gatewayStatus: probe.gateway,
    remoteStatus: { ok: false },
    activeApiStatus: probe.agentuiAdapter,
    managementStatus: coreStatus,
    runtimeStatus: probe,
    error: ok ? null : health.error || status.error || agents.error || "Could not reach Iris Core.",
  } as HermesStatus & { runtimeStatus?: CoreRuntimeProbe };
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

export async function getAgentUICoreAgentMemory(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesMemory>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/memory`);
}

export async function saveAgentUICoreAgentMemory(
  agentId: string,
  file: "memory" | "user",
  payload: { content: string; expectedUpdatedAt?: number | null },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesMemorySaveResult>(
    runtime,
    "PUT",
    `/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(file)}`,
    payload,
  );
}

export async function resetAgentUICoreAgentMemory(
  agentId: string,
  file: "memory" | "user" | "all",
  payload: { confirm: string },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesMemorySaveResult>(
    runtime,
    "DELETE",
    `/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(file)}`,
    payload,
  );
}

export async function getAgentUICoreAgentSkills(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesSkills>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/skills`);
}

export async function getAgentUICoreAgentSkill(agentId: string, skillId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesSkillDetail>(
    runtime,
    "GET",
    `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
  );
}

export async function createAgentUICoreAgentSkill(
  agentId: string,
  payload: { name: string; category: string; path?: string; content: string },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesSkillSaveResult>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/skills`,
    payload,
  );
}

export async function saveAgentUICoreAgentSkill(
  agentId: string,
  skillId: string,
  payload: { name: string; category: string; path?: string; content: string },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesSkillSaveResult>(
    runtime,
    "PUT",
    `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
    payload,
  );
}

export async function createAgentUICoreAgent(
  payload: { name: string; runtimeId?: string; metadata?: CoreMetadata },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ agent: AgentUICoreAgent }>(runtime, "POST", "/agents", payload);
}

export async function cloneAgentUICoreAgent(
  agentId: string,
  payload: { name: string; metadata?: CoreMetadata },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ agent: AgentUICoreAgent }>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/clone`,
    payload,
  );
}

export async function renameAgentUICoreAgent(
  agentId: string,
  payload: { name: string },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ agent: AgentUICoreAgent }>(
    runtime,
    "PATCH",
    `/agents/${encodeURIComponent(agentId)}`,
    payload,
  );
}

export async function activateAgentUICoreAgent(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ agent: AgentUICoreAgent }>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/activate`,
    {},
  );
}

export async function deleteAgentUICoreAgent(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ agent: AgentUICoreAgent }>(
    runtime,
    "DELETE",
    `/agents/${encodeURIComponent(agentId)}`,
  );
}

export async function getIrisProjects(runtime?: HermesRuntimeConfig) {
  return coreRequest<{ projects: IrisProject[] }>(runtime, "GET", "/projects");
}

export async function createIrisProject(
  payload: {
    name: string;
    defaultAgentId: string;
    systemPrompt?: string;
    metadata?: CoreMetadata;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ project: IrisProject }>(runtime, "POST", "/projects", payload);
}

export async function updateIrisProject(
  projectId: string,
  payload: {
    name?: string;
    defaultAgentId?: string;
    systemPrompt?: string;
    metadata?: CoreMetadata;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ project: IrisProject }>(
    runtime,
    "PATCH",
    `/projects/${encodeURIComponent(projectId)}`,
    payload,
  );
}

export async function archiveIrisProject(projectId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ project: IrisProject }>(
    runtime,
    "DELETE",
    `/projects/${encodeURIComponent(projectId)}`,
  );
}

export async function getIrisProjectSessions(
  projectId: string,
  limit = 80,
  runtime?: HermesRuntimeConfig,
) {
  const query = new URLSearchParams({ limit: String(limit) });
  return coreRequest<{ sessions: AgentUICoreSession[] }>(
    runtime,
    "GET",
    `/projects/${encodeURIComponent(projectId)}/sessions?${query}`,
  );
}

export async function linkIrisProjectSession(
  projectId: string,
  sessionId: string,
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ session: AgentUICoreSession }>(
    runtime,
    "POST",
    `/projects/${encodeURIComponent(projectId)}/sessions`,
    { sessionId },
  );
}

export async function getAgentUICoreSessions(agentId: string, limit = 80, runtime?: HermesRuntimeConfig) {
  const query = new URLSearchParams({ agentId, limit: String(limit) });
  return coreRequest<{ sessions: AgentUICoreSession[] }>(runtime, "GET", `/sessions?${query}`);
}

export async function createAgentUICoreSession(
  payload: {
    agentId: string;
    title: string;
    externalChatId?: string;
    externalSessionId?: string;
    projectId?: string | null;
    metadata?: CoreMetadata;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ session: AgentUICoreSession }>(runtime, "POST", "/sessions", payload);
}

export async function getAgentUICoreSession(
  sessionId: string,
  runtime?: HermesRuntimeConfig,
  reference: { externalSessionId?: string; externalChatId?: string } = {},
) {
  const query = sessionReferenceQuery(reference);
  return coreRequest<{ session: AgentUICoreSession }>(
    runtime,
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}${query}`,
  );
}

export async function updateAgentUICoreSession(
  sessionId: string,
  payload: { title?: string; metadata?: CoreMetadata },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ session: AgentUICoreSession }>(
    runtime,
    "PATCH",
    `/sessions/${encodeURIComponent(sessionId)}`,
    payload,
  );
}

export async function deleteAgentUICoreSession(
  sessionId: string,
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ sessionId: string }>(
    runtime,
    "DELETE",
    `/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function updateAgentUICoreSessionReadState(
  sessionId: string,
  state: "read" | "unread",
  runtime?: HermesRuntimeConfig,
  metadata: CoreMetadata = {},
) {
  return coreRequest<{ readState: AgentUICoreSessionReadState }>(
    runtime,
    "PATCH",
    `/sessions/${encodeURIComponent(sessionId)}/read-state`,
    { state, metadata },
  );
}

export async function getAgentUICoreSessionMessages(
  sessionId: string,
  runtime?: HermesRuntimeConfig,
  reference: { externalSessionId?: string; externalChatId?: string } = {},
) {
  const query = sessionReferenceQuery(reference);
  return coreRequest<{ sessionId: string; messages: AgentUICoreMessage[]; warning?: string }>(
    runtime,
    "GET",
    `/sessions/${encodeURIComponent(sessionId)}/messages${query}`,
  );
}

function sessionReferenceQuery(reference: { externalSessionId?: string; externalChatId?: string }) {
  const query = new URLSearchParams();
  if (reference.externalSessionId) query.set("externalSessionId", reference.externalSessionId);
  if (reference.externalChatId) query.set("externalChatId", reference.externalChatId);
  const value = query.toString();
  return value ? `?${value}` : "";
}

export async function sendAgentUICoreMessage(
  sessionId: string,
  payload: {
    text: string;
    attachments?: CoreMessageAttachmentRef[];
    model?: HermesModelSelection | null;
    clientMessageId?: string;
    metadata?: CoreMetadata;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<AgentUICoreSendMessageResult>(
    runtime,
    "POST",
    `/sessions/${encodeURIComponent(sessionId)}/messages`,
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
    kind?: AttachmentKind;
    profile: string;
    sessionId?: string;
    messageId?: string;
    runtimeId?: string;
    metadata?: CoreMetadata;
  },
  runtime?: HermesRuntimeConfig,
) {
  if (payload.file) {
    const form = new FormData();
    form.set("file", payload.file, payload.name || payload.file.name);
    form.set("profile", payload.profile);
    form.set("runtimeId", payload.runtimeId || "runtime_local_hermes");
    if (payload.mimeType) form.set("mimeType", payload.mimeType);
    form.set("kind", payload.kind || attachmentKindFromMime(payload.mimeType || payload.file.type, payload.name));
    if (payload.sessionId) form.set("sessionId", payload.sessionId);
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
    const result = await invoke<CoreResponse<{ attachment: AgentUICoreAttachment }>>("core_bridge", {
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

export async function getAgentUICoreAttachmentDataUrl(
  runtime: HermesRuntimeConfig | undefined,
  path: string,
  mimeType = "application/octet-stream",
  filename = "",
): Promise<CoreResponse<{ dataUrl: string; mimeType: string; localPath?: string }>> {
  if (/^(blob|data|asset):/i.test(path)) return { ok: true, dataUrl: path, mimeType };
  let bridgeMimeType = mimeType;
  if (!needsNativeAttachmentData(mimeType, filename)) {
    try {
      const response = await fetch(path, { headers: { Accept: mimeType || "*/*" } });
      if (response.ok) {
        const blob = await response.blob();
        const responseMimeType = response.headers?.get("Content-Type") || blob.type || "";
        if (needsNativeAttachmentData(responseMimeType, filename)) {
          bridgeMimeType = responseMimeType || mimeType;
        } else {
          return { ok: true, dataUrl: await blobToDataUrl(blob), mimeType: responseMimeType || mimeType };
        }
      } else if (response.status !== 401 && response.status !== 403) {
        return { ok: false, dataUrl: "", mimeType, error: `HTTP ${response.status}` };
      }
    } catch {
      // Fall through to the native bridge; it can attach stored Core credentials.
    }
  }

  return invoke<CoreResponse<{ dataUrl: string; mimeType: string; localPath?: string }>>("core_bridge", {
    action: "core_attachment_data",
    payload: { path, mimeType: bridgeMimeType, filename, runtime },
  });
}

function needsNativeAttachmentData(mimeType: string, filename = "") {
  const normalized = (mimeType || "").split(";", 1)[0].trim().toLowerCase();
  const lowerFilename = filename.toLowerCase();
  return (
    normalized === "audio/webm" ||
    normalized === "video/webm" ||
    normalized === "audio/ogg" ||
    normalized === "application/ogg" ||
    lowerFilename.endsWith(".webm") ||
    lowerFilename.endsWith(".ogg")
  );
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read attachment data."));
    reader.readAsDataURL(blob);
  });
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

function coreAgentToHermesProfile(agent: AgentUICoreAgent) {
  const metadata = agent.metadata || {};
  return {
    name: agent.runtimeProfile || agent.displayName,
    path: stringMetadata(metadata.path),
    active: Boolean(agent.isDefault),
    exists: metadata.exists !== false,
    model: stringMetadata(metadata.model) || "not configured",
    provider: stringMetadata(metadata.provider) || "not configured",
    memoryBytes: numberMetadata(metadata.memoryBytes),
    memoryUpdatedAt: nullableNumberMetadata(metadata.memoryUpdatedAt),
    skillCount: numberMetadata(metadata.skillCount),
    sessionCount: 0,
    estimatedCostUsd: null,
    gatewayRunning: Boolean(metadata.gatewayRunning),
  };
}

function firstRuntimeProbe(runtimes: CoreRuntimeRow[]) {
  const runtime = runtimes[0] || {};
  const probe = runtime.lastProbe || runtime.last_probe;
  if (probe) return probe;
  return {
    gateway: { ok: false },
    management: { ok: false },
    agentuiAdapter: { ok: false },
  };
}

function endpointFromResponse(response: CoreResponse<CoreStatusResponse | CoreHealthResponse>, url: string) {
  return {
    ok: Boolean(response.ok),
    url,
    error: response.ok ? undefined : response.error,
  };
}

function stringMetadata(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumberMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function cancelAgentUICoreMessage(sessionId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ sessionId: string; runtime?: CoreRuntimeResult }>(
    runtime,
    "POST",
    `/sessions/${encodeURIComponent(sessionId)}/cancel`,
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
  return coreRequest<AgentUICoreModelCatalog>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/models`);
}

export async function getAgentUICoreSlashCommands(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<AgentUICoreSlashCommandCatalog>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/slash-commands`);
}

export async function completeAgentUICoreSlashCommand(
  agentId: string,
  text: string,
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<AgentUICoreSlashCommandCatalog>(
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
    repeat?: number | null;
    deliver?: string;
    deliverToSessionId?: string;
    metadata?: CoreMetadata;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ automation: AgentUICoreAutomation; runtime?: CoreRuntimeResult }>(
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
    repeat?: number | null;
    deliver?: string;
    deliverToSessionId?: string;
    status?: string;
    metadata?: CoreMetadata;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ automation: AgentUICoreAutomation; runtime?: CoreRuntimeResult }>(
    runtime,
    "PATCH",
    `/automations/${encodeURIComponent(automationId)}`,
    payload,
  );
}

export async function deleteAgentUICoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automationId: string; runtime?: CoreRuntimeResult }>(
    runtime,
    "DELETE",
    `/automations/${encodeURIComponent(automationId)}`,
  );
}

export async function pauseAgentUICoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automation: AgentUICoreAutomation; runtime?: CoreRuntimeResult }>(
    runtime,
    "POST",
    `/automations/${encodeURIComponent(automationId)}/pause`,
    {},
  );
}

export async function resumeAgentUICoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automation: AgentUICoreAutomation; runtime?: CoreRuntimeResult }>(
    runtime,
    "POST",
    `/automations/${encodeURIComponent(automationId)}/resume`,
    {},
  );
}

export async function runAgentUICoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automation: AgentUICoreAutomation; runtime?: CoreRuntimeResult }>(
    runtime,
    "POST",
    `/automations/${encodeURIComponent(automationId)}/run`,
    {},
  );
}
