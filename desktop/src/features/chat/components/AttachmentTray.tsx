import { Paperclip, X } from "lucide-react";
import type { MessageAttachment } from "../../../app/types";
import { formatAttachmentSize } from "../../../shared/files";

type AttachmentTrayProps = {
  attachments: Array<MessageAttachment & { previewUrl?: string }>;
  onRemove: (id: string) => void;
};

export function AttachmentTray({ attachments, onRemove }: AttachmentTrayProps) {
  if (!attachments.length) return null;

  return (
    <div className="attachment-tray" aria-label="Attached files">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="attachment-pill">
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt="" />
          ) : (
            <span className="attachment-icon">
              <Paperclip size={14} />
            </span>
          )}
          <span className="attachment-name">{attachment.name}</span>
          <span className="attachment-size">
            {attachment.size >= 0 ? formatAttachmentSize(attachment.size) : "local path"}
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
