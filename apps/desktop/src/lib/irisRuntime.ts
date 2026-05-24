import {
  activateIrisCoreAgent,
  cloneIrisCoreAgent,
  completeIrisCoreSlashCommand,
  createIrisCoreAgent,
  createIrisCoreAgentSkill,
  deleteIrisCoreAgent,
  deleteIrisCoreAgentSkill,
  deleteIrisCoreSession,
  getIrisCoreAgentForProfile,
  getIrisCoreAgentMemory,
  getIrisCoreAgentSkill,
  getIrisCoreAgentSkillCatalog,
  getIrisCoreAgentSkills,
  getIrisCoreProfileAlias,
  getIrisCoreProfileIdentity,
  getIrisCoreSession,
  getIrisCoreSessionMessages,
  getIrisCoreSessions,
  getIrisCoreEvents,
  getIrisCoreModels,
  getIrisCoreSlashCommands,
  checkIrisCoreProfileConfig,
  createIrisCoreProfileAlias,
  installIrisCoreAgentSkill,
  installIrisCoreProfileDistribution,
  importIrisCoreProfileArchive,
  getIrisCoreStatus,
  renameIrisCoreAgent,
  resetIrisCoreAgentMemory,
  resetIrisCoreProfileSoul,
  saveIrisCoreAgentMemory,
  saveIrisCoreAgentSkill,
  saveIrisCoreProfileConfig,
  saveIrisCoreProfileSoul,
  updateIrisCoreProfileDistribution,
  updateIrisCoreProfileEnv,
  deleteIrisCoreProfileAlias,
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
  HermesProfileAlias,
  HermesProfileIdentity,
  HermesSessionDetail,
  HermesSessionsResult,
  HermesRuntimeConfig,
  HermesSkillCatalog,
  HermesSkillDeleteResult,
  HermesSkillDetail,
  HermesSkillSaveResult,
  HermesSkills,
  HermesSlashCommandsResult,
  HermesSlashCompletionResult,
} from "../types/hermes";
import { resolveCoreApiUrl } from "../app/runtimeConfig";

