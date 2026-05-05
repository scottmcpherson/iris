export type HermesConnectionMode = "local" | "remote";

export type HermesRuntimeConfig = {
  connectionMode: HermesConnectionMode;
  customHermesPath: string;
  provider: string;
  model: string;
  remoteUrl: string;
  gatewayUrl: string;
  managementApiUrl: string;
  profileApiUrls: Record<string, string>;
  profileSidecarUrls: Record<string, string>;
};

export type HermesPathCandidate = {
  path: string;
  source: string;
  exists: boolean;
};

export type HermesProfile = {
  name: string;
  path: string;
  active: boolean;
  exists: boolean;
  model: string;
  provider: string;
  memoryBytes: number;
  memoryUpdatedAt: number | null;
  skillCount: number;
  sessionCount: number;
  estimatedCostUsd: number | null;
  gatewayRunning: boolean;
};

export type HermesStatus = {
  ok: boolean;
  connected: boolean;
  root: string;
  hermesPath: string | null;
  hermesPathSource?: string | null;
  hermesPathCandidates?: HermesPathCandidate[];
  version: string | null;
  activeProfile: HermesProfile;
  profiles: HermesProfile[];
  checkedAt: number;
  connectionMode?: HermesConnectionMode;
  remoteUrl?: string;
  gatewayUrl?: string;
  managementApiUrl?: string;
  activeApiUrl?: string;
  gatewayStatus?: HermesEndpointStatus;
  remoteStatus?: HermesEndpointStatus;
  activeApiStatus?: HermesEndpointStatus;
  managementStatus?: HermesEndpointStatus;
  error?: string | null;
};

export type HermesEndpointStatus = {
  ok: boolean;
  url?: string;
  status?: number;
  body?: string;
  error?: string;
};

export type HermesMemoryFile = {
  name: string;
  path: string;
  exists: boolean;
  updatedAt: number | null;
  bytes: number;
  content: string;
};

export type HermesMemoryHistoryEntry = {
  id: string;
  file: string;
  action: "save" | "reset";
  updatedAt: number;
  bytes: number;
  summary: string;
  content: string;
};

export type HermesMemory = {
  ok: boolean;
  profile: string;
  path: string;
  memory: HermesMemoryFile;
  user: HermesMemoryFile;
  history: HermesMemoryHistoryEntry[];
  error?: string;
};

export type HermesConversationSource = "hermes-api" | "hermes-management";

export type HermesConversation = {
  id: string;
  source: string;
  model: string;
  title: string;
  preview: string;
  startedAt: number | null;
  endedAt: number | null;
  lastActiveAt: number | null;
  messageCount: number;
};

export type HermesConversationMessage = {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolName: string;
  toolCallId?: string;
  toolCalls?: HermesHistoryToolCall[];
  timestamp: number | null;
};

export type HermesHistoryToolCall = {
  id?: string;
  call_id?: string;
  type?: string;
  name?: string;
  arguments?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type HermesConversationsResult = {
  ok: boolean;
  profile: string;
  path: string;
  source: HermesConversationSource;
  schemaVersion?: number | null;
  conversations: HermesConversation[];
  warning?: string;
  error?: string;
};

export type HermesConversationDetail = {
  ok: boolean;
  profile: string;
  path: string;
  source: HermesConversationSource;
  schemaVersion?: number | null;
  conversation: HermesConversation | null;
  messages: HermesConversationMessage[];
  warning?: string;
  error?: string;
};

export type HermesMemorySaveResult = {
  ok: boolean;
  profile: string;
  memory: HermesMemory;
  error?: string;
};

export type HermesSkill = {
  id?: string;
  name: string;
  path: string;
  category: string;
  description: string;
  updatedAt: number | null;
  source: "installed" | "bundled" | "community";
  version: string | null;
  tags: string[];
  bytes: number;
  metadata: Record<string, string>;
};

export type HermesSkillHistoryEntry = {
  version: string;
  updatedAt: number;
  summary: string;
  bytes: number;
};

export type HermesSkillDetail = HermesSkill & {
  content: string;
  history: HermesSkillHistoryEntry[];
};

export type HermesSkills = {
  ok: boolean;
  profile: string;
  path: string;
  skills: HermesSkill[];
  error?: string;
};

export type HermesSkillSaveResult = {
  ok: boolean;
  profile: string;
  skill: HermesSkillDetail;
  error?: string;
};

export type HermesParsedEvents = {
  toolCalls: Array<{ summary: string }>;
  artifacts: Array<{ summary: string }>;
  memoryWrites: Array<{ summary: string }>;
  skillEvents: Array<{ summary: string }>;
};

export type HermesStreamToolEvent = {
  id?: string;
  callId?: string;
  toolName: string;
  label: string;
  status: "running" | "completed" | "error";
  arguments?: string;
  output?: string;
};

export type HermesMessageResult = {
  ok: boolean;
  response: string;
  profile: string;
  sessionId?: string;
  events?: HermesParsedEvents;
  error?: string;
};

export type HermesStreamEvent = {
  ok: boolean;
  requestId: string;
  type: "delta" | "tool" | "done" | "error";
  delta?: string;
  toolName?: string;
  label?: string;
  status?: HermesStreamToolEvent["status"];
  callId?: string;
  arguments?: string;
  output?: string;
  response?: string;
  sessionId?: string;
  events?: HermesParsedEvents;
  error?: string;
};

export type RemoteCredentialKind = "hermes" | "sidecar";

export type RemoteCredentialStatus = {
  ok: boolean;
  kind: RemoteCredentialKind;
  exists: boolean;
  source: "environment" | "macos-keychain" | "test-file" | "unavailable";
  error?: string;
};
