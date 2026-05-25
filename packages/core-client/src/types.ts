type CorePrimitive = string | number | boolean | null;
export type CoreJsonValue = CorePrimitive | CoreJsonValue[] | { [key: string]: CoreJsonValue };
export type CoreMetadata = { [key: string]: CoreJsonValue };

export type CoreResponse<T> = T & {
  ok: boolean;
  error?: string;
};

export type CoreMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CoreRequestOptions = {
  timeoutMs?: number;
  idempotencyKey?: string;
};

export type IrisCoreTransport = {
  baseUrl: string;
  fetch: typeof fetch;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
};

export type IrisCoreClient = {
  transport: IrisCoreTransport;
};

export type IrisCoreEventStream = {
  close(): void;
};

export type IrisCoreEventStreamFactory = (
  url: string,
  handlers: {
    onMessage: (event: IrisCoreEvent) => void;
    onError: (error: unknown) => void;
  },
) => IrisCoreEventStream;

export type IrisCoreModelSelection = {
  provider: string;
  model: string;
  providerName?: string;
};

export type IrisCoreModelProvider = {
  slug: string;
  name: string;
  isCurrent: boolean;
  isUserDefined: boolean;
  models: string[];
  totalModels: number;
  source: string;
};

export type IrisCoreModelCatalog = {
  profile: string;
  current: IrisCoreModelSelection | null;
  providers: IrisCoreModelProvider[];
  generatedAt: number;
  url?: string;
  status?: number;
  error?: string;
};

export type IrisCoreSlashCommandSource =
  | "hermes"
  | "skill"
  | "quick-command"
  | "plugin";

export type IrisCoreSlashCommand = {
  id: string;
  name: string;
  text: string;
  label: string;
  description: string;
  category: string;
  source: IrisCoreSlashCommandSource;
  aliases: string[];
  argsHint: string;
  subcommands: string[];
  requiresArgument: boolean;
};

export type IrisCoreSlashCommandsResult = {
  profile: string;
  commands: IrisCoreSlashCommand[];
  generatedAt: number;
  url?: string;
  status?: number;
  warning?: string;
  error?: string;
};

export type IrisCoreSlashCompletionItem = {
  text: string;
  display: string;
  meta?: string;
};

export type IrisCoreSlashCompletionResult = {
  items: IrisCoreSlashCompletionItem[];
  replaceFrom: number;
  url?: string;
  status?: number;
  error?: string;
};

export type IrisCoreHealthResponse = {
  ok: boolean;
  status?: string;
  service?: string;
  version?: string;
  pid?: number;
  managed?: boolean | null;
  bindHost?: string;
  port?: number;
  error?: string;
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

export type IrisCoreAgentListResponse = {
  agents: IrisCoreAgent[];
};

export type IrisCoreSessionReadState = {
  sessionId: string;
  state: "read" | "unread";
  createdAt: number | null;
  updatedAt: number | null;
  metadata?: CoreMetadata;
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

export type IrisCoreMessage = {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  status?: "pending" | "streaming" | "completed" | "error";
  toolName: string;
  toolCallId?: string;
  toolCalls?: IrisCoreHistoryToolCall[];
  timestamp: number | null;
  createdAt?: number;
  updatedAt?: number;
  metadata?: CoreMetadata;
};

export type IrisCoreHistoryToolCall = {
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

export type CoreMessageAttachmentRef = {
  id: string;
};

export type IrisCoreAttachmentKind = "image" | "document" | "audio" | "video" | "archive" | "code" | "file";

export type IrisCoreAttachment = {
  id: string;
  name: string;
  kind: IrisCoreAttachmentKind;
  mimeType: string;
  size: number;
  lastModified?: number;
  previewUrl?: string;
  downloadUrl?: string;
  localPath?: string;
};

export type IrisCoreAttachmentFile = Blob | {
  uri: string;
  name?: string;
  type?: string;
};

export type UploadAttachmentPayload = {
  file: IrisCoreAttachmentFile;
  name: string;
  mimeType?: string;
  kind?: IrisCoreAttachmentKind;
  profile: string;
  sessionId?: string;
  messageId?: string;
  runtimeId?: string;
  metadata?: CoreMetadata;
};

export type UploadAttachmentResponse = {
  attachment: IrisCoreAttachment;
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

export type IrisCoreCancelMessageResult = {
  sessionId: string;
  runtime?: CoreRuntimeResult;
};

export type IrisProjectListResponse = {
  projects: IrisProject[];
};

export type CreateProjectPayload = {
  name: string;
  defaultAgentId: string;
  systemPrompt?: string;
  metadata?: CoreMetadata;
};

export type CreateProjectResponse = {
  project: IrisProject;
};

export type GetProjectSessionsOptions = {
  projectId: string;
  limit?: number;
};

export type IrisSessionListResponse = {
  sessions: IrisCoreSession[];
};

export type CreateSessionPayload = {
  agentId: string;
  title: string;
  externalChatId?: string;
  externalSessionId?: string;
  projectId?: string | null;
  metadata?: CoreMetadata;
};

export type CreateSessionResponse = {
  session: IrisCoreSession;
};

export type GetSessionsOptions = {
  agentId?: string;
  profile?: string;
  limit?: number;
};

export type GetSessionDetailOptions = {
  sessionId: string;
  externalSessionId?: string;
  externalChatId?: string;
};

export type IrisSessionDetailResponse = {
  session: IrisCoreSession;
  messages: IrisCoreMessage[];
  warning?: string;
};

export type SendMessagePayload = {
  text: string;
  attachments?: CoreMessageAttachmentRef[];
  model?: IrisCoreModelSelection | null;
  clientMessageId?: string;
  metadata?: CoreMetadata;
};

export type IrisCoreEventsResponse = {
  events: IrisCoreEvent[];
  cursor: number;
};

export type GetEventsOptions = {
  after?: number;
  limit?: number;
  agentId?: string;
  automationOnly?: boolean;
  order?: "asc" | "desc";
};

export type LatestEventCursorResponse = IrisCoreEventsResponse;
