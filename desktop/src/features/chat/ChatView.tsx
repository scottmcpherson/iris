import { useEffect, useRef, useState } from "react";
import type { ComponentProps, DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowDown,
  ChevronDown,
  Check,
  Command,
  Mic,
  Paperclip,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Zap,
  X,
} from "lucide-react";
import { Streamdown, type StreamdownProps } from "streamdown";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import type { Message, MessageAttachment } from "../../app/types";
import type { HermesParsedEvents, HermesProfile, HermesStreamToolEvent } from "../../types/hermes";

type ChatViewProps = {
  messages: Message[];
  selectedConversationId: string | null;
  input: string;
  onInput: (value: string) => void;
  onSend: (attachments?: MessageAttachment[]) => void;
  connected: boolean;
  profile: string;
  profiles: HermesProfile[];
  onProfileChange: (profile: string) => void;
  requestActive: boolean;
  onCancel: () => void;
};

type AttachmentDraft = MessageAttachment & {
  previewUrl?: string;
  previewRevocable?: boolean;
};

const markdownComponents = {
  a: MarkdownLink,
} as StreamdownProps["components"];

export function ChatView({
  messages,
  selectedConversationId,
  input,
  onInput,
  onSend,
  connected,
  profile,
  profiles,
  onProfileChange,
  requestActive,
  onCancel,
}: ChatViewProps) {
  const chatPaneRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const attachmentsRef = useRef<AttachmentDraft[]>([]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const renderedMessages = messages.filter(shouldRenderMessage);
  const newChat = !selectedConversationId && renderedMessages.length === 0;
  const profileSelectionLocked = !newChat || requestActive;
  const profileSelectionDisabled = profileSelectionLocked || !connected || profiles.length < 2;
  const profileSelectorTitle = profileSelectionLocked
    ? "Profile is locked for this conversation"
    : !connected
      ? "Connect Hermes to select a profile"
      : profiles.length < 2
        ? "Only one profile is available"
        : "Change agent profile";

  useEffect(() => {
    if (!addMenuOpen) return undefined;

    function handlePointerDown(event: MouseEvent) {
      if (addMenuRef.current?.contains(event.target as Node)) return;
      setAddMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAddMenuOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    if (!profileMenuOpen) return undefined;

    function handlePointerDown(event: MouseEvent) {
      if (profileMenuRef.current?.contains(event.target as Node)) return;
      setProfileMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setProfileMenuOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    if (profileSelectionDisabled) setProfileMenuOpen(false);
  }, [profileSelectionDisabled]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return undefined;

    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDragActive(isNativeDropOverChatPane(event.payload.position));
      } else if (event.payload.type === "leave") {
        dragDepthRef.current = 0;
        setDragActive(false);
      } else if (event.payload.type === "drop") {
        const dropInChatPane = isNativeDropOverChatPane(event.payload.position);
        dragDepthRef.current = 0;
        setDragActive(false);
        if (dropInChatPane) addPaths(event.payload.paths);
      }
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (!files.length) return;

    setAttachments((current) => [
      ...current,
      ...files.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        kind: file.type.startsWith("image/") ? "image" : "file",
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        previewRevocable: file.type.startsWith("image/"),
      } satisfies AttachmentDraft)),
    ]);
  }

  function addPaths(paths: string[]) {
    if (!paths.length) return;

    setAttachments((current) => [
      ...current,
      ...paths.map((path) => {
        const name = filenameFromPath(path);
        const image = isImagePath(path);
        return {
          id: crypto.randomUUID(),
          name,
          kind: image ? "image" : "file",
          mimeType: mimeTypeFromPath(path),
          size: -1,
          lastModified: Date.now(),
          path,
          previewUrl: image ? convertFileSrc(path) : undefined,
        } satisfies AttachmentDraft;
      }),
    ]);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const attachment = current.find((item) => item.id === id);
      if (attachment) revokeAttachmentPreview(attachment);
      return current.filter((item) => item.id !== id);
    });
  }

  function openFilePicker() {
    setAddMenuOpen(false);
    fileInputRef.current?.click();
  }

  function sendWithAttachments() {
    const attachmentContext = attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment);
    onSend(attachmentContext);
    setAttachments((current) => {
      current.forEach(revokeAttachmentPreview);
      return [];
    });
  }

  function selectProfile(nextProfile: string) {
    setProfileMenuOpen(false);
    if (nextProfile === profile || profileSelectionDisabled) return;
    onProfileChange(nextProfile);
  }

  function hasFileDrag(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDrag(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    addFiles(event.dataTransfer.files);
  }

  function isNativeDropOverChatPane(position: { x: number; y: number }) {
    const chatPane = chatPaneRef.current;
    if (!chatPane) return true;
    const rect = chatPane.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    return (
      pointInRect(position.x, position.y, rect) ||
      pointInRect(position.x / scale, position.y / scale, rect)
    );
  }

  return (
    <div
      ref={chatPaneRef}
      className={["chat-pane", newChat ? "new-chat" : "", dragActive ? "drag-active" : ""]
        .filter(Boolean)
        .join(" ")}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive ? (
        <div className="chat-drop-overlay" aria-hidden="true">
          <Paperclip size={20} />
          <span>Drop photos or files to add them</span>
        </div>
      ) : null}
      {newChat ? (
        <div className="new-chat-center">
          <h1>What should we work on in {profile}?</h1>
        </div>
      ) : (
        <div className="chat-workspace">
          <StickToBottom className="message-list-frame" initial="instant" resize="smooth" role="log">
            <StickToBottom.Content className="conversation-column" scrollClassName="message-list">
              {renderedMessages.length ? (
                renderedMessages.map((message) => (
                  <article key={message.id} className={`message ${message.role}`}>
                    {message.role === "system" ? (
                      <div className="message-kicker">
                        <Sparkles size={14} />
                        <span>System</span>
                      </div>
                    ) : null}
                    <div className="message-body">
                      <MessageContent message={message} />
                      {message.streaming ? <span className="typing-caret" /> : null}
                      {eventCount(message.events) ? <MessageEvents events={message.events} /> : null}
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-state">
                  <div className="view-icon">
                    <Sparkles size={18} />
                  </div>
                  <strong>{connected ? "Ready for the first request." : "Connect Hermes to start a live chat."}</strong>
                  <span>
                    {connected
                      ? "Ask for research, code changes, memory work, or a reusable skill."
                      : "Use Settings to pick a local or remote Hermes API, then retry the connection."}
                  </span>
                </div>
              )}
            </StickToBottom.Content>
            <ScrollToBottomButton />
          </StickToBottom>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          sendWithAttachments();
        }}
      >
        <input
          ref={fileInputRef}
          className="composer-file-input"
          type="file"
          multiple
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <textarea
          value={input}
          onChange={(event) => onInput(event.target.value)}
          placeholder={
            selectedConversationId
              ? "Ask for follow-up changes"
              : "Ask Hermes to research, build, remember, or create a reusable skill..."
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendWithAttachments();
            }
          }}
        />
        {attachments.length ? (
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
                  onClick={() => removeAttachment(attachment.id)}
                  title={`Remove ${attachment.name}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="composer-toolbar">
          <div className="composer-tools">
            <div className="composer-add-menu-wrap" ref={addMenuRef}>
              <button
                type="button"
                className="composer-icon-button"
                title="Add context"
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                onClick={() => setAddMenuOpen((open) => !open)}
              >
                <Plus size={18} />
              </button>
              {addMenuOpen ? (
                <div className="composer-context-menu" role="menu">
                  <button type="button" role="menuitem" onClick={openFilePicker}>
                    <span>Add photos &amp; files</span>
                    <Paperclip size={15} />
                  </button>
                </div>
              ) : null}
            </div>
            <div className="composer-profile-menu-wrap" ref={profileMenuRef}>
              <button
                type="button"
                className="composer-access-button"
                title={profileSelectorTitle}
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
                aria-label={
                  profileSelectionLocked
                    ? `Conversation profile ${profile}`
                    : `Agent profile ${connected ? profile : "Offline"}`
                }
                disabled={profileSelectionDisabled}
                onClick={() => setProfileMenuOpen((open) => !open)}
              >
                <ShieldCheck size={15} />
                <span>{connected ? profile : "Offline"}</span>
                <ChevronDown size={14} />
              </button>
              {profileMenuOpen ? (
                <div className="composer-profile-menu" role="menu" aria-label="Choose agent profile">
                  {profiles.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      role="menuitemradio"
                      aria-checked={item.name === profile}
                      onClick={() => selectProfile(item.name)}
                    >
                      <span>{item.name}</span>
                      {item.name === profile ? <Check size={14} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className="composer-tools">
            <span className="composer-model">
              <Zap size={14} />
              Hermes
            </span>
            <button type="button" className="composer-icon-button" title="Voice input">
              <Mic size={16} />
            </button>
            {requestActive ? (
              <button type="button" className="send-button cancel" onClick={onCancel} title="Cancel request">
                <Square size={15} />
              </button>
            ) : (
              <button type="submit" className="send-button" title="Send message">
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) return null;

  return (
    <button
      className="chat-scroll-bottom-button"
      type="button"
      title="Jump to latest message"
      onClick={() => {
        void scrollToBottom();
      }}
    >
      <ArrowDown size={16} />
    </button>
  );
}

function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function revokeAttachmentPreview(attachment: AttachmentDraft) {
  if (attachment.previewUrl && attachment.previewRevocable) URL.revokeObjectURL(attachment.previewUrl);
}

function pointInRect(x: number, y: number, rect: DOMRect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function filenameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function isImagePath(path: string) {
  return /\.(avif|gif|heic|heif|jpe?g|png|webp)$/i.test(path);
}

function mimeTypeFromPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  if (!extension) return "";
  const imageTypes: Record<string, string> = {
    avif: "image/avif",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  return imageTypes[extension] || "";
}

function shouldRenderMessage(message: Message) {
  return Boolean(message.content.trim() || message.streaming || message.streamEvents?.length || eventCount(message.events));
}

function MessageContent({ message }: { message: Message }) {
  if (message.role === "tool") return <StreamToolEvents events={[streamToolEventFromLegacyContent(message.content)]} />;
  if (message.streaming && message.content.trim() === "Thinking...") {
    return <span className="thinking-shimmer">Thinking...</span>;
  }
  return (
    <>
      {message.content.trim() ? <MarkdownMessage content={message.content} streaming={message.streaming} /> : null}
      {message.streamEvents?.length ? <StreamToolEvents events={message.streamEvents} /> : null}
    </>
  );
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
      {content}
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

function StreamToolEvents({ events }: { events: HermesStreamToolEvent[] }) {
  return (
    <div className="tool-progress-list" aria-label="Live tool activity">
      {events.map((event) => {
        const detail = toolEventDetail(event);
        const key = event.callId || event.id || `${event.toolName}-${event.label}`;
        const summary = (
          <>
            <span className="tool-progress-icon">
              {event.status === "running" ? <Command size={15} /> : <Check size={15} />}
            </span>
            <span className="tool-progress-title">{event.label || titleCase(event.toolName)}</span>
            <span className="tool-progress-status">{toolStatusLabel(event.status)}</span>
            {detail ? <ChevronDown className="tool-progress-chevron" size={14} /> : null}
          </>
        );

        if (!detail) {
          return (
            <div key={key} className={`tool-progress-item ${event.status}`}>
              <div className="tool-progress-summary">{summary}</div>
            </div>
          );
        }

        return (
          <details key={key} className={`tool-progress-item ${event.status}`}>
            <summary className="tool-progress-summary" aria-label={`${event.label || event.toolName} details`}>
              {summary}
            </summary>
            <pre className="tool-progress-detail">{detail}</pre>
          </details>
        );
      })}
    </div>
  );
}

function streamToolEventFromLegacyContent(content: string): HermesStreamToolEvent {
  const parsed = parseJsonObject(content.trim());
  const toolName = legacyToolName(parsed);
  return {
    id: `legacy-${content.slice(0, 40)}`,
    toolName,
    label: legacyToolLabel(toolName, parsed),
    status: legacyToolStatus(parsed),
    output: content,
  };
}

function toolStatusLabel(status: HermesStreamToolEvent["status"]) {
  if (status === "completed") return "Done";
  if (status === "error") return "Error";
  return "Running";
}

function toolEventDetail(event: HermesStreamToolEvent) {
  const sections = [];
  if (event.arguments) sections.push(`input\n${prettyToolText(event.arguments)}`);
  if (event.output) sections.push(`output\n${prettyToolText(event.output)}`);
  return sections.join("\n\n");
}

function prettyToolText(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function legacyToolName(data: Record<string, unknown> | null) {
  if (!data) return "tool";
  if (
    data.success === true &&
    typeof data.name === "string" &&
    (typeof data.content === "string" || typeof data.file === "string" || typeof data.skill_dir === "string")
  ) {
    return "skill_view";
  }
  if (stringValue(data.snapshot) || stringValue(data.url) || typeof data.element_count === "number") return "browser";
  if (
    stringValue(data.output) ||
    typeof data.exit_code === "number" ||
    typeof data.duration_seconds === "number" ||
    typeof data.tool_calls_made === "number"
  ) {
    return "terminal";
  }
  return stringValue(data.name) || "tool";
}

function legacyToolLabel(toolName: string, data: Record<string, unknown> | null) {
  if (toolName === "skill_view") return skillDisplayName(data) || "skill";
  if (toolName === "terminal") return "terminal";
  if (toolName === "browser") {
    const title = stringValue(data?.title);
    const url = stringValue(data?.url);
    return title && !/just a moment/i.test(title) ? `browser: ${title}` : url ? `browser: ${url}` : "browser";
  }
  return titleCase(toolName);
}

function skillDisplayName(data: Record<string, unknown> | null) {
  const name = stringValue(data?.name);
  if (name) return name;
  const path = stringValue(data?.path);
  if (path) return parentOrLastPathSegment(path.split("/").filter(Boolean));
  const skillDir = stringValue(data?.skill_dir);
  if (skillDir) return lastPathSegment(skillDir.split(/[\\/]/).filter(Boolean));
  return "";
}

function parentOrLastPathSegment(parts: string[]) {
  return parts.length > 1 ? parts[parts.length - 2] : lastPathSegment(parts);
}

function lastPathSegment(parts: string[]) {
  return parts.length ? parts[parts.length - 1] : "";
}

function legacyToolStatus(data: Record<string, unknown> | null): HermesStreamToolEvent["status"] {
  if (!data) return "completed";
  const status = stringValue(data.status).toLowerCase();
  const error = data.error;
  const exitCode = typeof data.exit_code === "number" ? data.exit_code : null;
  if (
    status.includes("error") ||
    status.includes("fail") ||
    data.success === false ||
    (exitCode !== null && exitCode !== 0) ||
    (error !== null && error !== undefined && String(error).trim())
  ) {
    return "error";
  }
  return "completed";
}

function parseJsonObject(value: string) {
  if (!value.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function MessageEvents({ events }: { events?: HermesParsedEvents }) {
  if (!events) return null;
  const rows = [
    ["Tools", events.toolCalls.length],
    ["Artifacts", events.artifacts.length],
    ["Memory", events.memoryWrites.length],
    ["Skills", events.skillEvents.length],
  ].filter(([, count]) => Number(count) > 0);

  return (
    <div className="event-strip">
      {rows.map(([label, count]) => (
        <span key={String(label)}>
          {label}: {count}
        </span>
      ))}
    </div>
  );
}

function eventCount(events?: HermesParsedEvents) {
  if (!events) return 0;
  return (
    events.toolCalls.length +
    events.artifacts.length +
    events.memoryWrites.length +
    events.skillEvents.length
  );
}
