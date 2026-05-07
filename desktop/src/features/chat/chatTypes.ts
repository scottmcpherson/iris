import type { MessageAttachment } from "../../app/types";
import type { HermesModelSelection } from "../../types/hermes";

export type PendingProfileConversationSelection = {
  profile: string;
  conversationId: string;
};

export type SendMessageOptions = {
  attachments?: SendableAttachment[];
  modelSelection?: HermesModelSelection | null;
  currentModelSelection?: HermesModelSelection | null;
};

export type SendableAttachment = MessageAttachment & {
  file?: File;
  upload?: MessageAttachment;
  uploadStatus?: "local" | "uploading" | "uploaded" | "error";
  uploadError?: string;
};
