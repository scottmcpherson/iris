import { invoke } from "@tauri-apps/api/core";
import {
  createProject as createSharedProject,
  createSession as createSharedSession,
  eventStreamUrl as sharedEventStreamUrl,
  getEvents as getSharedEvents,
  getLatestEventCursor as getSharedLatestEventCursor,
  getProjectSessions as getSharedProjectSessions,
  getProjects as getSharedProjects,
  getSession as getSharedSession,
  getSessionMessages as getSharedSessionMessages,
  getSessions as getSharedSessions,
  sendMessage as sendSharedMessage,
} from "@iris/core-client";
import type {
  HermesSessionMessage,
  HermesModelProvider,
  HermesModelSelection,
  HermesRuntimeConfig,
} from "../types/hermes";
import {
  activeCoreConnection,
  connectionTransport,
  hermesOwner,
} from "../app/runtimeConfig";
import desktopPackage from "../../package.json";
import type {
  HermesMemory,
  HermesMemorySaveResult,
  HermesProfileAlias,
  HermesProfileConfig,
  HermesProfileEnv,
  HermesProfileFile,
  HermesProfileIdentity,
  HermesSkillCatalog,
  HermesSkillDeleteResult,
  HermesSkillDetail,
  HermesSkillSaveResult,
  HermesSkills,
  HermesStatus,
} from "../types/hermes";
import { coreAttachmentUrl, coreBaseUrl, coreRequest, desktopIrisCoreClient, type CoreResponse } from "./coreTransport";
import type { AttachmentKind } from "../app/types";
import { attachmentKindFromMime } from "../shared/files";

type CorePrimitive = string | number | boolean | null;
type CoreJsonValue = CorePrimitive | CoreJsonValue[] | { [key: string]: CoreJsonValue };
export type CoreMetadata = { [key: string]: CoreJsonValue };

export type CoreEndpointProbe = {
  ok: boolean;
  url?: string;
  status?: number;
  profile?: string;
  requestedProfile?: string;
  error?: string;
};

export type CoreRuntimeProbe = {
  gateway: CoreEndpointProbe;
  management: CoreEndpointProbe;
  irisAdapter: CoreEndpointProbe;
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
  service?: string;
  version?: string;
  pid?: number;
  managed?: boolean | null;
  bindHost?: string;
  port?: number;
};

export type CoreMessageAttachmentRef = {
  id: string;
};

export type CoreRuntimeResult = {
  ok?: boolean;
  accepted?: boolean;
  chatId?: string;
  messageId?: string;
  sessionId?: string;
  warning?: string;
  error?: string;
};

export type IrisCoreSendMessageResult = {
  sessionId: string;
  canonicalSessionId?: string;
  messageId: string;
  accepted: boolean;
  eventCursor: number;
  duplicate?: boolean;
  session?: IrisCoreSession;
  runtime?: CoreRuntimeResult;
};

export type IrisCoreModelCatalog = {
  profile: string;
  current: HermesModelSelection | null;
  providers: HermesModelProvider[];
  generatedAt: number;
  url?: string;
  status?: number;
};

