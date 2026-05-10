import type { MessageAttachment } from "../../app/types";
import { uploadAgentUICoreAttachment } from "../../lib/agentuiCore";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { formatAttachmentSize } from "../../shared/files";
import type { AttachmentUploadFailure, SendableAttachment } from "./chatTypes";

type UploadAttachmentsForSendOptions = {
  profile: string;
  messageId: string;
  sessionId: string;
  runtimeConfig: HermesRuntimeConfig;
};

export async function uploadAttachmentsForSend(
  attachments: SendableAttachment[],
  options: UploadAttachmentsForSendOptions,
) {
  const uploaded: MessageAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.upload) {
      uploaded.push(mergeUploadedAttachment(attachment, attachment.upload));
      continue;
    }
    if (attachment.id.startsWith("att_") && !attachment.file && !attachment.localPath) {
      uploaded.push(attachment);
      continue;
    }
    const result = await uploadAgentUICoreAttachment(
      {
        file: attachment.file,
        localPath: attachment.localPath,
        name: attachment.name,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        profile: options.profile,
        sessionId: options.sessionId,
        messageId: options.messageId,
        metadata: {
          clientDraftId: attachment.id,
          lastModified: attachment.lastModified || 0,
        },
      },
      options.runtimeConfig,
    );
    if (!result.ok || !result.attachment) {
      throw new AttachmentUploadError({
        id: attachment.id,
        name: attachment.name,
        message: uploadErrorMessage(attachment.name, result.error),
      });
    }
    uploaded.push(mergeUploadedAttachment(attachment, result.attachment));
  }
  return uploaded;
}

export class AttachmentUploadError extends Error {
  attachment: AttachmentUploadFailure;

  constructor(attachment: AttachmentUploadFailure) {
    super(attachment.message);
    this.name = "AttachmentUploadError";
    this.attachment = attachment;
  }
}

export function mergeUploadedAttachment(draft: SendableAttachment, uploaded: MessageAttachment): MessageAttachment {
  return {
    id: uploaded.id,
    name: uploaded.name || draft.name,
    kind: uploaded.kind || draft.kind,
    mimeType: uploaded.mimeType || draft.mimeType,
    size: uploaded.size >= 0 ? uploaded.size : draft.size,
    lastModified: draft.lastModified,
    previewUrl: uploaded.previewUrl || draft.previewUrl,
    downloadUrl: uploaded.downloadUrl,
    localPath: draft.localPath,
  };
}

export function formatPromptWithAttachments(prompt: string, attachments: MessageAttachment[]) {
  if (!attachments.length) return prompt;
  const attachmentSummary = attachments
    .map((attachment, index) => {
      const type = attachment.mimeType || (attachment.kind === "image" ? "image" : "file");
      const size = attachment.size >= 0 ? formatAttachmentSize(attachment.size) : "size unknown";
      return `${index + 1}. ${attachment.name} (${type}, ${size})`;
    })
    .join("\n");

  if (!prompt.trim()) return attachmentSummary;
  return [prompt, `Attached files:\n${attachmentSummary}`].join("\n\n");
}

function uploadErrorMessage(name: string, error = "") {
  const detail = error.trim() || "Upload failed.";
  return detail.includes(name) ? detail : `${name}: ${detail}`;
}
