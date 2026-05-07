import { Archive, FileCode, FileText, Image, Music, Paperclip, Video, X } from "lucide-react";
import type { MessageAttachment } from "../../../app/types";
import { attachmentTypeLabel, formatAttachmentSize } from "../../../shared/files";

type AttachmentTrayAttachment = MessageAttachment & {
  previewUrl?: string;
  uploadStatus?: "local" | "uploading" | "uploaded" | "error";
  uploadError?: string;
};

type AttachmentTrayProps = {
  attachments: AttachmentTrayAttachment[];
  onRemove: (id: string) => void;
};

export function AttachmentTray({ attachments, onRemove }: AttachmentTrayProps) {
  if (!attachments.length) return null;

  return (
    <div className="attachment-tray" aria-label="Attached files">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={["attachment-pill", attachment.uploadStatus === "error" ? "error" : ""]
            .filter(Boolean)
            .join(" ")}
          title={attachment.uploadError || `${attachmentTypeLabel(attachment.kind, attachment.mimeType)}: ${attachment.name}`}
        >
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt="" />
          ) : (
            <span className="attachment-icon">
              <AttachmentKindIcon attachment={attachment} />
            </span>
          )}
          <span className="attachment-name">{attachment.name}</span>
          <span className="attachment-size">
            {attachment.uploadStatus === "error"
              ? "error"
              : attachment.size >= 0
                ? formatAttachmentSize(attachment.size)
                : attachmentTypeLabel(attachment.kind, attachment.mimeType)}
          </span>
          <button
            type="button"
            className="attachment-remove"
            onClick={() => onRemove(attachment.id)}
            title={`Remove ${attachment.name}`}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function AttachmentKindIcon({ attachment }: { attachment: MessageAttachment }) {
  const size = 14;
  if (attachment.kind === "image") return <Image size={size} />;
  if (attachment.kind === "audio") return <Music size={size} />;
  if (attachment.kind === "video") return <Video size={size} />;
  if (attachment.kind === "archive") return <Archive size={size} />;
  if (attachment.kind === "code") return <FileCode size={size} />;
  if (attachment.kind === "document") return <FileText size={size} />;
  return <Paperclip size={size} />;
}