export type IrisCoreSlashCommandCatalog = {
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

export type IrisCoreAgent = {
  id: string;
  runtimeId: string;
  runtimeKind: string;
  displayName: string;
  runtimeProfile: string;
  isDefault: boolean;
  sessionCount?: number;
  metadata?: CoreMetadata;
};

export type IrisCoreAgentMutationResult = {
  ok: boolean;
  agent: IrisCoreAgent;
  profile?: string;
  warnings?: string[];
  restartRequired?: boolean;
  adapterInstallRequired?: boolean;
  adapterInstall?: CoreMetadata;
  distribution?: CoreMetadata;
  error?: string;
};

export type IrisCoreSession = {
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
  readState?: IrisCoreSessionReadState;
};

export type IrisCoreSessionReadState = {
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

export type IrisCoreMessage = HermesSessionMessage & {
  sessionId?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type IrisCoreEvent = {
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

export type IrisCoreAutomation = {
  id: string;
  agentId: string;
  runtimeId: string;
  externalJobId: string;
  name: string;
  schedule: string | Record<string, unknown>;
  prompt: string;
  projectId?: string | null;
  deliverToSessionId: string;
  resolvedDeliveryTarget?: {
    platform?: string;
    deliver?: string;
    chatId?: string;
    sessionId?: string;
    projectId?: string | null;
  };
  status: string;
  enabled?: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  skills?: string[];
  skill?: string | null;
  script?: string | null;
  noAgent?: boolean;
  contextFrom?: string[];
  workdir?: string | null;
  enabledToolsets?: string[] | null;
  model?: string | null;
  provider?: string | null;
  baseUrl?: string | null;
  metadata: CoreMetadata;
};

export type IrisCoreGatewayAction = "start" | "stop" | "restart";

export type IrisCoreGatewayCommandResult = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  status?: number | null;
  error?: string;
};

export type IrisCoreGatewayControlResult = {
  ok: boolean;
  agentId: string;
  runtimeId: string;
  profile: string;
  action: IrisCoreGatewayAction | "status";
  command?: IrisCoreGatewayCommandResult;
  probe?: CoreRuntimeProbe;
  error?: string;
};

export type IrisCoreAttachment = {
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

export async function getIrisCoreAgents(runtime?: HermesRuntimeConfig) {
  return coreRequest<{ agents: IrisCoreAgent[] }>(runtime, "GET", "/agents");
}

export async function getIrisCoreStatus(runtime?: HermesRuntimeConfig, profile?: string) {
  const connection = activeCoreConnection(runtime);
  const [health, status, agents, runtimes] = await Promise.all([
    coreRequest<CoreHealthResponse>(runtime, "GET", "/health"),
    coreRequest<CoreStatusResponse>(runtime, "GET", "/status"),
    getIrisCoreAgents(runtime),
    coreRequest<{ runtimes: CoreRuntimeRow[] }>(runtime, "GET", "/runtimes"),
  ]);
  const ok = Boolean(health.ok || status.ok || agents.ok);
  const agentRows = agents.ok ? agents.agents : [];
  const activeAgent = agentRows.find((agent) => agent.isDefault) || agentRows[0] || null;
  const profiles = agentRows.map(coreAgentToHermesProfile);
  const runtimeRows = runtimes.ok ? runtimes.runtimes || [] : [];
  const requestedAgent = profile ? agentRows.find((agent) => agent.runtimeProfile === profile) : null;
  const gatewayStatus = requestedAgent
    ? await getIrisCoreGatewayStatus(requestedAgent.id, runtime)
    : null;
  const probe = gatewayStatus?.probe
    ? gatewayStatus.probe
    : firstRuntimeProbe(runtimeRows);
  const coreStatus = endpointFromResponse(status, coreBaseUrl(runtime));
  const coreVersion = typeof health.version === "string" ? health.version : "";
  const clientVersion = String(desktopPackage.version || "");
  const versionOk = Boolean(coreVersion && clientVersion && coreVersion === clientVersion);
  const coreVersionStatus = {
    ok: versionOk,
    coreVersion,
    clientVersion,
    reason: versionOk ? undefined : coreVersion ? "version-mismatch" as const : "unknown" as const,
  };
  const versionMismatch = ok && !coreVersionStatus.ok;
  const connected = ok && !versionMismatch;
  return {
    ok,
    connected,
    root: "",
    hermesPath: null,
    hermesPathSource: null,
    hermesPathCandidates: [],
    version: coreVersion || null,
    activeProfile: activeAgent ? coreAgentToHermesProfile(activeAgent) : profiles[0] || null,
    profiles,
    checkedAt: Math.floor(Date.now() / 1000),
    connectionMode: connection.mode,
    activeConnectionId: connection.id,
    activeConnectionName: connection.name,
    transport: connectionTransport(connection),
    hermesOwner: hermesOwner(connection),
    coreApiUrl: coreBaseUrl(runtime).replace(/\/v1$/, ""),
    activeApiUrl: "",
    coreVersionStatus,
    gatewayStatus: probe.gateway,
    remoteStatus: { ok: false },
    activeApiStatus: probe.irisAdapter,
    managementStatus: coreStatus,
    runtimeStatus: probe,
    error: versionMismatch
      ? versionMismatchMessage(connection.mode, coreVersionStatus.coreVersion, coreVersionStatus.clientVersion)
      : ok
        ? null
        : health.error || status.error || agents.error || "Could not reach Iris Core.",
  } as HermesStatus & { runtimeStatus?: CoreRuntimeProbe };
}

export async function getIrisCoreAgentForProfile(profile = "default", runtime?: HermesRuntimeConfig) {
  const result = await getIrisCoreAgents(runtime);
  if (!result.ok) return { ...result, agent: null };
  const targetProfile = profile || "default";
  const exact = result.agents.find((agent) => agent.runtimeProfile === targetProfile) || null;
  return {
    ok: true,
    agent:
      exact ||
      (targetProfile === "default"
        ? result.agents.find((agent) => agent.isDefault) || result.agents[0] || null
        : null),
  };
}

export async function getIrisCoreAgentMemory(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesMemory>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/memory`);
}

export async function saveIrisCoreAgentMemory(
  agentId: string,
  file: "memory" | "user",
  payload: { content: string; expectedUpdatedAt?: number | null; expectedContentHash?: string | null },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesMemorySaveResult>(
    runtime,
    "PUT",
    `/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(file)}`,
    payload,
  );
}

export async function resetIrisCoreAgentMemory(
  agentId: string,
  file: "memory" | "user" | "all",
  payload: {
    confirm: string;
    expectedUpdatedAt?: number | null;
    expectedUpdatedAtByFile?: Record<string, number | null>;
    expectedContentHash?: string | null;
    expectedContentHashByFile?: Record<string, string | null>;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesMemorySaveResult>(
    runtime,
    "DELETE",
    `/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(file)}`,
    payload,
  );
}

export async function getIrisCoreGatewayStatus(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<IrisCoreGatewayControlResult>(
    runtime,
    "GET",
    `/agents/${encodeURIComponent(agentId)}/gateway/status`,
  );
}

export async function controlIrisCoreGateway(
  agentId: string,
  action: IrisCoreGatewayAction,
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<IrisCoreGatewayControlResult>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/gateway/${encodeURIComponent(action)}`,
    {},
    { timeoutMs: 35_000 },
  );
}

export type IrisCoreInstallPluginResult = {
  ok: boolean;
  hermesHome: string;
  agentId?: string;
  runtimeId?: string;
  profile?: string;
  inboundPort?: number;
  pluginPath?: string;
  enabled?: boolean;
  enableError?: string;
  restartRequired?: boolean;
  installations?: Array<{
    ok?: boolean;
    hermesHome?: string;
    pluginPath?: string;
    enabled?: boolean;
    enableError?: string;
    restartRequired?: boolean;
    error?: string;
  }>;
  error?: string;
};

export async function installIrisCoreHermesPlugin(runtime?: HermesRuntimeConfig) {
  return coreRequest<IrisCoreInstallPluginResult>(
    runtime,
    "POST",
    `/system/install-hermes-plugin`,
    {},
    { timeoutMs: 60_000 },
  );
}

export async function installIrisCoreAgentHermesPlugin(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<IrisCoreInstallPluginResult>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/install-hermes-plugin`,
    {},
    { timeoutMs: 60_000 },
  );
}

export async function getIrisCoreAgentSkills(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesSkills>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/skills`);
}

