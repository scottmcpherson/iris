import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Archive, FileCode, FileText, Image, Music, Paperclip, Pause, Play, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps, CSSProperties, MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import type { Message, MessageAttachment } from "../../../app/types";
import { agentUICoreAttachmentUrl, getAgentUICoreAttachmentDataUrl } from "../../../lib/agentuiCore";
import { attachmentTypeLabel } from "../../../shared/files";
import { Button } from "../../../shared/ui/button";
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
        if (attachment.kind === "audio") {
          return (
            <AudioAttachmentPlayer
              key={attachment.id}
              attachment={attachment}
              contentUrl={contentUrl}
              runtimeConfig={runtimeConfig}
            />
          );
        }
        const title = contentUrl ? `Open ${attachment.name}` : attachment.name;
        return (
          <Button
            key={attachment.id}
            type="button"
            variant="ghost"
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
          </Button>
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
  if ((attachment.kind === "image" || attachment.kind === "audio") && attachment.localPath) return convertFileSrc(attachment.localPath);
  return "";
}

function openAttachment(url: string) {
  void openUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

function AudioAttachmentPlayer({
  attachment,
  contentUrl,
  runtimeConfig,
}: {
  attachment: MessageAttachment;
  contentUrl: string;
  runtimeConfig: HermesRuntimeConfig;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef("");
  const decodedBufferRef = useRef<AudioBuffer | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const decodedSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const decodedStartedAtRef = useRef(0);
  const decodedOffsetRef = useRef(0);
  const decodedStopReasonRef = useRef<"ended" | "paused">("ended");
  const animationFrameRef = useRef(0);
  const [sourceUrl, setSourceUrl] = useState(() => playableDirectAudioUrl(contentUrl));
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const displayTime = currentTime > 0 ? currentTime : duration;
  const waveformStyle = { "--audio-progress": `${progress * 100}%` } as CSSProperties;

  useEffect(() => {
    stopDecodedAudio({ reset: true });
    revokeAudioObjectUrl(objectUrlRef);
    decodedBufferRef.current = null;
    setSourceUrl(playableDirectAudioUrl(contentUrl));
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);
    setLoading(false);
    setError("");
  }, [contentUrl]);

  useEffect(() => () => {
    stopDecodedAudio({ reset: true });
    revokeAudioObjectUrl(objectUrlRef);
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close();
    }
  }, []);

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !contentUrl) return;
    if (playing) {
      if (decodedSourceRef.current) {
        stopDecodedAudio({ reset: false });
      } else {
        audio.pause();
      }
      return;
    }

    if (!sourceUrl) {
      const ready = decodedBufferRef.current || await loadDecodedAudio();
      if (ready) {
        await playDecodedAudio();
      }
      return;
    }

    if (audio.paused) {
      const nextSource = sourceUrl;
      if (!nextSource) return;
      if (audio.src !== nextSource) {
        audio.src = nextSource;
        audio.load();
      }
      await audio.play().catch(() => {
        setPlaying(false);
        setError("This audio format cannot be played here.");
      });
    } else {
      audio.pause();
    }
  }

  async function loadDecodedAudio() {
    if (decodedBufferRef.current) return decodedBufferRef.current;
    setLoading(true);
    setError("");
    const result = await getAgentUICoreAttachmentDataUrl(runtimeConfig, contentUrl, attachment.mimeType, attachment.name);
    setLoading(false);
    if (!result.ok || !result.dataUrl) {
      setError(result.error || "Could not load audio.");
      return null;
    }
    try {
      const context = await getAudioContext(audioContextRef);
      const buffer = await context.decodeAudioData(dataUrlToArrayBuffer(result.dataUrl));
      decodedBufferRef.current = buffer;
      setDuration(finiteAudioTime(buffer.duration));
      return buffer;
    } catch {
      const nextSource = result.localPath ? convertFileSrc(result.localPath) : objectUrlFromDataUrl(result.dataUrl, result.mimeType);
      if (!nextSource) {
        setError("Could not prepare audio.");
        return null;
      }
      revokeAudioObjectUrl(objectUrlRef);
      objectUrlRef.current = nextSource.startsWith("blob:") ? nextSource : "";
      setSourceUrl(nextSource);
      return null;
    }
  }

  function seek(event: ReactMouseEvent<HTMLButtonElement>) {
    const audio = audioRef.current;
    if (!duration) {
      void togglePlayback();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const nextTime = ((event.clientX - rect.left) / rect.width) * duration;
    const boundedTime = Math.min(duration, Math.max(0, nextTime));
    if (decodedBufferRef.current) {
      const wasPlaying = playing;
      stopDecodedAudio({ reset: false, nextOffset: boundedTime });
      setCurrentTime(boundedTime);
      if (wasPlaying) void playDecodedAudio();
      return;
    }
    if (!audio) return;
    audio.currentTime = boundedTime;
    setCurrentTime(boundedTime);
  }

  async function playDecodedAudio() {
    const buffer = decodedBufferRef.current;
    if (!buffer) return;
    try {
      const context = await getAudioContext(audioContextRef);
      if (context.state === "suspended") await context.resume();
      const source = context.createBufferSource();
      const offset = Math.min(decodedOffsetRef.current, Math.max(0, buffer.duration - 0.01));
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        decodedSourceRef.current = null;
        cancelAnimationFrame(animationFrameRef.current);
        if (decodedStopReasonRef.current === "paused") return;
        decodedOffsetRef.current = 0;
        setCurrentTime(0);
        setPlaying(false);
      };
      decodedStopReasonRef.current = "ended";
      decodedSourceRef.current = source;
      decodedStartedAtRef.current = context.currentTime - offset;
      source.start(0, offset);
      setPlaying(true);
      tickDecodedProgress();
    } catch {
      setPlaying(false);
      setError("Could not start playback.");
    }
  }

  function stopDecodedAudio({ reset, nextOffset }: { reset: boolean; nextOffset?: number }) {
    cancelAnimationFrame(animationFrameRef.current);
    const context = audioContextRef.current;
    if (context && decodedSourceRef.current) {
      decodedStopReasonRef.current = reset ? "ended" : "paused";
      const elapsed = context.currentTime - decodedStartedAtRef.current;
      decodedOffsetRef.current = nextOffset ?? Math.min(duration || elapsed, Math.max(0, elapsed));
      decodedSourceRef.current.stop();
      decodedSourceRef.current.disconnect();
      decodedSourceRef.current = null;
    } else if (typeof nextOffset === "number") {
      decodedOffsetRef.current = nextOffset;
    }
    if (reset) {
      decodedOffsetRef.current = 0;
      setCurrentTime(0);
    }
    setPlaying(false);
  }

  function tickDecodedProgress() {
    cancelAnimationFrame(animationFrameRef.current);
    const update = () => {
      const context = audioContextRef.current;
      const buffer = decodedBufferRef.current;
      if (!context || !buffer || !decodedSourceRef.current) return;
      const nextTime = Math.min(buffer.duration, Math.max(0, context.currentTime - decodedStartedAtRef.current));
      decodedOffsetRef.current = nextTime;
      setCurrentTime(nextTime);
      animationFrameRef.current = window.requestAnimationFrame(update);
    };
    animationFrameRef.current = window.requestAnimationFrame(update);
  }

  return (
    <div className={["message-audio-player", error ? "error" : ""].filter(Boolean).join(" ")} title={attachment.name}>
      {contentUrl ? (
        <audio
          ref={audioRef}
          src={sourceUrl || undefined}
          preload="metadata"
          onDurationChange={(event) => setDuration(finiteAudioTime(event.currentTarget.duration))}
          onLoadedMetadata={(event) => setDuration(finiteAudioTime(event.currentTarget.duration))}
          onTimeUpdate={(event) => setCurrentTime(finiteAudioTime(event.currentTarget.currentTime))}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={(event) => {
            event.currentTarget.currentTime = 0;
            setPlaying(false);
            setCurrentTime(0);
          }}
          onError={() => {
            setPlaying(false);
            setError("This audio format cannot be played here.");
          }}
        />
      ) : null}
      <Button
        type="button"
        variant="ghost"
        className="message-audio-toggle"
        disabled={!contentUrl || loading}
        title={playing ? "Pause voice message" : "Play voice message"}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
        onClick={() => void togglePlayback()}
      >
        {playing ? <Pause size={18} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
      </Button>
      <div className="message-audio-main">
        <Button
          type="button"
          variant="ghost"
          className="message-audio-waveform"
          disabled={!contentUrl || loading}
          style={waveformStyle}
          aria-label="Seek voice message"
          onClick={seek}
        >
          {audioWaveformBars.map((height, index) => (
            <span key={`audio-waveform-bar-${index}`} style={{ "--bar-scale": height } as CSSProperties} />
          ))}
        </Button>
        <span className="message-audio-time">{error || (loading ? "Loading..." : formatAudioPlaybackTime(displayTime))}</span>
      </div>
    </div>
  );
}

