export type AttachmentKind = "image" | "document" | "audio" | "video" | "archive" | "code" | "file";

export type MessageAttachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  size: number;
  lastModified?: number;
  previewUrl?: string;
  downloadUrl?: string;
  localPath?: string;
  legacyLocalPath?: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  attachments?: MessageAttachment[];
  source?: string;
  streaming?: boolean;
  streamMessageId?: string;
  clientRequestId?: string;
};

export type CoreChatMessage = {
  id: string;
  sessionId?: string;
  role: ChatMessage["role"];
  content: string;
  status?: "pending" | "streaming" | "completed" | "error";
  createdAt?: number;
  timestamp?: number | null;
  metadata?: Record<string, unknown>;
};

export type DeliveryMessage = {
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

export type IrisCoreEvent = {
  cursor: number;
  id: string;
  sessionId: string;
  agentId?: string;
  runtimeId?: string;
  type: string;
  role?: string;
  content: string;
  parentEventId?: string;
  externalMessageId?: string;
  createdAt: number;
  metadata: Record<string, unknown>;
};

export type SendAcceptedResult = {
  messageId?: string;
  sessionId?: string;
  canonicalSessionId?: string;
};