export async function getIrisCoreAgentSkillCatalog(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesSkillCatalog>(
    runtime,
    "GET",
    `/agents/${encodeURIComponent(agentId)}/skills/catalog`,
  );
}

export async function getIrisCoreAgentSkill(agentId: string, skillId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesSkillDetail>(
    runtime,
    "GET",
    `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
  );
}

export async function createIrisCoreAgentSkill(
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

export async function installIrisCoreAgentSkill(
  agentId: string,
  payload: {
    sourceAgentId?: string;
    sourceProfile?: string;
    sourceSkillId: string;
    overwrite?: boolean;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesSkillSaveResult>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/skills/install`,
    payload,
  );
}

export async function saveIrisCoreAgentSkill(
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

export async function deleteIrisCoreAgentSkill(
  agentId: string,
  skillId: string,
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesSkillDeleteResult>(
    runtime,
    "DELETE",
    `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
    {},
  );
}

export async function createIrisCoreAgent(
  payload: { name: string; runtimeId?: string; metadata?: CoreMetadata; createAlias?: boolean; noAlias?: boolean; noSkills?: boolean },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<IrisCoreAgentMutationResult>(runtime, "POST", "/agents", payload);
}

export async function cloneIrisCoreAgent(
  agentId: string,
  payload: { name: string; metadata?: CoreMetadata; cloneMode?: "identity" | "all"; sourceProfile?: string; createAlias?: boolean; noAlias?: boolean; noSkills?: boolean },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<IrisCoreAgentMutationResult>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/clone`,
    payload,
  );
}

export async function renameIrisCoreAgent(
  agentId: string,
  payload: { name: string },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<IrisCoreAgentMutationResult>(
    runtime,
    "PATCH",
    `/agents/${encodeURIComponent(agentId)}`,
    payload,
  );
}

export async function activateIrisCoreAgent(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<IrisCoreAgentMutationResult>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/activate`,
    {},
  );
}

export async function deleteIrisCoreAgent(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<IrisCoreAgentMutationResult>(
    runtime,
    "DELETE",
    `/agents/${encodeURIComponent(agentId)}`,
  );
}

export async function getIrisCoreProfileIdentity(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesProfileIdentity>(
    runtime,
    "GET",
    `/agents/${encodeURIComponent(agentId)}/profile/identity`,
  );
}

export async function saveIrisCoreProfileSoul(
  agentId: string,
  payload: { content: string; expectedContentHash?: string | null },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesProfileFile>(
    runtime,
    "PUT",
    `/agents/${encodeURIComponent(agentId)}/profile/soul`,
    payload,
  );
}

export async function resetIrisCoreProfileSoul(
  agentId: string,
  payload: { content?: string; expectedContentHash?: string | null },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesProfileFile>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/profile/soul/reset`,
    payload,
  );
}

