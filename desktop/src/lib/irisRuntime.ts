import { invoke } from "@tauri-apps/api/core";
import {
  activateIrisCoreAgent,
  cloneIrisCoreAgent,
  completeIrisCoreSlashCommand,
  createIrisCoreAgent,
  createIrisCoreAgentSkill,
  deleteIrisCoreAgent,
  deleteIrisCoreSession,
  getIrisCoreAgentForProfile,
  getIrisCoreAgentMemory,
  getIrisCoreAgentSkill,
  getIrisCoreAgentSkills,
  getIrisCoreSession,
  getIrisCoreSessionMessages,
  getIrisCoreSessions,
  getIrisCoreEvents,
  getIrisCoreModels,
  getIrisCoreSlashCommands,
  getIrisCoreStatus,
  renameIrisCoreAgent,
  resetIrisCoreAgentMemory,
  saveIrisCoreAgentMemory,
  saveIrisCoreAgentSkill,
  updateIrisCoreSession,
} from "./irisCore";
import {
  irisCoreSessionToHermes,
  irisCoreEventToDeliveryMessage,
  irisCoreMessageToHermes,
} from "./irisCoreMappings";
import type {
  HermesMemory,
  HermesModelCatalog,
  HermesSessionDetail,
  HermesSessionsResult,
  HermesRuntimeConfig,
  HermesSkillDetail,
  HermesSkills,
  HermesSlashCommandsResult,
  HermesSlashCompletionResult,
  RemoteCredentialKind,
  RemoteCredentialStatus,
} from "../types/hermes";
import { resolveCoreApiUrl } from "../app/runtimeConfig";

// Compatibility facade: existing desktop UI code still imports Hermes-shaped
// functions and types, while the active read path is backed by Iris Core.

type BridgeResponse<T> = T & {
  ok: boolean;
  error?: string;
};

async function bridge<T>(action: string, payload: Record<string, unknown> = {}) {
  return invoke<BridgeResponse<T>>("core_bridge", { action, payload });
}

export async function getIrisStatus(runtime?: HermesRuntimeConfig, profile?: string) {
  const status = await getIrisCoreStatus(runtime, profile);
  if (!profile) return status;
  const activeProfile =
    status.profiles.find((item) => item.name === profile) ||
    status.activeProfile;
  return { ...status, activeProfile };
}

export async function getIrisMemory(profile?: string, runtime?: HermesRuntimeConfig) {
  const agentResult = await getIrisCoreAgentForProfile(profile || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return emptyMemory(profile || "default", agentResultError(agentResult, "Could not resolve Iris agent."));
  }
  const result = await getIrisCoreAgentMemory(agentResult.agent.id, runtime);
  return result.ok ? result : emptyMemory(agentResult.agent.runtimeProfile, result.error || "Could not load memory from Iris Core.");
}

