import type { MessageAttachment } from "../../app/types";
import type { HermesModelSelection } from "../../types/hermes";

export type PendingProfileConversationSelection = {
  profile: string;
  conversationId: string;
};

export type SendMessageOptions = {
  text?: string;
  attachments?: SendableAttachment[];
  modelSelection?: HermesModelSelection | null;
  currentModelSelection?: HermesModelSelection | null;
  projectId?: string | null;
  onAttachmentUploadError?: (error: AttachmentUploadFailure) => void;
};

export type SendableAttachment = MessageAttachment & {
  file?: File;
  upload?: MessageAttachment;
  uploadStatus?: "local" | "uploading" | "uploaded" | "error";
  uploadError?: string;
};

export type AttachmentUploadFailure = {
  id: string;
  name: string;
  message: string;
};