export async function saveIrisCoreProfileConfig(
  agentId: string,
  payload: { content: string; expectedContentHash?: string | null },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesProfileConfig>(
    runtime,
    "PUT",
    `/agents/${encodeURIComponent(agentId)}/profile/config`,
    payload,
  );
}

export async function updateIrisCoreProfileEnv(
  agentId: string,
  payload: { values: Record<string, string>; removeKeys?: string[] },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<HermesProfileEnv>(
    runtime,
    "PUT",
    `/agents/${encodeURIComponent(agentId)}/profile/env`,
    payload,
  );
}

export async function checkIrisCoreProfileConfig(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{
    ok: boolean;
    profile: string;
    commands: Record<string, IrisCoreGatewayCommandResult>;
    error?: string;
  }>(runtime, "POST", `/agents/${encodeURIComponent(agentId)}/profile/config/check`, {});
}

export async function getIrisCoreProfileAlias(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesProfileAlias>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/profile/alias`);
}

export async function createIrisCoreProfileAlias(agentId: string, alias: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesProfileAlias>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/profile/alias`,
    { alias },
  );
}

export async function deleteIrisCoreProfileAlias(agentId: string, alias: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<HermesProfileAlias>(
    runtime,
    "DELETE",
    `/agents/${encodeURIComponent(agentId)}/profile/alias`,
    { alias },
  );
}

export async function installIrisCoreProfileDistribution(
  payload: { source: string; name?: string; alias?: boolean; force?: boolean },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<IrisCoreAgentMutationResult>(
    runtime,
    "POST",
    "/profiles/install",
    payload,
    { timeoutMs: 190_000 },
  );
}

