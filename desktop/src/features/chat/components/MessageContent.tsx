import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FileText } from "lucide-react";
import type { ComponentProps, MouseEvent as ReactMouseEvent } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import type { Message, MessageAttachment } from "../../../app/types";
import { agentUICoreAttachmentUrl } from "../../../lib/agentuiCore";
import type { HermesRuntimeConfig } from "../../../types/hermes";
import { normalizeChatMarkdown } from "../markdown";
import { LegacyToolEvents, StreamToolEvents } from "./ToolEvents";

const markdownComponents = {
  a: MarkdownLink,
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
        return (
          <div key={attachment.id} className="message-attachment-card" title={attachment.name}>
            {previewUrl ? (
              <img src={previewUrl} alt={attachment.name} />
            ) : (
              <span className="message-attachment-file">
                <FileText size={28} />
              </span>
            )}
            <span className="message-attachment-label">{attachment.name}</span>
          </div>
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
