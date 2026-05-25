export type IrisCoreConnectionMode = "managed-local" | "tailscale";

export type IrisCoreConnectionProfile = {
  id: string;
  name: string;
  mode: IrisCoreConnectionMode;
  effectiveCoreApiUrl: string;
  local?: {
    port: number;
    hermesHome?: string;
    autoStart: boolean;
    installLaunchAgent: boolean;
  };
  tailscale?: {
    hostId: string;
    hostLabel: string;
    /** MagicDNS name (preferred, stable across IP changes), e.g. "mac-mini.tailnet.ts.net". */
    magicDnsName?: string;
    /** Tailscale 100.x address, used as a fallback when MagicDNS is unavailable. */
    tailscaleIp?: string;
    corePort: number;
    /** Per-device bearer token issued by the host's Core during pairing. */
    deviceToken?: string;
  };
};

export type HermesRuntimeConfig = {
  connectionMode: IrisCoreConnectionMode;
  activeConnectionId: string;
  coreConnections: IrisCoreConnectionProfile[];
  provider: string;
  model: string;
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
  managed?: boolean;
  error?: string | null;
  warnings?: string[];
};

export type HermesProfileFile = {
  ok?: boolean;
  profile?: string;
  name: string;
  path: string;
  exists: boolean;
  updatedAt: number | null;
  bytes: number;
  content: string;
  contentHash: string;
};

export type HermesProfileConfig = {
  ok?: boolean;
  profile?: string;
  path: string;
  exists?: boolean;
  updatedAt?: number | null;
  bytes?: number;
  contentHash?: string;
  raw: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  parseError?: string;
};

export type HermesProfileEnv = {
  ok?: boolean;
  profile?: string;
  path: string;
  exists: boolean;
  updatedAt: number | null;
  bytes: number;
  keys: string[];
  requiredKeys?: string[];
};

export type HermesProfileDistribution = {
  name?: string;
  version?: string;
  description?: string;
  hermesRequires?: string;
  author?: string;
  license?: string;
  source?: string;
  installedAt?: string;
  envRequires?: Array<{
    name?: string;
    description?: string;
    required?: boolean;
    default?: string;
  }>;
  distributionOwned?: string[];
  parseError?: string;
};

export type HermesProfileIdentity = {
  ok: boolean;
  profile: string;
  path: string;
  soul: HermesProfileFile;
  config: HermesProfileConfig;
  env: HermesProfileEnv;
  distribution?: HermesProfileDistribution | null;
  error?: string;
};

export type HermesProfileAlias = {
  ok: boolean;
  profile: string;
  alias: string;
  path: string;
  exists: boolean;
  inPath: boolean;
  collision?: string;
  error?: string;
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
  connectionMode?: IrisCoreConnectionMode;
  activeConnectionId?: string;
  activeConnectionName?: string;
  transport?: "sidecar" | "tailscale";
  hermesOwner?: "this-mac" | "remote-host";
  coreApiUrl?: string;
  activeApiUrl?: string;
  coreVersionStatus?: {
    ok: boolean;
    coreVersion: string;
    clientVersion: string;
    reason?: "version-mismatch" | "unknown";
  };
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
  profile?: string;
  requestedProfile?: string;
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
  contentHash?: string;
};

export type HermesMemoryHistoryEntry = {
  id: string;
  file: string;
  action: "save" | "reset";
  updatedAt: number;
  bytes: number;
  summary: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type HermesMemoryResetExpectations = {
  expectedUpdatedAt?: number | null;
  expectedUpdatedAtByFile?: Record<string, number | null>;
  expectedContentHash?: string | null;
  expectedContentHashByFile?: Record<string, string | null>;
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
  contentHash?: string | null;
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

export type HermesSkillCatalogItem = HermesSkill & {
  catalogId: string;
  installed: boolean;
  sourceProfile: string;
  sourceAgentId?: string;
  sourceSkillId: string;
  targetProfile: string;
  conflict?: boolean;
  contentHash?: string | null;
};

export type HermesSkillCatalog = {
  ok: boolean;
  profile: string;
  installed: HermesSkill[];
  available: HermesSkillCatalogItem[];
  generatedAt: number;
  error?: string;
};

export type HermesSkillSaveResult = {
  ok: boolean;
  profile: string;
  skill: HermesSkillDetail;
  error?: string;
};

export type HermesSkillDeleteResult = {
  ok: boolean;
  profile: string;
  deletedSkillId: string;
  deletedPath: string;
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

export type HermesAutomationSchedule = {
  kind: "once" | "interval" | "cron" | "unknown";
  display: string;
  runAt?: string;
  minutes?: number;
  expr?: string;
};

export type HermesAutomation = {
  id: string;
  name: string;
  schedule: HermesAutomationSchedule;
  prompt: string;
  deliver: string;
  deliverToSessionId: string;
  projectId: string | null;
  resolvedDeliveryTarget?: {
    platform?: string;
    deliver?: string;
    chatId?: string;
    sessionId?: string;
    projectId?: string | null;
  };
  status: HermesJobStatus;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string;
  lastError: string;
  lastDeliveryError: string;
  runCount: number;
  repeat: number | null;
  skills: string[];
  skill: string | null;
  script: string | null;
  noAgent: boolean;
  contextFrom: string[];
  workdir: string | null;
  enabledToolsets: string[] | null;
  model: string | null;
  provider: string | null;
  baseUrl: string | null;
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