export async function importIrisCoreProfileArchive(
  payload: { file: File; name?: string },
  runtime?: HermesRuntimeConfig,
) {
  const form = new FormData();
  form.set("file", payload.file, payload.file.name);
  if (payload.name) form.set("name", payload.name);
  try {
    const response = await fetch(`${coreBaseUrl(runtime)}/profiles/import`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: form,
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok && parsed.ok !== false) {
      return { ok: false, error: parsed.error || `HTTP ${response.status}` } as CoreResponse<IrisCoreAgentMutationResult>;
    }
    return parsed as CoreResponse<IrisCoreAgentMutationResult>;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Profile import failed.",
    } as CoreResponse<IrisCoreAgentMutationResult>;
  }
}

export async function updateIrisCoreProfileDistribution(
  agentId: string,
  payload: { forceConfig?: boolean },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<CoreResponse<CoreMetadata> & { ok: boolean; profile: string; warnings?: string[] }>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/profile/distribution/update`,
    payload,
    { timeoutMs: 190_000 },
  );
}

export function irisCoreProfileExportUrl(agentId: string, runtime?: HermesRuntimeConfig) {
  return `${coreBaseUrl(runtime)}/agents/${encodeURIComponent(agentId)}/profile/export`;
}

export async function getIrisProjects(runtime?: HermesRuntimeConfig) {
  return getSharedProjects(desktopIrisCoreClient(runtime));
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
  return createSharedProject(desktopIrisCoreClient(runtime), payload);
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
  return getSharedProjectSessions(desktopIrisCoreClient(runtime), { projectId, limit });
}

export async function linkIrisProjectSession(
  projectId: string,
  sessionId: string,
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ session: IrisCoreSession }>(
    runtime,
    "POST",
    `/projects/${encodeURIComponent(projectId)}/sessions`,
    { sessionId },
  );
}

export async function getIrisCoreSessions(agentId: string, limit = 80, runtime?: HermesRuntimeConfig) {
  return getSharedSessions(desktopIrisCoreClient(runtime), { agentId, limit });
}

export async function createIrisCoreSession(
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
  return createSharedSession(desktopIrisCoreClient(runtime), payload);
}

export async function getIrisCoreSession(
  sessionId: string,
  runtime?: HermesRuntimeConfig,
  reference: { externalSessionId?: string; externalChatId?: string } = {},
) {
  return getSharedSession(desktopIrisCoreClient(runtime), { sessionId, ...reference });
}

export async function updateIrisCoreSession(
  sessionId: string,
  payload: { title?: string; metadata?: CoreMetadata },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ session: IrisCoreSession }>(
    runtime,
    "PATCH",
    `/sessions/${encodeURIComponent(sessionId)}`,
    payload,
  );
}

export async function deleteIrisCoreSession(
  sessionId: string,
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ sessionId: string }>(
    runtime,
    "DELETE",
    `/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function updateIrisCoreSessionReadState(
  sessionId: string,
  state: "read" | "unread",
  runtime?: HermesRuntimeConfig,
  metadata: CoreMetadata = {},
) {
  return coreRequest<{ readState: IrisCoreSessionReadState }>(
    runtime,
    "PATCH",
    `/sessions/${encodeURIComponent(sessionId)}/read-state`,
    { state, metadata },
  );
}

export async function getIrisCoreSessionMessages(
  sessionId: string,
  runtime?: HermesRuntimeConfig,
  reference: { externalSessionId?: string; externalChatId?: string } = {},
) {
  return getSharedSessionMessages(desktopIrisCoreClient(runtime), { sessionId, ...reference });
}

export async function sendIrisCoreMessage(
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
  return sendSharedMessage(desktopIrisCoreClient(runtime), sessionId, payload);
}

export async function uploadIrisCoreAttachment(
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
    const result = await uploadBrowserAttachment(payload, runtime);
    if (!shouldRetryAttachmentAsOctetStream(result, payload.mimeType)) return result;
    return uploadBrowserAttachment(octetStreamAttachmentPayload(payload), runtime);
  }

  if (payload.localPath) {
    const result = await invoke<CoreResponse<{ attachment: IrisCoreAttachment }>>("core_bridge", {
      action: "core_upload_path",
      payload: { ...payload, runtime, connectionId: activeCoreConnection(runtime)?.id },
    });
    const normalized = normalizeAttachmentUploadResponse(result, runtime);
    if (!shouldRetryAttachmentAsOctetStream(normalized, payload.mimeType)) return normalized;
    const retry = await invoke<CoreResponse<{ attachment: IrisCoreAttachment }>>("core_bridge", {
      action: "core_upload_path",
      payload: { ...octetStreamAttachmentPayload(payload), runtime, connectionId: activeCoreConnection(runtime)?.id },
    });
    return normalizeAttachmentUploadResponse(retry, runtime);
  }

  return { ok: false, error: "Attachment file is required." } as CoreResponse<{ attachment: IrisCoreAttachment }>;
}