export async function saveIrisMemoryFile(payload: {
  profile?: string;
  file: "memory" | "user";
  content: string;
  expectedUpdatedAt?: number | null;
  runtime?: HermesRuntimeConfig;
}) {
  const agentResult = await getIrisCoreAgentForProfile(payload.profile || "default", payload.runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return { ok: false, profile: payload.profile || "default", memory: emptyMemory(payload.profile || "default"), error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  }
  const result = await saveIrisCoreAgentMemory(
    agentResult.agent.id,
    payload.file,
    { content: payload.content, expectedUpdatedAt: payload.expectedUpdatedAt },
    payload.runtime,
  );
  return result.ok ? result : { ...result, profile: agentResult.agent.runtimeProfile, memory: emptyMemory(agentResult.agent.runtimeProfile) };
}

export async function resetIrisMemoryFile(payload: {
  profile?: string;
  file: "memory" | "user" | "all";
  confirm: string;
  runtime?: HermesRuntimeConfig;
}) {
  const agentResult = await getIrisCoreAgentForProfile(payload.profile || "default", payload.runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return { ok: false, profile: payload.profile || "default", memory: emptyMemory(payload.profile || "default"), error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  }
  const result = await resetIrisCoreAgentMemory(
    agentResult.agent.id,
    payload.file,
    { confirm: payload.confirm },
    payload.runtime,
  );
  return result.ok ? result : { ...result, profile: agentResult.agent.runtimeProfile, memory: emptyMemory(agentResult.agent.runtimeProfile) };
}

export async function getIrisSkills(profile?: string, runtime?: HermesRuntimeConfig) {
  const agentResult = await getIrisCoreAgentForProfile(profile || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return emptySkills(profile || "default", agentResultError(agentResult, "Could not resolve Iris agent."));
  }
  const result = await getIrisCoreAgentSkills(agentResult.agent.id, runtime);
  return result.ok ? result : emptySkills(agentResult.agent.runtimeProfile, result.error || "Could not load skills from Iris Core.");
}

export async function getIrisSkillDetail(
  profile: string | undefined,
  skillId: string,
  runtime?: HermesRuntimeConfig,
) {
  const agentResult = await getIrisCoreAgentForProfile(profile || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return emptySkillDetail(profile || "default", agentResultError(agentResult, "Could not resolve Iris agent."));
  }
  const result = await getIrisCoreAgentSkill(agentResult.agent.id, skillId, runtime);
  return result.ok ? result : emptySkillDetail(agentResult.agent.runtimeProfile, result.error || "Could not load skill from Iris Core.");
}

export async function saveIrisSkill(payload: {
  profile?: string;
  id?: string;
  path?: string;
  name: string;
  category: string;
  content: string;
  runtime?: HermesRuntimeConfig;
}) {
  const agentResult = await getIrisCoreAgentForProfile(payload.profile || "default", payload.runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return { ok: false, profile: payload.profile || "default", skill: emptySkillDetail(payload.profile || "default"), error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  }
  const savePayload = {
    name: payload.name,
    category: payload.category,
    path: payload.path,
    content: payload.content,
  };
  const result = payload.id
    ? await saveIrisCoreAgentSkill(agentResult.agent.id, payload.id, savePayload, payload.runtime)
    : await createIrisCoreAgentSkill(agentResult.agent.id, savePayload, payload.runtime);
  return result.ok ? result : { ...result, profile: agentResult.agent.runtimeProfile, skill: emptySkillDetail(agentResult.agent.runtimeProfile) };
}

export async function getIrisSessions(
  profile?: string,
  limit = 80,
  runtime?: HermesRuntimeConfig,
): Promise<HermesSessionsResult> {
  const targetProfile = profile || "default";
  try {
    const agentResult = await getIrisCoreAgentForProfile(targetProfile, runtime);
    if (!agentResult.ok || !agentResult.agent) {
      return emptySessions(
        targetProfile,
        agentResultError(agentResult, "Could not resolve Iris agent."),
        runtime,
      );
    }
    const result = await getIrisCoreSessions(agentResult.agent.id, limit, runtime);
    if (!result.ok) {
      return emptySessions(
        agentResult.agent.runtimeProfile,
        result.error || "Could not load sessions from Iris Core.",
        runtime,
      );
    }
    return {
      ok: true,
      profile: agentResult.agent.runtimeProfile,
      path: `${resolveCoreApiUrl(runtime)}/v1/sessions`,
      source: "hermes-management" as const,
      schemaVersion: null,
      sessions: result.sessions.map(irisCoreSessionToHermes),
    };
  } catch (error) {
    return emptySessions(
      targetProfile,
      error instanceof Error ? error.message : "Could not load sessions from Iris Core.",
      runtime,
    );
  }
}

export async function getIrisModelCatalog(profile?: string, runtime?: HermesRuntimeConfig) {
  const targetProfile = profile || "default";
  try {
    const agentResult = await getIrisCoreAgentForProfile(targetProfile, runtime);
    if (!agentResult.ok || !agentResult.agent) {
      return emptyModelCatalog(targetProfile, agentResultError(agentResult, "Could not resolve Iris agent."));
    }
    const result = await getIrisCoreModels(agentResult.agent.id, runtime);
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

export async function getIrisSlashCommands(profile?: string, runtime?: HermesRuntimeConfig) {
  const targetProfile = profile || "default";
  try {
    const agentResult = await getIrisCoreAgentForProfile(targetProfile, runtime);
    if (!agentResult.ok || !agentResult.agent) {
      return emptySlashCommands(targetProfile, agentResultError(agentResult, "Could not resolve Iris agent."));
    }
    const result = await getIrisCoreSlashCommands(agentResult.agent.id, runtime);
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

export async function completeIrisSlashCommand(
  text: string,
  profile?: string,
  runtime?: HermesRuntimeConfig,
) {
  try {
    const agentResult = await getIrisCoreAgentForProfile(profile || "default", runtime);
    if (!agentResult.ok || !agentResult.agent) {
      return emptySlashCompletion(agentResultError(agentResult, "Could not resolve Iris agent."));
    }
    const result = await completeIrisCoreSlashCommand(agentResult.agent.id, text, runtime);
    return result.ok
      ? result as HermesSlashCompletionResult
      : emptySlashCompletion(result.error || "Could not complete slash command through Iris Core.");
  } catch (error) {
    return emptySlashCompletion(
      error instanceof Error ? error.message : "Could not complete slash command through Iris Core.",
    );
  }
}

export async function getIrisSessionDetail(
  profile: string | undefined,
  sessionId: string,
  runtime?: HermesRuntimeConfig,
) {
  if (!sessionId.startsWith("session_")) {
    return emptySessionDetail(
      profile || "default",
      sessionId,
      "Legacy session history is no longer loaded directly. Start a follow-up to link it through Iris Core.",
      runtime,
    );
  }
  try {
    const [sessionResult, messagesResult] = await Promise.all([
      getIrisCoreSession(sessionId, runtime),
      getIrisCoreSessionMessages(sessionId, runtime),
    ]);
    if (!sessionResult.ok || !messagesResult.ok) {
      return emptySessionDetail(
        profile || "default",
        sessionId,
        sessionResult.error || messagesResult.error || "Could not load this session from Iris Core.",
        runtime,
      );
    }
    return {
      ok: true,
      profile: sessionResult.session.runtimeProfile || profile || "default",
      path: `${resolveCoreApiUrl(runtime)}/v1/sessions/${sessionId}`,
      source: "hermes-management" as const,
      schemaVersion: null,
      session: irisCoreSessionToHermes(sessionResult.session),
      messages: messagesResult.messages.map((message) => irisCoreMessageToHermes(message, sessionId)),
      warning: messagesResult.warning,
      error: undefined,
    };
  } catch (error) {
    return emptySessionDetail(
      profile || "default",
      sessionId,
      error instanceof Error ? error.message : "Could not load this session from Iris Core.",
      runtime,
    );
  }
}

export async function renameIrisSession(
  _profile: string | undefined,
  sessionId: string,
  title: string,
  runtime?: HermesRuntimeConfig,
) {
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    return { ok: false, session: null, error: "Session title is required." };
  }
  if (!sessionId.startsWith("session_")) {
    return {
      ok: false,
      session: null,
      error: "Legacy session titles cannot be renamed until they are linked through Iris Core.",
    };
  }
  try {
    const result = await updateIrisCoreSession(sessionId, { title: cleanTitle }, runtime);
    if (!result.ok || !result.session) {
      return {
        ok: false,
        session: null,
        error: result.error || "Could not rename this session through Iris Core.",
      };
    }
    return {
      ok: true,
      session: irisCoreSessionToHermes(result.session),
      error: undefined,
    };
  } catch (error) {
    return {
      ok: false,
      session: null,
      error: error instanceof Error ? error.message : "Could not rename this session through Iris Core.",
    };
  }
}

export async function deleteIrisSession(
  _profile: string | undefined,
  sessionId: string,
  runtime?: HermesRuntimeConfig,
) {
  if (!sessionId.startsWith("session_")) {
    return {
      ok: false,
      sessionId,
      error: "Legacy sessions cannot be deleted until they are linked through Iris Core.",
    };
  }
  try {
    const result = await deleteIrisCoreSession(sessionId, runtime);
    if (!result.ok) {
      return {
        ok: false,
        sessionId,
        error: sessionDeleteErrorMessage(result.error),
      };
    }
    return { ok: true, sessionId: result.sessionId || sessionId, error: undefined };
  } catch (error) {
    return {
      ok: false,
      sessionId,
      error: error instanceof Error ? error.message : "Could not delete this session.",
    };
  }
}

function sessionDeleteErrorMessage(error: string | undefined) {
  if ((error || "").toLowerCase().includes("method not allowed")) {
    return "Iris Core needs to be restarted before sessions can be deleted.";
  }
  return error || "Could not delete this session through Iris Core.";
}

export async function getIrisInboxMessages(
  after = 0,
  limit = 50,
  runtime?: HermesRuntimeConfig,
  profile?: string,
) {
  try {
    let agentId = "";
    if (profile) {
      const agentResult = await getIrisCoreAgentForProfile(profile, runtime);
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
    const result = await getIrisCoreEvents(after, limit, runtime, agentId);
    if (result.ok) {
      const messages = result.events
        .filter((event) => event.type.startsWith("message.assistant") || event.type === "message.error")
        .map((event) => irisCoreEventToDeliveryMessage(event, profile || "default"));
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

export async function createIrisAgent(name: string, runtime?: HermesRuntimeConfig) {
  const result = await createIrisCoreAgent({ name }, runtime);
  return profileActionResult(result);
}

export async function cloneIrisAgent(source: string, name: string, runtime?: HermesRuntimeConfig) {
  const agentResult = await getIrisCoreAgentForProfile(source || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, profile: source, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  const result = await cloneIrisCoreAgent(agentResult.agent.id, { name }, runtime);
  return profileActionResult(result);
}

export async function renameIrisAgent(source: string, name: string, runtime?: HermesRuntimeConfig) {
  const agentResult = await getIrisCoreAgentForProfile(source || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, profile: source, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  const result = await renameIrisCoreAgent(agentResult.agent.id, { name }, runtime);
  return profileActionResult(result);
}

export async function switchIrisAgent(name: string, runtime?: HermesRuntimeConfig) {
  const agentResult = await getIrisCoreAgentForProfile(name || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, profile: name, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  const result = await activateIrisCoreAgent(agentResult.agent.id, runtime);
  return profileActionResult(result);
}

export async function deleteIrisAgent(name: string, runtime?: HermesRuntimeConfig) {
  const agentResult = await getIrisCoreAgentForProfile(name || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, profile: name, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  const result = await deleteIrisCoreAgent(agentResult.agent.id, runtime);
  return profileActionResult(result);
}

export async function getRemoteCredentialStatus(kind: RemoteCredentialKind, connectionId = "") {
  return bridge<RemoteCredentialStatus>("remote_credential_status", { kind, connectionId });
}

export async function saveRemoteCredential(kind: RemoteCredentialKind, token: string, connectionId = "") {
  return bridge<RemoteCredentialStatus>("remote_credential_save", { kind, token, connectionId });
}

export async function deleteRemoteCredential(kind: RemoteCredentialKind, connectionId = "") {
  return bridge<RemoteCredentialStatus>("remote_credential_delete", { kind, connectionId });
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

function emptyMemory(profile: string, error = ""): HermesMemory {
  const emptyFile = (name: string) => ({
    name,
    path: "",
    exists: false,
    updatedAt: null,
    bytes: 0,
    content: "",
  });
  return {
    ok: !error,
    profile,
    path: "",
    memory: emptyFile("MEMORY.md"),
    user: emptyFile("USER.md"),
    history: [],
    ...(error ? { error } : {}),
  };
}

function emptySkills(profile: string, error: string): HermesSkills {
  return {
    ok: false,
    profile,
    path: "",
    skills: [],
    error,
  };
}

function emptySkillDetail(_profile: string, error = ""): HermesSkillDetail {
  return {
    id: "",
    name: "",
    path: "",
    category: "personal",
    description: "",
    updatedAt: null,
    source: "installed",
    version: null,
    tags: [],
    bytes: 0,
    metadata: {},
    content: "",
    history: [],
    ...(error ? { error } : {}),
  } as HermesSkillDetail;
}

function profileActionResult(result: { ok: boolean; agent?: { runtimeProfile: string }; error?: string }) {
  return result.ok && result.agent
    ? { ok: true, profile: result.agent.runtimeProfile }
    : { ok: false, profile: "", error: result.error || "Agent operation failed." };
}

function emptySessions(profile: string, error: string, runtime?: HermesRuntimeConfig): HermesSessionsResult {
  return {
    ok: false,
    profile,
    path: `${resolveCoreApiUrl(runtime)}/v1/sessions`,
    source: "hermes-management",
    schemaVersion: null,
    sessions: [],
    error,
  };
}

function emptySessionDetail(
  profile: string,
  sessionId: string,
  error: string,
  runtime?: HermesRuntimeConfig,
): HermesSessionDetail {
  return {
    ok: false,
    profile,
    path: `${resolveCoreApiUrl(runtime)}/v1/sessions/${sessionId}`,
    source: "hermes-management",
    schemaVersion: null,
    session: null,
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

export { irisCoreEventToDeliveryMessage } from "./irisCoreMappings";
