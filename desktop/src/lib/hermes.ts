import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  HermesMemory,
  HermesMemorySaveResult,
  HermesMessageResult,
  HermesConversationDetail,
  HermesConversationsResult,
  HermesRuntimeConfig,
  HermesSkillDetail,
  HermesSkillSaveResult,
  HermesSkills,
  HermesStatus,
  HermesStreamEvent,
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
  return bridge<HermesConversationsResult>("conversations", { profile, limit, ...runtimePayload(runtime) });
}

export async function getHermesConversationDetail(
  profile: string | undefined,
  conversationId: string,
  runtime?: HermesRuntimeConfig,
) {
  return bridge<HermesConversationDetail>("conversation_detail", {
    profile,
    conversationId,
    ...runtimePayload(runtime),
  });
}

export async function sendHermesMessage(
  prompt: string,
  profile?: string,
  runtime?: HermesRuntimeConfig,
  conversationId?: string | null,
) {
  return bridge<HermesMessageResult>("send_message", {
    prompt,
    profile,
    conversationId,
    timeoutSeconds: 180,
    ...runtimePayload(runtime),
  });
}

export async function streamHermesMessage(
  prompt: string,
  profile: string | undefined,
  runtime: HermesRuntimeConfig | undefined,
  conversationId: string | null | undefined,
  onEvent: (event: HermesStreamEvent) => void,
) {
  const requestId = crypto.randomUUID();
  const unlisten = await listen<HermesStreamEvent>("hermes://stream", (event) => {
    if (event.payload.requestId === requestId) {
      onEvent(event.payload);
    }
  });

  await invoke("hermes_stream_message", {
    requestId,
    payload: {
      prompt,
      profile,
      conversationId,
      timeoutSeconds: 180,
      ...runtimePayload(runtime),
    },
  });

  return { requestId, unlisten };
}

export async function cancelHermesMessage(requestId: string) {
  return invoke<BridgeResponse<{ requestId: string }>>("hermes_cancel_message", { requestId });
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