async function uploadBrowserAttachment(
  payload: {
    file?: File;
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
  if (!payload.file) {
    return { ok: false, error: "Attachment file is required." } as CoreResponse<{ attachment: IrisCoreAttachment }>;
  }
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
      return { ok: false, error: parsed.error || `HTTP ${response.status}` } as CoreResponse<{ attachment: IrisCoreAttachment }>;
    }
    return normalizeAttachmentUploadResponse(parsed as CoreResponse<{ attachment: IrisCoreAttachment }>, runtime);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Attachment upload failed.",
    } as CoreResponse<{ attachment: IrisCoreAttachment }>;
  }
}

function shouldRetryAttachmentAsOctetStream(
  result: CoreResponse<{ attachment: IrisCoreAttachment }>,
  mimeType = "",
) {
  return !result.ok && mimeType !== "application/octet-stream" && /unsupported attachment type/i.test(result.error || "");
}

function octetStreamAttachmentPayload<T extends { mimeType?: string; metadata?: CoreMetadata }>(payload: T): T {
  return {
    ...payload,
    mimeType: "application/octet-stream",
    metadata: {
      ...payload.metadata,
      originalMimeType: payload.mimeType || "",
      uploadFallback: "octet-stream",
    },
  };
}

export function irisCoreAttachmentUrl(runtime: HermesRuntimeConfig | undefined, path: string | undefined) {
  return coreAttachmentUrl(runtime, path);
}

