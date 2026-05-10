export type HermesConnectionMode = "local" | "remote";

export type HermesRuntimeConfig = {
  connectionMode: HermesConnectionMode;
  provider: string;
  model: string;
  remoteUrl: string;
  coreApiUrl: string;
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

export type HermesModelProvider = {
  slug: string;
  name: string;
  isCurrent: boolean;
  isUserDefined: boolean;
  models: string[];
  totalModels: number;
  source: string;
};

export type HermesModelSelection = {
  provider: string;
  model: string;
  providerName?: string;
};

export type HermesModelCatalog = {
  ok: boolean;
  profile: string;
  current: HermesModelSelection | null;
  providers: HermesModelProvider[];
  generatedAt: number;
  url?: string;
  status?: number;
  error?: string;
};

export type HermesSlashCommandSource =
  | "hermes"
  | "skill"
  | "quick-command"
  | "plugin";

export type HermesSlashCommand = {
  id: string;
  name: string;
  text: string;
  label: string;
  description: string;
  category: string;
  source: HermesSlashCommandSource;
  aliases: string[];
  argsHint: string;
  subcommands: string[];
  requiresArgument: boolean;
};

export type HermesSlashCommandsResult = {
  ok: boolean;
  profile: string;
  commands: HermesSlashCommand[];
  generatedAt: number;
  url?: string;
  status?: number;
  warning?: string;
  error?: string;
};

export type HermesSlashCompletionItem = {
  text: string;
  display: string;
  meta?: string;
};

export type HermesSlashCompletionResult = {
  ok: boolean;
  items: HermesSlashCompletionItem[];
  replaceFrom: number;
  url?: string;
  status?: number;
  error?: string;
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
  coreApiUrl?: string;
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

export type HermesSessionSource = "hermes-api" | "hermes-management";

export type HermesSession = {
  id: string;
  source: string;
  model: string;
  title: string;
  preview: string;
  chatId?: string;
  origin?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  readState?: HermesSessionReadState;
  startedAt: number | null;
  endedAt: number | null;
  lastActiveAt: number | null;
  messageCount: number;
};

export type HermesSessionReadState = {
  sessionId: string;
  state: "read" | "unread";
  createdAt: number | null;
  updatedAt: number | null;
  metadata?: Record<string, unknown>;
};

export type HermesSessionMessage = {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  status?: "pending" | "streaming" | "completed" | "error";
  toolName: string;
  toolCallId?: string;
  toolCalls?: HermesHistoryToolCall[];
  timestamp: number | null;
  metadata?: Record<string, unknown>;
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

export type HermesSessionsResult = {
  ok: boolean;
  profile: string;
  path: string;
  source: HermesSessionSource;
  schemaVersion?: number | null;
  sessions: HermesSession[];
  warning?: string;
  error?: string;
};

export type HermesSessionDetail = {
  ok: boolean;
  profile: string;
  path: string;
  source: HermesSessionSource;
  schemaVersion?: number | null;
  session: HermesSession | null;
  messages: HermesSessionMessage[];
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
  ok?: boolean;
  content: string;
  history: HermesSkillHistoryEntry[];
  error?: string;
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

export type HermesJobStatus = "active" | "paused" | "completed" | "error" | "unknown";

export type HermesJob = {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  deliver: string;
  status: HermesJobStatus;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string;
  lastError: string;
  lastDeliveryError: string;
  runCount: number;
  repeat: number | null;
  createdAt: number | null;
  raw: Record<string, unknown>;
};

export type HermesInboxMessage = {
  cursor: number;
  id: string;
  source: string;
  platform: string;
  profile: string;
  chatId: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  acknowledgedAt: number | null;
};

export type HermesInboxMessagesResult = {
  ok: boolean;
  messages: HermesInboxMessage[];
  cursor: number;
  error?: string;
};

export type RemoteCredentialKind = "core";

export type RemoteCredentialStatus = {
  ok: boolean;
  kind: RemoteCredentialKind;
  exists: boolean;
  source: "environment" | "macos-keychain" | "test-file" | "unavailable";
  error?: string;
};
