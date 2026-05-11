import type { HermesParsedEvents, HermesStreamToolEvent } from "../types/hermes";

export type View = "chat" | "agents" | "jobs";

export type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  attachments?: MessageAttachment[];
  source?: string;
  streaming?: boolean;
  streamMessageId?: string;
  clientRequestId?: string;
  events?: HermesParsedEvents;
  streamEvents?: HermesStreamToolEvent[];
};

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

export type AttachmentKind = "image" | "document" | "audio" | "video" | "archive" | "code" | "file";

export type ProfileAction = "create" | "clone" | "rename" | "switch" | "delete";

export type ProfileActionHandler = (
  action: ProfileAction,
  name: string,
  sourceProfile?: string,
) => Promise<string>;

export type AppNotification = {
  id: string;
  tone: "info" | "success" | "error";
  title: string;
  message: string;
};

export type CommandItem = {
  id: string;
  label: string;
  detail: string;
  shortcut?: string;
  run: () => void;
};