function playableDirectAudioUrl(contentUrl: string) {
  return /^(blob|data|asset):/i.test(contentUrl) ? contentUrl : "";
}

function objectUrlFromDataUrl(dataUrl: string, fallbackMimeType: string) {
  if (!dataUrl.startsWith("data:")) return dataUrl;
  const [header, payload = ""] = dataUrl.split(",", 2);
  const mimeType = header.match(/^data:([^;]+)/)?.[1] || fallbackMimeType || "application/octet-stream";
  try {
    const binary = window.atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  } catch {
    return "";
  }
}

function dataUrlToArrayBuffer(dataUrl: string) {
  const [, payload = ""] = dataUrl.split(",", 2);
  const binary = window.atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function getAudioContext(ref: MutableRefObject<AudioContext | null>) {
  if (ref.current && ref.current.state !== "closed") return ref.current;
  const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("Audio playback is not supported.");
  ref.current = new AudioContextCtor();
  return ref.current;
}

function revokeAudioObjectUrl(ref: MutableRefObject<string>) {
  if (!ref.current) return;
  URL.revokeObjectURL(ref.current);
  ref.current = "";
}

const audioWaveformBars = [
  0.24,
  0.5,
  0.36,
  0.7,
  0.46,
  0.82,
  0.58,
  0.92,
  0.42,
  0.64,
  0.88,
  0.54,
  0.78,
  0.38,
  0.68,
  0.96,
  0.74,
  0.44,
  0.6,
  0.32,
];

function finiteAudioTime(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function formatAudioPlaybackTime(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
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