// Compatibility facade: existing desktop UI code still imports Hermes-shaped
// functions and types, while the active read path is backed by Iris Core.

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
  expectedContentHash?: string | null;
  runtime?: HermesRuntimeConfig;
}) {
  const agentResult = await getIrisCoreAgentForProfile(payload.profile || "default", payload.runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return { ok: false, profile: payload.profile || "default", memory: emptyMemory(payload.profile || "default"), error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  }
  const result = await saveIrisCoreAgentMemory(
    agentResult.agent.id,
    payload.file,
    {
      content: payload.content,
      expectedUpdatedAt: payload.expectedUpdatedAt,
      expectedContentHash: payload.expectedContentHash,
    },
    payload.runtime,
  );
  return result.ok ? result : { ...result, profile: agentResult.agent.runtimeProfile, memory: emptyMemory(agentResult.agent.runtimeProfile) };
}

export async function resetIrisMemoryFile(payload: {
  profile?: string;
  file: "memory" | "user" | "all";
  confirm: string;
  expectedUpdatedAt?: number | null;
  expectedUpdatedAtByFile?: Record<string, number | null>;
  expectedContentHash?: string | null;
  expectedContentHashByFile?: Record<string, string | null>;
  runtime?: HermesRuntimeConfig;
}) {
  const agentResult = await getIrisCoreAgentForProfile(payload.profile || "default", payload.runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return { ok: false, profile: payload.profile || "default", memory: emptyMemory(payload.profile || "default"), error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  }
  const result = await resetIrisCoreAgentMemory(
    agentResult.agent.id,
    payload.file,
    {
      confirm: payload.confirm,
      expectedUpdatedAt: payload.expectedUpdatedAt,
      expectedUpdatedAtByFile: payload.expectedUpdatedAtByFile,
      expectedContentHash: payload.expectedContentHash,
      expectedContentHashByFile: payload.expectedContentHashByFile,
    },
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

export async function getIrisSkillCatalog(profile?: string, runtime?: HermesRuntimeConfig): Promise<HermesSkillCatalog> {
  const targetProfile = profile || "default";
  const agentResult = await getIrisCoreAgentForProfile(targetProfile, runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return emptySkillCatalog(targetProfile, agentResultError(agentResult, "Could not resolve Iris agent."));
  }
  const result = await getIrisCoreAgentSkillCatalog(agentResult.agent.id, runtime);
  return result.ok
    ? result
    : emptySkillCatalog(agentResult.agent.runtimeProfile, result.error || "Could not load skill catalog from Iris Core.");
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

export async function installIrisSkill(payload: {
  profile?: string;
  sourceProfile?: string;
  sourceAgentId?: string;
  sourceSkillId: string;
  overwrite?: boolean;
  runtime?: HermesRuntimeConfig;
}): Promise<HermesSkillSaveResult> {
  const targetProfile = payload.profile || "default";
  const agentResult = await getIrisCoreAgentForProfile(targetProfile, payload.runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return {
      ok: false,
      profile: targetProfile,
      skill: emptySkillDetail(targetProfile),
      error: agentResultError(agentResult, "Could not resolve Iris agent."),
    };
  }
  const result = await installIrisCoreAgentSkill(
    agentResult.agent.id,
    {
      sourceAgentId: payload.sourceAgentId,
      sourceProfile: payload.sourceProfile,
      sourceSkillId: payload.sourceSkillId,
      overwrite: payload.overwrite,
    },
    payload.runtime,
  );
  return result.ok
    ? result
    : { ...result, profile: agentResult.agent.runtimeProfile, skill: emptySkillDetail(agentResult.agent.runtimeProfile) };
}

export async function deleteIrisSkill(
  profile: string | undefined,
  skillId: string,
  runtime?: HermesRuntimeConfig,
): Promise<HermesSkillDeleteResult> {
  const targetProfile = profile || "default";
  const agentResult = await getIrisCoreAgentForProfile(targetProfile, runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return {
      ok: false,
      profile: targetProfile,
      deletedSkillId: skillId,
      deletedPath: "",
      error: agentResultError(agentResult, "Could not resolve Iris agent."),
    };
  }
  const result = await deleteIrisCoreAgentSkill(agentResult.agent.id, skillId, runtime);
  return result.ok
    ? result
    : {
        ...result,
        profile: agentResult.agent.runtimeProfile,
        deletedSkillId: skillId,
        deletedPath: "",
      };
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

export async function getIrisProfileIdentity(profile = "default", runtime?: HermesRuntimeConfig): Promise<HermesProfileIdentity> {
  const agentResult = await getIrisCoreAgentForProfile(profile || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return emptyProfileIdentity(profile || "default", agentResultError(agentResult, "Could not resolve Iris agent."));
  }
  const result = await getIrisCoreProfileIdentity(agentResult.agent.id, runtime);
  return result.ok ? result : emptyProfileIdentity(agentResult.agent.runtimeProfile, result.error || "Could not load profile configuration.");
}

export async function saveIrisProfileSoul(payload: {
  profile?: string;
  content: string;
  expectedContentHash?: string | null;
  runtime?: HermesRuntimeConfig;
}) {
  const agentResult = await getIrisCoreAgentForProfile(payload.profile || "default", payload.runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  return saveIrisCoreProfileSoul(
    agentResult.agent.id,
    { content: payload.content, expectedContentHash: payload.expectedContentHash },
    payload.runtime,
  );
}

export async function resetIrisProfileSoul(payload: {
  profile?: string;
  expectedContentHash?: string | null;
  runtime?: HermesRuntimeConfig;
}) {
  const agentResult = await getIrisCoreAgentForProfile(payload.profile || "default", payload.runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  return resetIrisCoreProfileSoul(
    agentResult.agent.id,
    { expectedContentHash: payload.expectedContentHash },
    payload.runtime,
  );
}

export async function saveIrisProfileConfig(payload: {
  profile?: string;
  content: string;
  expectedContentHash?: string | null;
  runtime?: HermesRuntimeConfig;
}) {
  const agentResult = await getIrisCoreAgentForProfile(payload.profile || "default", payload.runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  return saveIrisCoreProfileConfig(
    agentResult.agent.id,
    { content: payload.content, expectedContentHash: payload.expectedContentHash },
    payload.runtime,
  );
}

export async function updateIrisProfileEnv(payload: {
  profile?: string;
  values: Record<string, string>;
  removeKeys?: string[];
  runtime?: HermesRuntimeConfig;
}) {
  const agentResult = await getIrisCoreAgentForProfile(payload.profile || "default", payload.runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  return updateIrisCoreProfileEnv(
    agentResult.agent.id,
    { values: payload.values, removeKeys: payload.removeKeys },
    payload.runtime,
  );
}

export async function checkIrisProfileConfig(profile = "default", runtime?: HermesRuntimeConfig) {
  const agentResult = await getIrisCoreAgentForProfile(profile || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  return checkIrisCoreProfileConfig(agentResult.agent.id, runtime);
}

export async function getIrisProfileAlias(profile = "default", runtime?: HermesRuntimeConfig): Promise<HermesProfileAlias> {
  const agentResult = await getIrisCoreAgentForProfile(profile || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) {
    return { ok: false, profile, alias: profile, path: "", exists: false, inPath: false, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  }
  const result = await getIrisCoreProfileAlias(agentResult.agent.id, runtime);
  return result.ok ? result : { ok: false, profile, alias: profile, path: "", exists: false, inPath: false, error: result.error || "Could not load alias." };
}

export async function createIrisProfileAlias(profile: string, alias: string, runtime?: HermesRuntimeConfig) {
  const agentResult = await getIrisCoreAgentForProfile(profile || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  return createIrisCoreProfileAlias(agentResult.agent.id, alias, runtime);
}

export async function deleteIrisProfileAlias(profile: string, alias: string, runtime?: HermesRuntimeConfig) {
  const agentResult = await getIrisCoreAgentForProfile(profile || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  return deleteIrisCoreProfileAlias(agentResult.agent.id, alias, runtime);
}

export async function installIrisProfileDistribution(payload: {
  source: string;
  name?: string;
  alias?: boolean;
  force?: boolean;
  runtime?: HermesRuntimeConfig;
}) {
  const result = await installIrisCoreProfileDistribution(
    { source: payload.source, name: payload.name, alias: payload.alias, force: payload.force },
    payload.runtime,
  );
  return profileActionResult(result);
}

export async function importIrisProfileArchive(payload: {
  file: File;
  name?: string;
  runtime?: HermesRuntimeConfig;
}) {
  const result = await importIrisCoreProfileArchive({ file: payload.file, name: payload.name }, payload.runtime);
  return profileActionResult(result);
}

export async function updateIrisProfileDistribution(profile: string, forceConfig: boolean, runtime?: HermesRuntimeConfig) {
  const agentResult = await getIrisCoreAgentForProfile(profile || "default", runtime);
  if (!agentResult.ok || !agentResult.agent) return { ok: false, error: agentResultError(agentResult, "Could not resolve Iris agent.") };
  return updateIrisCoreProfileDistribution(agentResult.agent.id, { forceConfig }, runtime);
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
    contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
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

function emptySkillCatalog(profile: string, error: string): HermesSkillCatalog {
  return {
    ok: false,
    profile,
    installed: [],
    available: [],
    generatedAt: Math.floor(Date.now() / 1000),
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

function emptyProfileIdentity(profile: string, error = ""): HermesProfileIdentity {
  const emptyFile = {
    name: "SOUL.md",
    path: "",
    exists: false,
    updatedAt: null,
    bytes: 0,
    content: "",
    contentHash: "",
  };
  return {
    ok: false,
    profile,
    path: "",
    soul: emptyFile,
    config: {
      path: "",
      raw: "",
      provider: "not configured",
      model: "not configured",
      contentHash: "",
    },
    env: {
      path: "",
      exists: false,
      updatedAt: null,
      bytes: 0,
      keys: [],
    },
    distribution: null,
    error,
  };
}

function profileActionResult(result: {
  ok: boolean;
  agent?: { runtimeProfile: string };
  profile?: string;
  warnings?: string[];
  restartRequired?: boolean;
  adapterInstallRequired?: boolean;
  error?: string;
}) {
  return result.ok && result.agent
    ? {
        ok: true,
        profile: result.profile || result.agent.runtimeProfile,
        warnings: result.warnings || [],
        restartRequired: Boolean(result.restartRequired),
        adapterInstallRequired: Boolean(result.adapterInstallRequired),
      }
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
