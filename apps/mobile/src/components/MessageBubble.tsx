import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Check, ChevronDown, Command, Pause, Play, X } from "lucide-react-native";
import {
  attachmentTypeLabel,
  formatAttachmentSize,
  toolEventDetail,
  toolStatusLabel,
  type ChatMessage,
  type ChatStreamToolEvent,
  type MessageAttachment,
} from "@iris/chat-core";
import { coreAttachmentUrl, type IrisCoreClient } from "@iris/core-client";
import { MobileMarkdown } from "./MobileMarkdown";
import { useTheme } from "../theme/useTheme";

export function MessageBubble({ message, client }: { message: ChatMessage; client?: IrisCoreClient | null }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const isUser = message.role === "user";
  const mediaHeaders = useCoreMediaHeaders(client);
  return (
    <View style={[styles.wrap, isUser ? styles.userWrap : styles.assistantWrap]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        {message.streamEvents?.length ? (
          <View style={styles.toolEvents} accessibilityLabel="Tool activity">
            {message.streamEvents.map((event) => (
              <ToolEventRow key={event.callId || event.id} event={event} />
            ))}
          </View>
        ) : null}
        {message.content || message.streaming ? (
          isUser ? (
            <Text style={[styles.text, styles.userText]}>
              {message.content || (message.streaming ? "Thinking..." : "")}
            </Text>
          ) : (
            <MobileMarkdown content={message.content || (message.streaming ? "Thinking..." : "")} />
          )
        ) : null}
        {message.attachments?.length ? (
          <View style={styles.attachments}>
            {message.attachments.map((attachment) => (
              <AttachmentView
                key={attachment.id}
                attachment={attachment}
                client={client}
                isUser={isUser}
                mediaHeaders={mediaHeaders}
                styles={styles}
                theme={theme}
              />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function AttachmentView({
  attachment,
  client,
  isUser,
  mediaHeaders,
  styles,
  theme,
}: {
  attachment: MessageAttachment;
  client?: IrisCoreClient | null;
  isUser: boolean;
  mediaHeaders: Record<string, string> | null;
  styles: MessageBubbleStyles;
  theme: ReturnType<typeof useTheme>;
}) {
  const previewUrl = attachmentPreviewUrl(attachment, client);
  const contentUrl = attachmentContentUrl(attachment, client);
  const source = useMemo(
    () => mediaSource(previewUrl || contentUrl, mediaHeaders),
    [contentUrl, mediaHeaders, previewUrl],
  );

  if (attachment.kind === "audio") {
    return (
      <AudioAttachment
        attachment={attachment}
        client={client}
        isUser={isUser}
        mediaHeaders={mediaHeaders}
        styles={styles}
        theme={theme}
      />
    );
  }

  return (
    <View style={[styles.attachment, isUser ? styles.userAttachment : null]}>
      {attachment.kind === "image" && source ? (
        <Image
          source={source}
          style={styles.attachmentImage}
          contentFit="cover"
          accessibilityLabel={attachment.name}
        />
      ) : null}
      <AttachmentLabel attachment={attachment} isUser={isUser} styles={styles} />
    </View>
  );
}

function AudioAttachment({
  attachment,
  client,
  isUser,
  mediaHeaders,
  styles,
  theme,
}: {
  attachment: MessageAttachment;
  client?: IrisCoreClient | null;
  isUser: boolean;
  mediaHeaders: Record<string, string> | null;
  styles: MessageBubbleStyles;
  theme: ReturnType<typeof useTheme>;
}) {
  const contentUrl = attachmentContentUrl(attachment, client);
  const source = useMemo(() => mediaSource(contentUrl, mediaHeaders), [contentUrl, mediaHeaders]);
  const player = useAudioPlayer(source, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const canPlay = Boolean(source);

  function togglePlayback() {
    if (!canPlay) return;
    if (status.playing) {
      player.pause();
    } else {
      player.play();
    }
  }

  return (
    <View style={[styles.attachment, styles.audioAttachment, isUser ? styles.userAttachment : null]}>
      <View style={styles.audioRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={status.playing ? `Pause ${attachment.name}` : `Play ${attachment.name}`}
          disabled={!canPlay}
          onPress={togglePlayback}
          style={({ pressed }) => [
            styles.audioButton,
            isUser ? styles.userAudioButton : null,
            !canPlay ? styles.audioButtonDisabled : null,
            pressed && canPlay ? styles.pressed : null,
          ]}
        >
          {status.playing ? (
            <Pause color={isUser ? theme.colors.buttonPrimary : theme.colors.text} size={15} />
          ) : (
            <Play color={isUser ? theme.colors.buttonPrimary : theme.colors.text} size={15} />
          )}
        </Pressable>
        <View style={styles.audioText}>
          <AttachmentLabel attachment={attachment} isUser={isUser} styles={styles} />
          <Text style={[styles.attachmentMeta, isUser ? styles.userAttachmentMeta : null]} numberOfLines={1}>
            {audioTimeLabel(status.currentTime, status.duration)}
          </Text>
        </View>
      </View>
    </View>
  );
}

function AttachmentLabel({
  attachment,
  isUser,
  styles,
}: {
  attachment: MessageAttachment;
  isUser: boolean;
  styles: MessageBubbleStyles;
}) {
  return (
    <>
      <Text style={[styles.attachmentName, isUser ? styles.userText : null]} numberOfLines={1}>
        {attachment.name}
      </Text>
      <Text style={[styles.attachmentMeta, isUser ? styles.userAttachmentMeta : null]} numberOfLines={1}>
        {attachmentTypeLabel(attachment.kind, attachment.mimeType)} - {formatAttachmentSize(attachment.size)}
      </Text>
    </>
  );
}

function ToolEventRow({ event }: { event: ChatStreamToolEvent }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const [expanded, setExpanded] = useState(false);
  const detail = toolEventDetail(event);
  const statusLabel = toolStatusLabel(event.status);
  const iconColor = event.status === "error" ? theme.colors.danger : event.status === "running" ? theme.colors.warning : theme.colors.success;
  const label = event.label || event.toolName;

  return (
    <View style={[styles.toolEvent, event.status === "error" ? styles.toolEventError : null]}>
      <Pressable
        accessibilityRole={detail ? "button" : undefined}
        accessibilityLabel={detail ? `${label} ${statusLabel} details` : `${label} ${statusLabel}`}
        disabled={!detail}
        onPress={() => setExpanded((current) => !current)}
        style={styles.toolSummary}
      >
        <View style={styles.toolIcon}>
          {event.status === "running" ? (
            <Command color={iconColor} size={14} />
          ) : event.status === "error" ? (
            <X color={iconColor} size={14} />
          ) : (
            <Check color={iconColor} size={14} />
          )}
        </View>
        <Text style={styles.toolLabel} numberOfLines={2}>{label}</Text>
        <Text style={[styles.toolStatus, event.status === "error" ? styles.toolStatusError : null]}>{statusLabel}</Text>
        {detail ? (
          <ChevronDown
            color={theme.colors.textMuted}
            size={14}
            style={[styles.toolChevron, expanded ? styles.toolChevronExpanded : null]}
          />
        ) : null}
      </Pressable>
      {expanded && detail ? <Text style={styles.toolDetail}>{detail}</Text> : null}
    </View>
  );
}

function useCoreMediaHeaders(client: IrisCoreClient | null | undefined) {
  const [headerState, setHeaderState] = useState<{
    client: IrisCoreClient | null | undefined;
    headers: Record<string, string>;
  }>({ client: null, headers: {} });

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(client?.transport.headers?.() || {}).then((nextHeaders) => {
      if (!cancelled) setHeaderState({ client, headers: nextHeaders });
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return headerState.client === client ? headerState.headers : null;
}

function attachmentPreviewUrl(attachment: MessageAttachment, client: IrisCoreClient | null | undefined) {
  return mediaUrl(attachment.previewUrl, client) ||
    (attachment.kind === "image" ? mediaUrl(attachment.localPath, client) : "");
}

function attachmentContentUrl(attachment: MessageAttachment, client: IrisCoreClient | null | undefined) {
  return mediaUrl(attachment.downloadUrl, client) ||
    mediaUrl(attachment.localPath, client) ||
    mediaUrl(attachment.previewUrl, client);
}

function mediaUrl(url: string | undefined, client: IrisCoreClient | null | undefined) {
  if (!url) return "";
  if (url.startsWith("/") && !url.startsWith("/v1/")) return "";
  if (client) return coreAttachmentUrl(client, url);
  if (url.startsWith("/v1/")) return "";
  return url;
}

function mediaSource(url: string, headers: Record<string, string> | null) {
  if (!url) return null;
  if (needsDeferredHeaders(url) && headers === null) return null;
  return { uri: url, ...(headers && Object.keys(headers).length ? { headers } : {}) };
}

function needsDeferredHeaders(url: string) {
  return /^https?:/i.test(url);
}

function audioTimeLabel(currentTime: number, duration: number) {
  const current = formatAudioSeconds(currentTime);
  const total = duration > 0 ? formatAudioSeconds(duration) : "--:--";
  return `${current} / ${total}`;
}

function formatAudioSeconds(value: number) {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

type MessageBubbleStyles = ReturnType<typeof createStyles>;

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    wrap: {
      flexDirection: "row",
      width: "100%",
    },
    userWrap: {
      justifyContent: "flex-end",
    },
    assistantWrap: {
      justifyContent: "flex-start",
    },
    bubble: {
      borderRadius: theme.radius.lg,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[3],
      borderWidth: 1,
      gap: theme.spacing[2],
    },
    userBubble: {
      maxWidth: "82%",
      backgroundColor: theme.colors.buttonPrimary,
      borderColor: theme.colors.buttonPrimary,
    },
    assistantBubble: {
      width: "100%",
      maxWidth: "100%",
      borderWidth: 0,
      borderRadius: 0,
      paddingHorizontal: 0,
      paddingVertical: theme.spacing[1],
    },
    text: {
      color: theme.colors.text,
      fontSize: 16,
      lineHeight: 22,
    },
    userText: {
      color: theme.colors.buttonPrimaryText,
    },
    toolEvents: {
      gap: theme.spacing[2],
    },
    toolEvent: {
      minWidth: 210,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
      backgroundColor: theme.colors.surface,
      overflow: "hidden",
    },
    toolEventError: {
      borderColor: theme.colors.statusOfflineBorder,
    },
    toolSummary: {
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
    },
    toolIcon: {
      width: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    toolLabel: {
      flex: 1,
      color: theme.colors.text,
      fontSize: 13,
      lineHeight: 17,
      fontWeight: "700",
    },
    toolStatus: {
      color: theme.colors.textMuted,
      fontSize: 11,
      fontWeight: "700",
      textTransform: "uppercase",
    },
    toolStatusError: {
      color: theme.colors.danger,
    },
    toolChevron: {
      transform: [{ rotate: "-90deg" }],
    },
    toolChevronExpanded: {
      transform: [{ rotate: "0deg" }],
    },
    toolDetail: {
      borderTopWidth: 1,
      borderTopColor: theme.colors.borderSubtle,
      color: theme.colors.textSubtle,
      fontFamily: theme.typography.fontFamily.mono,
      fontSize: 11,
      lineHeight: 16,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
    },
    attachments: {
      gap: theme.spacing[2],
    },
    attachment: {
      minWidth: 190,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      gap: 2,
      overflow: "hidden",
    },
    userAttachment: {
      borderColor: theme.colors.buttonPrimaryText,
      backgroundColor: theme.colors.buttonPrimary,
    },
    attachmentImage: {
      width: 240,
      height: 180,
      maxWidth: "100%",
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.surfaceRaised,
      marginBottom: theme.spacing[1],
    },
    audioAttachment: {
      minWidth: 240,
    },
    audioRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[3],
    },
    audioButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surfaceRaised,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
    },
    userAudioButton: {
      backgroundColor: theme.colors.buttonPrimaryText,
      borderColor: theme.colors.buttonPrimaryText,
    },
    audioButtonDisabled: {
      opacity: 0.5,
    },
    audioText: {
      flex: 1,
      minWidth: 0,
    },
    attachmentName: {
      color: theme.colors.text,
      fontSize: 13,
      fontWeight: "700",
    },
    attachmentMeta: {
      color: theme.colors.textMuted,
      fontSize: 12,
    },
    userAttachmentMeta: {
      color: theme.colors.buttonPrimaryText,
    },
    pressed: {
      opacity: 0.72,
    },
  });
}
