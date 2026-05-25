import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type KeyboardEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { Check, Command as CommandIcon, Mic, Plus, Send, Sparkles, Square, X } from "lucide-react-native";
import { Button as MenuButton, Host, Menu } from "@expo/ui/swift-ui";
import { disabled as disabledModifier, tint } from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import {
  attachmentTypeLabel,
  filterSlashCommands,
  formatAttachmentSize,
  slashCommandInsertion,
  slashTokenAtCursor,
  type ChatSlashCommand,
} from "@iris/chat-core";
import type { IrisCoreSlashCommand } from "@iris/core-client";
import type { MobileAttachmentDraft } from "../chat/mobileAttachments";
import { useTheme } from "../theme/useTheme";
import { GlassSurface } from "./GlassSurface";
import { OptionSheet, type OptionSheetItem } from "./OptionSheet";

export function ChatComposer({
  disabled,
  requestActive = false,
  contextBar,
  slashCommands = [],
  slashCommandsLoading = false,
  slashCommandsError = null,
  placeholder,
  attachments = [],
  onAddAttachment,
  onPickPhoto,
  onTakePhoto,
  onRemoveAttachment,
  onVoiceRecording,
  onCancel,
  onSend,
}: {
  disabled?: boolean;
  requestActive?: boolean;
  contextBar?: ReactNode;
  slashCommands?: IrisCoreSlashCommand[];
  slashCommandsLoading?: boolean;
  slashCommandsError?: string | null;
  placeholder?: string;
  attachments?: MobileAttachmentDraft[];
  onAddAttachment?: () => void | Promise<void>;
  onPickPhoto?: () => void | Promise<void>;
  onTakePhoto?: () => void | Promise<void>;
  onRemoveAttachment?: (id: string) => void;
  onVoiceRecording?: (recording: { uri: string; durationMillis: number }) => void;
  onCancel?: () => void;
  onSend: (text: string) => boolean | Promise<boolean | void> | void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const styles = createStyles(theme, windowHeight);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const keyboardOffset = useSharedValue(0);
  const offsetCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [text, setText] = useState("");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [sendPending, setSendPending] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentSourceOpen, setAttachmentSourceOpen] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  // iOS 26 renders a native Liquid Glass menu; older OS / Android fall back to the bottom sheet.
  const [nativeMenuAvailable] = useState(() => Platform.OS === "ios" && isLiquidGlassAvailable());
  const contextDisabled = Boolean(disabled || requestActive || sendPending || voiceBusy);
  const canSend = (Boolean(text.trim()) || attachments.length > 0) && !disabled && !requestActive && !sendPending;
  const slashToken = selection.start === selection.end
    ? slashTokenAtCursor(text, selection.start) || slashTokenAtCursor(text, text.length)
    : null;
  const suggestedCommands = useMemo(
    () => (slashToken ? filterSlashCommands(slashCommands, slashToken.query) : []),
    [slashCommands, slashToken],
  );
  const showSlashTray = Boolean(
    slashToken &&
      !requestActive &&
      !disabled,
  );
  const voiceToolbarOpen = Boolean(recorderState.isRecording || voiceBusy || voiceError);
  const attachmentSourceItems = useMemo(
    () => attachmentOptions({ onAddAttachment, onPickPhoto, onTakePhoto }),
    [onAddAttachment, onPickPhoto, onTakePhoto],
  );

  useEffect(() => {
    if (Platform.OS === "web") return undefined;

    // Tapping a native pill menu briefly resigns/re-acquires the text field's first
    // responder, which fires a hide-then-show pair. Growth applies immediately (so the
    // composer never lags the keyboard rising), but shrink is debounced — a quick
    // hide→show cancels the pending drop, so the composer doesn't bounce.
    function commitKeyboardOffset(target: number, duration: number) {
      if (offsetCommitTimer.current) {
        clearTimeout(offsetCommitTimer.current);
        offsetCommitTimer.current = null;
      }
      const animate = () => {
        keyboardOffset.value = withTiming(target, { duration, easing: Easing.out(Easing.cubic) });
      };
      if (target >= keyboardOffset.value) {
        animate();
      } else {
        offsetCommitTimer.current = setTimeout(animate, 120);
      }
    }

    function syncToKeyboard(event: KeyboardEvent) {
      const keyboardHeight = Math.max(0, windowHeight - event.endCoordinates.screenY);
      commitKeyboardOffset(Math.max(0, keyboardHeight - insets.bottom), event.duration || 250);
    }

    function resetKeyboardOffset(event?: KeyboardEvent) {
      commitKeyboardOffset(0, event?.duration || 220);
    }

    const showSubscription = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow",
      syncToKeyboard,
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      resetKeyboardOffset,
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
      if (offsetCommitTimer.current) clearTimeout(offsetCommitTimer.current);
    };
  }, [insets.bottom, keyboardOffset, windowHeight]);

  const keyboardStyle = useAnimatedStyle(() => ({
    bottom: keyboardOffset.value,
  }));

  async function send() {
    const value = text.trim();
    if ((!value && !attachments.length) || disabled || requestActive || sendPending) return;
    setSendPending(true);
    try {
      const result = await onSend(value);
      if (result !== false) {
        setText("");
        setSelection({ start: 0, end: 0 });
      }
    } finally {
      setSendPending(false);
    }
  }

  async function openAttachmentSource() {
    if (contextDisabled || attachmentSourceItems.length === 0) return;
    if (attachmentSourceItems.length === 1) {
      await selectAttachmentSource(attachmentSourceItems[0]?.id || "");
      return;
    }
    setAttachmentError("");
    setAttachmentSourceOpen(true);
  }

  async function selectAttachmentSource(id: string) {
    if (contextDisabled) return;
    const action = attachmentAction(id, { onAddAttachment, onPickPhoto, onTakePhoto });
    if (!action) return;
    setAttachmentError("");
    try {
      await action();
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Could not add that attachment.");
    }
  }

  async function startVoiceInput() {
    if (!onVoiceRecording || contextDisabled) return;
    setVoiceError("");
    setVoiceBusy(true);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setVoiceError("Microphone permission is required.");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Could not start voice input.");
    } finally {
      setVoiceBusy(false);
    }
  }

  async function confirmVoiceInput() {
    if (!onVoiceRecording || voiceBusy) return;
    setVoiceBusy(true);
    try {
      const durationMillis = recorderState.durationMillis;
      if (recorderState.isRecording) await recorder.stop();
      const uri = recorder.uri || recorderState.url;
      if (!uri) throw new Error("Voice recording did not produce a file.");
      onVoiceRecording({ uri, durationMillis });
      await setAudioModeAsync({ allowsRecording: false });
      setVoiceError("");
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Could not finish voice input.");
    } finally {
      setVoiceBusy(false);
    }
  }

  async function cancelVoiceInput() {
    if (voiceError) {
      setVoiceError("");
      return;
    }
    setVoiceBusy(true);
    try {
      if (recorderState.isRecording) await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
    } catch {
      setVoiceError("");
    } finally {
      setVoiceBusy(false);
    }
  }

  function insertCommand(command: ChatSlashCommand) {
    if (!slashToken) return;
    const next = slashCommandInsertion(text, slashToken, command);
    setText(next.value);
    setSelection({ start: next.cursor, end: next.cursor });
  }

  return (
    <>
      <Animated.View style={[styles.keyboardFrame, keyboardStyle]}>
      <View style={[styles.wrap, { paddingBottom: theme.spacing[3] + insets.bottom }]}>
        {showSlashTray ? (
          <GlassSurface style={styles.slashMenuSurface} fallbackStyle={styles.slashMenuFill}>
            {slashCommandsLoading && !suggestedCommands.length ? (
              <Text style={styles.slashStatus}>Loading commands...</Text>
            ) : null}
            {slashCommandsError && !suggestedCommands.length ? (
              <View style={styles.slashCommandRow}>
                <View style={styles.slashIcon}>
                  <CommandIcon color={theme.colors.textSubtle} size={16} />
                </View>
                <View style={styles.slashCommandText}>
                  <Text style={styles.slashTitle} numberOfLines={1}>Commands unavailable</Text>
                  <Text style={styles.slashDescription} numberOfLines={1}>{slashCommandsError}</Text>
                </View>
              </View>
            ) : null}
            {!slashCommandsLoading && !slashCommandsError && !suggestedCommands.length ? (
              <Text style={styles.slashStatus}>No matching commands</Text>
            ) : null}
            {suggestedCommands.length ? (
              <ScrollView showsVerticalScrollIndicator={false} style={styles.slashScroll} contentContainerStyle={styles.slashList}>
                {suggestedCommands.map((command) => {
                  const meta = command.description || command.category || command.source;
                  const Icon = command.source === "skill" ? Sparkles : CommandIcon;
                  return (
                    <Pressable
                      key={command.id || command.text}
                      accessibilityRole="button"
                      accessibilityLabel={`Insert ${command.text}`}
                      onPress={() => insertCommand(command)}
                      style={({ pressed }) => [styles.slashCommandRow, pressed ? styles.pressed : null]}
                    >
                      <View style={styles.slashIcon}>
                        <Icon color={theme.colors.textSubtle} size={16} />
                      </View>
                      <View style={styles.slashCommandText}>
                        <Text style={styles.slashTitle} numberOfLines={1}>{command.label || command.text}</Text>
                        {meta ? <Text style={styles.slashDescription} numberOfLines={1}>{meta}</Text> : null}
                      </View>
                      {command.category ? <Text style={styles.slashCategory} numberOfLines={1}>{command.category}</Text> : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}
          </GlassSurface>
        ) : null}
        <GlassSurface style={styles.surface} fallbackStyle={styles.surfaceFill}>
          {contextBar ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              contentContainerStyle={styles.contextBar}
            >
              {contextBar}
            </ScrollView>
          ) : null}
          <TextInput
            value={text}
            onChangeText={(value) => {
              setText(value);
              if (selection.start > value.length || selection.end > value.length) {
                setSelection({ start: value.length, end: value.length });
              }
            }}
            selection={selection}
            onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
            placeholder={placeholder || "Ask anything"}
            placeholderTextColor={theme.colors.textMuted}
            multiline
            editable={!disabled && !sendPending}
            style={styles.input}
          />
          {attachments.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachmentTray}>
              {attachments.map((attachment) => {
                const hasError = attachment.uploadStatus === "error";
                const detail = hasError
                  ? attachment.uploadError || "Upload failed."
                  : attachment.uploadStatus === "uploading"
                    ? "Uploading"
                    : `${attachmentTypeLabel(attachment.kind, attachment.mimeType)} - ${formatAttachmentSize(attachment.size)}`;
                return (
                  <View
                    key={attachment.id}
                    style={[styles.attachmentPill, hasError ? styles.attachmentPillError : null]}
                  >
                    <View style={styles.attachmentText}>
                      <Text style={styles.attachmentName} numberOfLines={1}>{attachment.name}</Text>
                      <Text style={[styles.attachmentMeta, hasError ? styles.attachmentMetaError : null]} numberOfLines={1}>
                        {detail}
                      </Text>
                    </View>
                    {onRemoveAttachment ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${attachment.name}`}
                        disabled={attachment.uploadStatus === "uploading"}
                        onPress={() => onRemoveAttachment(attachment.id)}
                        style={({ pressed }) => [
                          styles.smallIconButton,
                          pressed ? styles.pressed : null,
                          attachment.uploadStatus === "uploading" ? styles.iconButtonDisabled : null,
                        ]}
                      >
                        <X color={theme.colors.textMuted} size={14} />
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
          ) : null}
          {attachmentError ? <Text style={styles.composerStatus}>{attachmentError}</Text> : null}
          <View style={styles.toolRow}>
            <View style={styles.leadingTools}>
              {attachmentSourceItems.length ? (
                nativeMenuAvailable ? (
                  <Host matchContents style={styles.menuHost}>
                    <Menu
                      label=""
                      systemImage="plus"
                      modifiers={contextDisabled ? [tint(theme.colors.textMuted), disabledModifier(true)] : [tint(theme.colors.textMuted)]}
                    >
                      {/* Declared bottom-to-top: the composer's upward-opening menu reverses items,
                          so the visible order reads Files, Camera, Photos top-to-bottom. */}
                      {onPickPhoto ? (
                        <MenuButton label="Photos" systemImage="photo.on.rectangle" onPress={() => void selectAttachmentSource("photos")} />
                      ) : null}
                      {onTakePhoto ? (
                        <MenuButton label="Camera" systemImage="camera" onPress={() => void selectAttachmentSource("camera")} />
                      ) : null}
                      {onAddAttachment ? (
                        <MenuButton label="Files" systemImage="doc" onPress={() => void selectAttachmentSource("files")} />
                      ) : null}
                    </Menu>
                  </Host>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Add context"
                    disabled={contextDisabled}
                    onPress={() => void openAttachmentSource()}
                    style={({ pressed }) => [
                      styles.toolButton,
                      contextDisabled ? styles.toolButtonDisabled : null,
                      pressed && !contextDisabled ? styles.pressed : null,
                    ]}
                  >
                    <Plus color={theme.colors.textMuted} size={24} />
                  </Pressable>
                )
              ) : null}
            </View>
            <View style={styles.trailingTools}>
              {onVoiceRecording ? (
                voiceToolbarOpen ? (
                  <View style={styles.voicePanel}>
                    <Text style={styles.voiceStatus} numberOfLines={1}>
                      {voiceError || (recorderState.isRecording ? `Recording ${formatDuration(recorderState.durationMillis)}` : "Preparing voice input")}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={voiceError ? "Dismiss voice error" : "Cancel voice input"}
                      disabled={voiceBusy && !voiceError}
                      onPress={() => void cancelVoiceInput()}
                      style={({ pressed }) => [styles.toolButton, pressed ? styles.pressed : null]}
                    >
                      <X color={theme.colors.textMuted} size={20} />
                    </Pressable>
                    {!voiceError ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Send voice input"
                        disabled={voiceBusy || !recorderState.isRecording}
                        onPress={() => void confirmVoiceInput()}
                        style={({ pressed }) => [
                          styles.toolButton,
                          !recorderState.isRecording ? styles.toolButtonDisabled : null,
                          pressed && recorderState.isRecording ? styles.pressed : null,
                        ]}
                      >
                        <Check color={theme.colors.textMuted} size={20} />
                      </Pressable>
                    ) : null}
                  </View>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Start voice input"
                    disabled={contextDisabled}
                    onPress={() => void startVoiceInput()}
                    style={({ pressed }) => [
                      styles.toolButton,
                      contextDisabled ? styles.toolButtonDisabled : null,
                      pressed && !contextDisabled ? styles.pressed : null,
                    ]}
                  >
                    <Mic color={theme.colors.textMuted} size={22} />
                  </Pressable>
                )
              ) : null}
              {requestActive && onCancel ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel request"
                  onPress={onCancel}
                  style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
                >
                  <Square color={theme.colors.buttonPrimaryText} size={20} />
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  disabled={!canSend}
                  onPress={() => void send()}
                  style={({ pressed }) => [
                    styles.iconButton,
                    !canSend ? styles.iconButtonDisabled : null,
                    pressed && canSend ? styles.pressed : null,
                  ]}
                >
                  <Send color={canSend ? theme.colors.buttonPrimaryText : theme.colors.textMuted} size={22} />
                </Pressable>
              )}
            </View>
          </View>
        </GlassSurface>
      </View>
      </Animated.View>
      <OptionSheet
        visible={attachmentSourceOpen}
        title="Add context"
        items={attachmentSourceItems}
        onSelect={(id) => void selectAttachmentSource(id)}
        onClose={() => setAttachmentSourceOpen(false)}
      />
    </>
  );
}

function attachmentOptions({
  onAddAttachment,
  onPickPhoto,
  onTakePhoto,
}: {
  onAddAttachment?: () => void | Promise<void>;
  onPickPhoto?: () => void | Promise<void>;
  onTakePhoto?: () => void | Promise<void>;
}): OptionSheetItem[] {
  const items: OptionSheetItem[] = [];
  if (onAddAttachment) {
    items.push({
      id: "files",
      label: "Files",
      detail: "Attach a document or other file.",
    });
  }
  if (onPickPhoto) {
    items.push({
      id: "photos",
      label: "Photo library",
      detail: "Choose one or more photos.",
    });
  }
  if (onTakePhoto) {
    items.push({
      id: "camera",
      label: "Camera",
      detail: "Take a new photo.",
    });
  }
  return items;
}

function attachmentAction(
  id: string,
  actions: {
    onAddAttachment?: () => void | Promise<void>;
    onPickPhoto?: () => void | Promise<void>;
    onTakePhoto?: () => void | Promise<void>;
  },
) {
  if (id === "files") return actions.onAddAttachment;
  if (id === "photos") return actions.onPickPhoto;
  if (id === "camera") return actions.onTakePhoto;
  return null;
}

function formatDuration(durationMillis: number) {
  const totalSeconds = Math.max(0, Math.round(durationMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function createStyles(theme: ReturnType<typeof useTheme>, windowHeight: number) {
  return StyleSheet.create({
    keyboardFrame: {
      position: "relative",
      zIndex: 2,
    },
    wrap: {
      backgroundColor: "transparent",
      paddingHorizontal: theme.spacing[3],
      paddingBottom: theme.spacing[3],
      gap: theme.spacing[2],
    },
    surface: {
      borderRadius: 28,
      overflow: "hidden",
      paddingHorizontal: theme.spacing[4],
      paddingTop: theme.spacing[4],
      paddingBottom: theme.spacing[3],
      gap: theme.spacing[2],
    },
    surfaceFill: {
      borderWidth: 1,
      borderColor: theme.colors.borderStrong,
      backgroundColor: theme.colors.surfaceElevated,
    },
    slashMenuSurface: {
      maxHeight: Math.min(320, Math.max(188, windowHeight * 0.34)),
      borderRadius: 28,
      overflow: "hidden",
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[2],
    },
    slashMenuFill: {
      borderWidth: 1,
      borderColor: theme.colors.borderStrong,
      backgroundColor: theme.colors.surfaceRaised,
    },
    slashScroll: {
      maxHeight: Math.min(304, Math.max(172, windowHeight * 0.34 - theme.spacing[4])),
    },
    slashList: {
      gap: theme.spacing[1],
    },
    slashCommandRow: {
      minHeight: 58,
      borderRadius: theme.radius.lg,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[1],
      gap: theme.spacing[2],
    },
    slashIcon: {
      width: 28,
      height: 28,
      borderRadius: theme.radius.md,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.secondary,
    },
    slashCommandText: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    slashTitle: {
      color: theme.colors.text,
      fontSize: 17,
      lineHeight: 21,
      fontWeight: "700",
    },
    slashDescription: {
      color: theme.colors.textMuted,
      fontSize: 13,
      lineHeight: 17,
      fontWeight: "600",
    },
    slashCategory: {
      maxWidth: 96,
      color: theme.colors.textMuted,
      fontSize: 13,
      lineHeight: 17,
      fontWeight: "700",
    },
    slashStatus: {
      color: theme.colors.textMuted,
      fontSize: 13,
      lineHeight: 18,
      fontWeight: "600",
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[2],
    },
    attachmentTray: {
      gap: theme.spacing[2],
      paddingRight: theme.spacing[2],
    },
    attachmentPill: {
      width: 220,
      minHeight: 54,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
      backgroundColor: theme.colors.surfaceRaised,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    attachmentPillError: {
      borderColor: theme.colors.danger,
    },
    attachmentText: {
      flex: 1,
      minWidth: 0,
      gap: 2,
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
    attachmentMetaError: {
      color: theme.colors.danger,
    },
    composerStatus: {
      color: theme.colors.danger,
      fontSize: 13,
      lineHeight: 18,
    },
    contextBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingRight: theme.spacing[2],
    },
    toolRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      minHeight: 48,
      gap: theme.spacing[2],
    },
    leadingTools: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[3],
      minWidth: 0,
    },
    trailingTools: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: theme.spacing[2],
    },
    toolButton: {
      width: 34,
      height: 38,
      borderRadius: 19,
      alignItems: "center",
      justifyContent: "center",
    },
    menuHost: {
      height: 38,
      justifyContent: "center",
    },
    toolButtonDisabled: {
      opacity: 0.46,
    },
    smallIconButton: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.surface,
    },
    voicePanel: {
      maxWidth: 220,
      minHeight: 38,
      borderRadius: 19,
      backgroundColor: theme.colors.input,
      paddingLeft: theme.spacing[2],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
    },
    voiceStatus: {
      flex: 1,
      color: theme.colors.textMuted,
      fontSize: 13,
      fontWeight: "700",
    },
    input: {
      minHeight: 26,
      maxHeight: 148,
      color: theme.colors.text,
      paddingHorizontal: 0,
      paddingVertical: 0,
      fontSize: 20,
      lineHeight: 26,
      textAlignVertical: "top",
    },
    iconButton: {
      width: 48,
      height: 48,
      borderRadius: 24,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.buttonPrimary,
    },
    iconButtonDisabled: {
      backgroundColor: theme.colors.accent,
    },
    pressed: {
      opacity: 0.76,
    },
  });
}