export async function getIrisCoreAttachmentDataUrl(
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
      // Fall through to the native bridge for WebView-only media conversion.
    }
  }

  return invoke<CoreResponse<{ dataUrl: string; mimeType: string; localPath?: string }>>("core_bridge", {
    action: "core_attachment_data",
    payload: { path, mimeType: bridgeMimeType, filename, runtime, connectionId: activeCoreConnection(runtime)?.id },
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
  result: CoreResponse<{ attachment: IrisCoreAttachment }>,
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

function coreAgentToHermesProfile(agent: IrisCoreAgent) {
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
    sessionCount: typeof agent.sessionCount === "number" ? agent.sessionCount : 0,
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
    irisAdapter: { ok: false },
  };
}

function endpointFromResponse(response: CoreResponse<CoreStatusResponse | CoreHealthResponse>, url: string) {
  return {
    ok: Boolean(response.ok),
    url,
    error: response.ok ? undefined : response.error,
  };
}

function versionMismatchMessage(mode: HermesRuntimeConfig["connectionMode"], coreVersion: string, clientVersion: string) {
  const coreLabel = coreVersion || "unknown";
  const clientLabel = clientVersion || "unknown";
  if (mode === "managed-local") {
    return `Version mismatch: bundled Iris Core is ${coreLabel}, but Iris Desktop is ${clientLabel}. Rebuild or reinstall Iris locally.`;
  }
  if (mode === "tailscale") {
    return `Version mismatch: the host is running Iris Core ${coreLabel}, but local Iris Desktop is ${clientLabel}. Update the host so both Iris installs match.`;
  }
  return `Version mismatch: Iris Core is ${coreLabel}, but Iris Desktop is ${clientLabel}. Use matching Iris builds.`;
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

export async function cancelIrisCoreMessage(sessionId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ sessionId: string; runtime?: CoreRuntimeResult }>(
    runtime,
    "POST",
    `/sessions/${encodeURIComponent(sessionId)}/cancel`,
    {},
  );
}

export async function getIrisCoreEvents(
  after = 0,
  limit = 200,
  runtime?: HermesRuntimeConfig,
  agentId = "",
) {
  return getSharedEvents(desktopIrisCoreClient(runtime), { after, limit, agentId });
}

export async function getIrisCoreAutomationEvents(
  limit = 50,
  runtime?: HermesRuntimeConfig,
  agentId = "",
) {
  const query = new URLSearchParams({
    after: "0",
    limit: String(limit),
    automationOnly: "true",
    order: "desc",
  });
  if (agentId) query.set("agentId", agentId);
  return coreRequest<{ events: IrisCoreEvent[]; cursor: number }>(runtime, "GET", `/events?${query}`);
}

export async function getIrisCoreLatestEventCursor(
  runtime?: HermesRuntimeConfig,
  agentId = "",
) {
  return getSharedLatestEventCursor(desktopIrisCoreClient(runtime), agentId);
}

export function irisCoreEventStreamUrl(
  runtime: HermesRuntimeConfig | undefined,
  after = 0,
  limit = 200,
  agentId = "",
) {
  return sharedEventStreamUrl(desktopIrisCoreClient(runtime), { after, limit, agentId });
}

// Server publishes named SSE events (event: message.assistant.delta, ...).
export const CORE_DELIVERY_EVENT_NAMES = [
  "message.assistant.delta",
  "message.assistant.completed",
  "message.assistant.error",
  "message.error",
] as const;

export type CoreEventStreamHandle = { close: () => void };

export type OpenCoreEventStreamOptions = {
  after: number;
  agentId: string;
  limit?: number;
  onEvent: (event: IrisCoreEvent) => void;
  onError: (error?: unknown) => void;
  onOpen?: () => void;
};

/**
 * Open the Core event stream, picking a transport that authenticates correctly:
 * a remote (tailscale) Core requires a bearer token, which the browser
 * `EventSource` cannot send — so for tokened connections we consume the SSE
 * response via an authed `fetch()` reader. Loopback / SSH-tunnel Core needs no
 * token, so we keep the simpler `EventSource` there. Either way the caller owns
 * reconnect (with `after = lastAppliedCursor`) and the polling fallback.
 */
export function openCoreEventStream(
  runtime: HermesRuntimeConfig | undefined,
  options: OpenCoreEventStreamOptions,
): CoreEventStreamHandle {
  const { after, agentId, limit = 200, onEvent, onError, onOpen } = options;
  const url = irisCoreEventStreamUrl(runtime, after, limit, agentId);
  const token = activeCoreConnection(runtime)?.tailscale?.deviceToken || "";
  return token
    ? openFetchEventStream(url, token, { onEvent, onError, onOpen })
    : openEventSourceStream(url, { onEvent, onError, onOpen });
}

function openEventSourceStream(
  url: string,
  { onEvent, onError, onOpen }: Pick<OpenCoreEventStreamOptions, "onEvent" | "onError" | "onOpen">,
): CoreEventStreamHandle {
  let closed = false;
  const source = new EventSource(url);
  const handle = (event: MessageEvent<string>) => {
    if (closed) return;
    const parsed = parseEventStreamData(event.data);
    if (parsed) onEvent(parsed);
  };
  source.onopen = () => {
    if (!closed) onOpen?.();
  };
  for (const eventName of CORE_DELIVERY_EVENT_NAMES) {
    source.addEventListener(eventName, handle as EventListener);
  }
  source.onerror = () => {
    if (!closed) onError();
  };
  return {
    close: () => {
      closed = true;
      // close() also stops EventSource's built-in auto-reconnect so the caller's
      // cursor-resume reconnect is the only one in play.
      source.close();
    },
  };
}

function openFetchEventStream(
  url: string,
  token: string,
  { onEvent, onError, onOpen }: Pick<OpenCoreEventStreamOptions, "onEvent" | "onError" | "onOpen">,
): CoreEventStreamHandle {
  const controller = new AbortController();
  let closed = false;
  void (async () => {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        if (!closed) onError(new Error(`Core event stream HTTP ${response.status}`));
        return;
      }
      if (!closed) onOpen?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const rawEvent = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = sseDataPayload(rawEvent);
          if (data) {
            const parsed = parseEventStreamData(data);
            if (parsed) onEvent(parsed);
          }
          separator = buffer.indexOf("\n\n");
        }
      }
      if (!closed) onError();
    } catch (error) {
      if (!closed && !(error instanceof DOMException && error.name === "AbortError")) {
        onError(error);
      }
    }
  })();
  return {
    close: () => {
      closed = true;
      controller.abort();
    },
  };
}

