import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Archive, FileCode, FileText, Image, Music, Paperclip, Video } from "lucide-react";
import type { ComponentProps, MouseEvent as ReactMouseEvent } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import type { Message, MessageAttachment } from "../../../app/types";
import { agentUICoreAttachmentUrl } from "../../../lib/agentuiCore";
import { attachmentTypeLabel } from "../../../shared/files";
import type { HermesRuntimeConfig } from "../../../types/hermes";
import { normalizeChatMarkdown } from "../markdown";
import { LegacyToolEvents, StreamToolEvents } from "./ToolEvents";

const markdownComponents = {
  a: MarkdownLink,
  table: MarkdownTable,
} as StreamdownProps["components"];

export function MessageContent({ message }: { message: Message }) {
  if (message.role === "tool") return <LegacyToolEvents content={message.content} />;
  const content = message.content.trim();
  const thinking = message.streaming && content === "Thinking...";
  const hasToolEvents = Boolean(message.streamEvents?.length);
  if (thinking && !hasToolEvents) {
    return <span className="thinking-shimmer">Thinking...</span>;
  }
  return (
    <>
      {hasToolEvents ? <StreamToolEvents events={message.streamEvents || []} /> : null}
      {content && !thinking ? <MarkdownMessage content={message.content} streaming={message.streaming} /> : null}
      {message.streaming ? <span className="typing-caret" /> : null}
    </>
  );
}

export function MessageAttachments({
  attachments,
  runtimeConfig,
}: {
  attachments: MessageAttachment[];
  runtimeConfig: HermesRuntimeConfig;
}) {
  return (
    <div className="message-attachments" aria-label="Attached files">
      {attachments.map((attachment) => {
        const previewUrl = attachmentPreviewUrl(attachment, runtimeConfig);
        const contentUrl = attachmentContentUrl(attachment, runtimeConfig);
        const title = contentUrl ? `Open ${attachment.name}` : attachment.name;
        return (
          <button
            key={attachment.id}
            type="button"
            className="message-attachment-card"
            title={title}
            disabled={!contentUrl}
            onClick={() => {
              if (contentUrl) openAttachment(contentUrl);
            }}
          >
            {previewUrl ? (
              <img src={previewUrl} alt={attachment.name} />
            ) : (
              <span className="message-attachment-file">
                <AttachmentKindIcon attachment={attachment} />
              </span>
            )}
            <span className="message-attachment-label">{attachment.name}</span>
            <span className="message-attachment-kind">{attachmentTypeLabel(attachment.kind, attachment.mimeType)}</span>
          </button>
        );
      })}
    </div>
  );
}

function attachmentPreviewUrl(attachment: MessageAttachment, runtimeConfig: HermesRuntimeConfig) {
  if (attachment.previewUrl) return agentUICoreAttachmentUrl(runtimeConfig, attachment.previewUrl);
  if (attachment.kind === "image" && attachment.id.startsWith("att_")) {
    return agentUICoreAttachmentUrl(runtimeConfig, `/v1/attachments/${encodeURIComponent(attachment.id)}/preview`);
  }
  if (attachment.kind === "image" && attachment.localPath) return convertFileSrc(attachment.localPath);
  return "";
}

function attachmentContentUrl(attachment: MessageAttachment, runtimeConfig: HermesRuntimeConfig) {
  if (attachment.downloadUrl) return agentUICoreAttachmentUrl(runtimeConfig, attachment.downloadUrl);
  if (attachment.id.startsWith("att_")) {
    return agentUICoreAttachmentUrl(runtimeConfig, `/v1/attachments/${encodeURIComponent(attachment.id)}/content`);
  }
  if (attachment.kind === "image" && attachment.localPath) return convertFileSrc(attachment.localPath);
  return "";
}

function openAttachment(url: string) {
  void openUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

function AttachmentKindIcon({ attachment }: { attachment: MessageAttachment }) {
  const size = 28;
  if (attachment.kind === "image") return <Image size={size} />;
  if (attachment.kind === "audio") return <Music size={size} />;
  if (attachment.kind === "video") return <Video size={size} />;
  if (attachment.kind === "archive") return <Archive size={size} />;
  if (attachment.kind === "code") return <FileCode size={size} />;
  if (attachment.kind === "document") return <FileText size={size} />;
  return <Paperclip size={size} />;
}

function MarkdownMessage({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <Streamdown
      className="message-markdown"
      components={markdownComponents}
      controls={false}
      isAnimating={Boolean(streaming)}
      linkSafety={{ enabled: false }}
      parseIncompleteMarkdown
    >
      {normalizeChatMarkdown(content)}
    </Streamdown>
  );
}

function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  return (
    <div className="message-markdown-table" role="region" aria-label="Markdown table" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  );
}

function MarkdownLink({
  children,
  href,
  onClick,
  rel,
  target,
  ...props
}: ComponentProps<"a">) {
  function handleClick(event: ReactMouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }

    const externalHref = href ? externalUrlFromHref(href) : null;
    if (!externalHref) return;

    event.preventDefault();
    void openUrl(externalHref).catch(() => {
      window.open(externalHref, "_blank", "noopener,noreferrer");
    });
  }

  return (
    <a
      href={href}
      onClick={handleClick}
      rel={rel || "noopener noreferrer"}
      target={target || "_blank"}
      {...props}
    >
      {children}
    </a>
  );
}

function externalUrlFromHref(href: string) {
  try {
    const url = new URL(href, window.location.href);
    if (["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return url.toString();
  } catch {
    return null;
  }
  return null;
}