function sseDataPayload(rawEvent: string): string {
  // An SSE event block is `event:`/`id:`/`data:` lines; comments (`: keep-alive`)
  // carry no data. Concatenate the data lines per the SSE spec.
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return dataLines.join("\n");
}

function parseEventStreamData(data: string): IrisCoreEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const event = parsed as Partial<IrisCoreEvent>;
    if (typeof event.cursor !== "number" || typeof event.type !== "string") return null;
    return event as IrisCoreEvent;
  } catch {
    return null;
  }
}

export async function getIrisCoreModels(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<IrisCoreModelCatalog>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/models`);
}

export async function getIrisCoreSlashCommands(agentId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<IrisCoreSlashCommandCatalog>(runtime, "GET", `/agents/${encodeURIComponent(agentId)}/slash-commands`);
}

export async function completeIrisCoreSlashCommand(
  agentId: string,
  text: string,
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<IrisCoreSlashCommandCatalog>(
    runtime,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/slash-complete`,
    { text },
  );
}

export async function getIrisCoreAutomations(agentId: string, runtime?: HermesRuntimeConfig) {
  const query = new URLSearchParams({ agentId });
  return coreRequest<{ automations: IrisCoreAutomation[] }>(runtime, "GET", `/automations?${query}`);
}

export async function getIrisCoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automation: IrisCoreAutomation }>(
    runtime,
    "GET",
    `/automations/${encodeURIComponent(automationId)}`,
  );
}

export async function createIrisCoreAutomation(
  payload: {
    agentId: string;
    name: string;
    schedule: string;
    prompt: string;
    repeat?: number | null;
    deliver?: string;
    deliverToSessionId?: string;
    projectId?: string | null;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ automation: IrisCoreAutomation; runtime?: CoreRuntimeResult }>(
    runtime,
    "POST",
    "/automations",
    payload,
  );
}

export async function updateIrisCoreAutomation(
  automationId: string,
  payload: {
    name?: string;
    schedule?: string;
    prompt?: string;
    repeat?: number | null;
    deliver?: string;
    deliverToSessionId?: string;
    projectId?: string | null;
    status?: string;
  },
  runtime?: HermesRuntimeConfig,
) {
  return coreRequest<{ automation: IrisCoreAutomation; runtime?: CoreRuntimeResult }>(
    runtime,
    "PATCH",
    `/automations/${encodeURIComponent(automationId)}`,
    payload,
  );
}

export async function deleteIrisCoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automationId: string; runtime?: CoreRuntimeResult }>(
    runtime,
    "DELETE",
    `/automations/${encodeURIComponent(automationId)}`,
  );
}

export async function pauseIrisCoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automation: IrisCoreAutomation; runtime?: CoreRuntimeResult }>(
    runtime,
    "POST",
    `/automations/${encodeURIComponent(automationId)}/pause`,
    {},
  );
}

export async function resumeIrisCoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automation: IrisCoreAutomation; runtime?: CoreRuntimeResult }>(
    runtime,
    "POST",
    `/automations/${encodeURIComponent(automationId)}/resume`,
    {},
  );
}

export async function runIrisCoreAutomation(automationId: string, runtime?: HermesRuntimeConfig) {
  return coreRequest<{ automation: IrisCoreAutomation; runtime?: CoreRuntimeResult }>(
    runtime,
    "POST",
    `/automations/${encodeURIComponent(automationId)}/run`,
    {},
  );
}
