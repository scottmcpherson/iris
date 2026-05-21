import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AlertCircle,
  ArrowDown,
  Check,
  Mic,
  Paperclip,
  Plus,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import type { Message, MessageAttachment } from "../../app/types";
import type { IrisProject } from "../../lib/irisCore";
import type { RuntimeReadiness } from "../../app/runtimeReadiness";
import {
  runtimeReadinessDetail,
  runtimeReadinessGatewayAction,
} from "../../app/runtimeReadiness";
import type {
  HermesModelCatalog,
  HermesModelProvider,
  HermesModelSelection,
  HermesParsedEvents,
  HermesProfile,
  HermesRuntimeConfig,
  HermesSlashCommand,
} from "../../types/hermes";
import {
  attachmentKindFromMime,
  attachmentKindFromPath,
  filenameFromPath,
  isPreviewableImage,
  mimeTypeFromPath,
} from "../../shared/files";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu";
import { Button } from "../../shared/ui/button";
import { StatusBanner } from "../../shared/ui/status-banner";
import {
  filterSlashCommands,
  moveSlashCommandIndex,
  slashCommandInsertion,
  slashCommandTokenIsPartial,
  slashTokenAtCursor,
} from "./slashCommands";
import { AttachmentTray } from "./components/AttachmentTray";
import { ASSISTANT_THINKING_TEXT } from "./assistantStatus";
import { SlashCommandMenu } from "./components/SlashCommandMenu";
import { ProfileMenu } from "./components/ProfileMenu";
import { ProjectMenu } from "./components/ProjectMenu";
import { ModelMenu } from "./components/ModelMenu";
import { MessageAttachments, MessageContent } from "./components/MessageContent";
import {
  DICTATION_WAVEFORM_BAR_COUNT,
  type DictationState,
  type VoiceRecording,
  useVoiceDictation,
} from "./useVoiceDictation";

type ChatViewProps = {
  messages: Message[];
  selectedSessionId: string | null;
  input: string;
  onInput: (value: string) => void;
  onSend: (options?: {
    text?: string;
    attachments?: MessageAttachment[];
    modelSelection?: HermesModelSelection | null;
    projectId?: string | null;
    onAttachmentUploadError?: (error: { id: string; name: string; message: string }) => void;
  }) => Promise<boolean> | boolean | void;
  connected: boolean;
  profile: string;
  profiles: HermesProfile[];
  projects?: IrisProject[];
  selectedProjectId?: string | null;
  onProjectChange?: (projectId: string | null) => void;
  onProfileChange: (profile: string) => void;
  requestActive: boolean;
  onCancel: () => void;
  modelCatalog: HermesModelCatalog | null;
  modelSelection: HermesModelSelection | null;
  lockedModelSelection: HermesModelSelection | null;
  modelLoading: boolean;
  modelError: string | null;
  runtimeConfig: HermesRuntimeConfig;
  onModelSelect: (selection: HermesModelSelection) => void;
  slashCommands: HermesSlashCommand[];
  slashCommandsLoading: boolean;
  slashCommandsError: string | null;
  onSlashCommandsRefresh: () => void;
  runtimeReadiness?: RuntimeReadiness;
  onGatewayAction?: (action: "start" | "restart") => void;
  gatewayActionBusy?: boolean;
  gatewayActionBusyAction?: "start" | "restart" | "stop" | null;
};

type AttachmentDraft = MessageAttachment & {
  file?: File;
  previewUrl?: string;
  previewRevocable?: boolean;
  upload?: MessageAttachment;
  uploadStatus: "local" | "uploading" | "uploaded" | "error";
  uploadError?: string;
};

type ComposerSendOptions = {
  text?: string;
  attachments?: AttachmentDraft[];
  allowDuringDictation?: boolean;
};

export function ChatView({
  messages,
  selectedSessionId,
  input,
  onInput,
  onSend,
  connected,
  profile,
  profiles,
  projects = [],
  selectedProjectId = null,
  onProjectChange,
  onProfileChange,
  requestActive,
  onCancel,
  modelCatalog,
  modelSelection,
  lockedModelSelection,
  modelLoading,
  modelError,
  runtimeConfig,
  onModelSelect,
  slashCommands,
  slashCommandsLoading,
  slashCommandsError,
  onSlashCommandsRefresh,
  runtimeReadiness = connected ? "ready" : "offline",
  onGatewayAction = () => {},
  gatewayActionBusy = false,
  gatewayActionBusyAction = null,
}: ChatViewProps) {
  const chatPaneRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const seenRenderedMessageIdsRef = useRef<Set<string>>(new Set());
  const slashCommandRefs = useRef<Record<string, HTMLElement | null>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const attachmentsRef = useRef<AttachmentDraft[]>([]);
  const sendPendingRef = useRef(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelDraftsBySession, setModelDraftsBySession] = useState<Record<string, HermesModelSelection>>({});
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [composerSelection, setComposerSelection] = useState({ start: input.length, end: input.length });
  const [dismissedSlashToken, setDismissedSlashToken] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [transcriptScrollSettling, setTranscriptScrollSettling] = useState(false);
  const renderedMessages = useMemo(() => messages.filter(shouldRenderMessage), [messages]);
  const enteringMessageIds = useMemo(() => {
    if (!requestActive) return new Set<string>();
    const unseenMessages = renderedMessages.filter((message) => !seenRenderedMessageIdsRef.current.has(message.id));
    return new Set(unseenMessages.slice(-2).map((message) => message.id));
  }, [renderedMessages, requestActive]);
  const showEmptyState = shouldShowChatEmptyState(selectedSessionId, renderedMessages.length);
  const transcriptScrollKey = chatTranscriptScrollKey(selectedSessionId, renderedMessages.length);
  const transcriptResizeBehavior = requestActive ? "smooth" : "instant";
  const newChat = !selectedSessionId && renderedMessages.length === 0;
  const inputHasText = input.trim().length > 0;
  const composerCanSend = inputHasText || attachments.length > 0;
  const composerBusy = requestActive || sendPending;
  const runtimeReady = runtimeReadiness === "ready";
  const runtimeGatewayAction = runtimeReadinessGatewayAction(runtimeReadiness);
  const runtimeNotice = runtimeReadinessDetail(runtimeReadiness, profile, runtimeConfig.connectionMode);
  const showRuntimeNotice = shouldShowRuntimeNotice(runtimeReady, runtimeNotice);
  const runtimeGatewayActionLabel = gatewayActionLabel(runtimeGatewayAction, gatewayActionBusy, gatewayActionBusyAction);
  const dictation = useVoiceDictation({
    onRecordingComplete: sendVoiceRecording,
  });
  const dictationStatus = dictation.state.status;
  const dictationBusy = dictation.active;
  const dictationToolbarOpen = dictationStatus !== "idle";
  const profileSelectionLocked = !newChat || composerBusy;
  const profileSelectionDisabled = profileSelectionLocked || dictationBusy || !connected || profiles.length < 2;
  const projectSelectionLocked = !newChat || composerBusy;
  const projectSelectionDisabled = projectSelectionLocked || dictationBusy || !connected;
  const sessionModelDraft = selectedSessionId ? modelDraftsBySession[selectedSessionId] : undefined;
  const displayedModelSelection = composerModelSelection(
    newChat,
    modelSelection,
    lockedModelSelection,
    sessionModelDraft,
  );
  const modelSelectionLocked = shouldLockComposerModelSelection(composerBusy);
  const modelOptionsAvailable = Boolean(modelCatalog?.providers?.some((provider) => provider.models.length));
  const modelSelectionDisabled = modelSelectionLocked || dictationBusy || !connected || (!modelOptionsAvailable && !displayedModelSelection);
  const modelSelectorTitle = modelSelectionLocked
    ? "Model is locked while this request is active"
    : modelLoading
      ? "Models are loading"
      : !connected
        ? "Connect Iris to select a model"
        : !modelOptionsAvailable
          ? "No model catalog available"
          : "Change model";
  const filteredModelProviders = useMemo(
    () => filterModelProviders(modelCatalog?.providers || [], modelSearch),
    [modelCatalog, modelSearch],
  );
  const slashToken = composerSelection.start === composerSelection.end
    ? slashTokenAtCursor(input, composerSelection.start) || slashTokenAtCursor(input, input.length)
    : null;
  const slashTokenKey = slashToken ? `${slashToken.from}:${slashToken.to}:${slashToken.query}` : "";
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(slashCommands, slashToken?.query || ""),
    [slashCommands, slashToken?.query],
  );
  const slashMenuOpen = Boolean(
    slashToken &&
      dismissedSlashToken !== slashTokenKey &&
      connected &&
      (filteredSlashCommands.length || slashCommandsLoading || slashCommandsError || slashCommands.length === 0),
  );

  useLayoutEffect(() => {
    if (newChat || requestActive || !selectedSessionId || renderedMessages.length === 0) {
      setTranscriptScrollSettling(false);
      return;
    }

    setTranscriptScrollSettling(true);
    const settleTimer = window.setTimeout(() => {
      setTranscriptScrollSettling(false);
    }, 240);

    return () => {
      window.clearTimeout(settleTimer);
    };
  }, [newChat, renderedMessages.length, requestActive, selectedSessionId, transcriptScrollKey]);

  const profileSelectorTitle = profileSelectionLocked
    ? "Agent is locked for this session"
    : !connected
      ? "Connect Iris to select an agent"
      : profiles.length < 2
        ? "Only one agent is available"
        : "Change agent";
  const projectSelectorTitle = projectSelectionLocked
    ? "Project is locked for this session"
    : !connected
      ? "Connect Iris to select a project"
      : "Change project";

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    setModelSearch("");
    window.requestAnimationFrame(() => modelSearchRef.current?.focus());
    return undefined;
  }, [modelMenuOpen]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashToken?.query]);

  useEffect(() => {
    if (!slashToken) setDismissedSlashToken("");
  }, [slashToken]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    setActiveSlashIndex((current) => Math.min(Math.max(current, 0), Math.max(0, filteredSlashCommands.length - 1)));
  }, [filteredSlashCommands.length, slashMenuOpen]);

  useEffect(() => {
    if (profileSelectionDisabled) setProfileMenuOpen(false);
  }, [profileSelectionDisabled]);

  useEffect(() => {
    if (projectSelectionDisabled) setProjectMenuOpen(false);
  }, [projectSelectionDisabled]);

  useEffect(() => {
    if (modelSelectionDisabled) setModelMenuOpen(false);
  }, [modelSelectionDisabled]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    for (const message of renderedMessages) {
      seenRenderedMessageIdsRef.current.add(message.id);
    }
    if (seenRenderedMessageIdsRef.current.size > 600) {
      seenRenderedMessageIdsRef.current = new Set(
        Array.from(seenRenderedMessageIdsRef.current).slice(-400),
      );
    }
  }, [renderedMessages]);

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
      ...files.map((file) => {
        const mimeType = file.type || mimeTypeFromPath(file.name);
        const kind = attachmentKindFromMime(mimeType, file.name);
        const previewable = isPreviewableImage(mimeType, file.name);
        return {
          id: crypto.randomUUID(),
          name: file.name,
          kind,
          mimeType,
          size: file.size,
          lastModified: file.lastModified,
          file,
          previewUrl: previewable ? URL.createObjectURL(file) : undefined,
          previewRevocable: previewable,
          uploadStatus: "local",
        } satisfies AttachmentDraft;
      }),
    ]);
  }

  function addPaths(paths: string[]) {
    if (!paths.length) return;

    setAttachments((current) => [
      ...current,
      ...paths.map((path) => {
        const name = filenameFromPath(path);
        const mimeType = mimeTypeFromPath(path);
        const previewable = isPreviewableImage(mimeType, path);
        return {
          id: crypto.randomUUID(),
          name,
          kind: attachmentKindFromPath(path),
          mimeType,
          size: -1,
          lastModified: Date.now(),
          localPath: path,
          previewUrl: previewable ? convertFileSrc(path) : undefined,
          uploadStatus: "local",
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

  async function sendWithAttachments(options: ComposerSendOptions = {}) {
    const draftText = options.text ?? input;
    const draftAttachments = options.attachments ?? attachments;
    const hasSendableContent = draftText.trim().length > 0 || draftAttachments.length > 0;
    if (!runtimeReady || !hasSendableContent || requestActive || sendPendingRef.current || (dictationBusy && !options.allowDuringDictation)) {
      return false;
    }
    sendPendingRef.current = true;
    setSendPending(true);
    setAttachments(draftAttachments.map((attachment) => ({ ...attachment, uploadStatus: "uploading", uploadError: undefined })));
    try {
      const sent = await onSend({
        text: draftText,
        attachments: draftAttachments,
        modelSelection: displayedModelSelection,
        projectId: selectedProjectId || null,
        onAttachmentUploadError: ({ id, message }) => {
          setAttachments((current) =>
            current.map((attachment) =>
              attachment.id === id
                ? { ...attachment, uploadStatus: "error", uploadError: message }
                : attachment,
            ),
          );
        },
      });
      if (sent === false) {
        setAttachments((current) =>
          current.map((attachment) =>
            attachment.uploadStatus === "uploading"
              ? { ...attachment, uploadStatus: "local" }
              : attachment,
          ),
        );
        return;
      }
      setAttachments([]);
    } finally {
      sendPendingRef.current = false;
      setSendPending(false);
    }
  }

  async function sendVoiceRecording(recording: VoiceRecording) {
    const voiceAttachment = voiceRecordingAttachment(recording);
    const draftAttachments = [...attachmentsRef.current, voiceAttachment];
    setAttachments(draftAttachments);
    const sent = await sendWithAttachments({
      text: input.trim(),
      attachments: draftAttachments,
      allowDuringDictation: true,
    });
    if (sent === false) throw new Error("Could not send that voice message.");
  }

  function selectProfile(nextProfile: string) {
    setProfileMenuOpen(false);
    if (nextProfile === profile || profileSelectionDisabled) return;
    onProfileChange(nextProfile);
  }

  function selectProject(nextProjectId: string | null) {
    setProjectMenuOpen(false);
    if (projectSelectionDisabled) return;
    onProjectChange?.(nextProjectId);
  }

  function selectModel(selection: HermesModelSelection) {
    setModelMenuOpen(false);
    if (modelSelectionDisabled) return;
    if (!newChat && selectedSessionId) {
      setModelDraftsBySession((current) => ({ ...current, [selectedSessionId]: selection }));
    }
    onModelSelect(selection);
  }

  function updateComposerSelection(element: HTMLTextAreaElement) {
    setComposerSelection({
      start: element.selectionStart,
      end: element.selectionEnd,
    });
  }

  function startVoiceInput() {
    if (dictationBusy) return;
    setAddMenuOpen(false);
    setProfileMenuOpen(false);
    setProjectMenuOpen(false);
    setModelMenuOpen(false);
    setDismissedSlashToken(slashTokenKey);
    void dictation.start();
  }

  function insertSlashCommand(command: HermesSlashCommand) {
    if (!slashToken) return;
    const next = slashCommandInsertion(input, slashToken, command);
    onInput(next.value);
    setDismissedSlashToken("");
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
      setComposerSelection({ start: next.cursor, end: next.cursor });
    });
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (
      !slashMenuOpen &&
      event.key === "/" &&
      slashToken &&
      slashToken.query === "" &&
      dismissedSlashToken === slashTokenKey
    ) {
      event.preventDefault();
      setDismissedSlashToken("");
      return;
    }

    if (slashMenuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlashToken(slashTokenKey);
        return;
      }
      const slashArrowDirection = slashCommandArrowDirection(event.key);
      if (slashArrowDirection) {
        event.preventDefault();
        setActiveSlashIndex((current) =>
          moveSlashCommandIndex(current, slashArrowDirection, filteredSlashCommands.length),
        );
        return;
      }
      if (event.key === "Tab") {
        const command = filteredSlashCommands[activeSlashIndex] || filteredSlashCommands[0];
        if (command) {
          event.preventDefault();
          insertSlashCommand(command);
        }
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const command = filteredSlashCommands[activeSlashIndex] || filteredSlashCommands[0];
        if (command && slashToken && slashCommandTokenIsPartial(input, slashToken, command)) {
          event.preventDefault();
          insertSlashCommand(command);
          return;
        }
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendWithAttachments();
      return;
    }

    if (event.key === "Escape" && dictationBusy) {
      event.preventDefault();
      dictation.cancel();
    }
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
          <span>Drop files to add them</span>
        </div>
      ) : null}
      {newChat ? (
        <div className="new-chat-center">
          <h1>What should we work on in {profile}?</h1>
        </div>
      ) : (
        <div className="chat-workspace">
          <StickToBottom
            key={transcriptScrollKey}
            className={[
              "message-list-frame",
              transcriptScrollSettling ? "message-list-frame-settling" : "",
            ].filter(Boolean).join(" ")}
            initial="instant"
            resize={transcriptResizeBehavior}
            role="log"
          >
            <StickToBottom.Content className="session-column" scrollClassName="message-list">
              {renderedMessages.length ? (
                renderedMessages.map((message) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    runtimeConfig={runtimeConfig}
                    entering={enteringMessageIds.has(message.id)}
                  />
                ))
              ) : showEmptyState ? (
                <div className="empty-state">
                  <div className="view-icon">
                    <Sparkles size={18} />
                  </div>
                  <strong>
                    {requestActive ? (
                      <span className="thinking-shimmer">{ASSISTANT_THINKING_TEXT}</span>
                    ) : connected ? (
                      "Ready for the first request."
                    ) : (
                      "Connect Iris to start a live session."
                    )}
                  </strong>
                  <span>
                    {requestActive
                      ? "Iris is working on this request."
                      : connected
                      ? "Ask for research, code changes, memory work, or a reusable skill."
                      : "Use Settings to pick a local or remote runtime API, then retry the connection."}
                  </span>
                </div>
              ) : null}
            </StickToBottom.Content>
            <ScrollToBottomButton />
          </StickToBottom>
        </div>
      )}

      <form
        className="composer"
        data-dictation-state={dictationStatus}
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
        <div className="composer-input-wrap">
          {showRuntimeNotice ? (
            <StatusBanner
              tone="degraded"
              icon={AlertCircle}
              className="mb-1"
              action={
                runtimeGatewayAction ? (
                  <Button
                    type="button"
                    variant="appNeutral"
                    size="appSmall"
                    disabled={gatewayActionBusy}
                    onClick={() => onGatewayAction(runtimeGatewayAction)}
                  >
                    {runtimeGatewayActionLabel}
                  </Button>
                ) : null
              }
            >
              {runtimeNotice}
            </StatusBanner>
          ) : null}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => {
              onInput(event.target.value);
              setDismissedSlashToken("");
              updateComposerSelection(event.target);
            }}
            onClick={(event) => updateComposerSelection(event.currentTarget)}
            onFocus={(event) => updateComposerSelection(event.currentTarget)}
            onKeyUp={(event) => updateComposerSelection(event.currentTarget)}
            onSelect={(event) => updateComposerSelection(event.currentTarget)}
            placeholder={
              selectedSessionId
                ? "Ask for follow-up changes"
                : "Ask Iris to research, build, remember, or create a reusable skill..."
            }
            aria-controls={slashMenuOpen ? "composer-slash-menu" : undefined}
            aria-expanded={slashMenuOpen}
            onKeyDown={handleComposerKeyDown}
          />
          {slashMenuOpen ? (
            <SlashCommandMenu
              commands={filteredSlashCommands}
              activeIndex={activeSlashIndex}
              loading={slashCommandsLoading}
              error={slashCommandsError}
              runtimeReadiness={runtimeReadiness}
              profile={profile}
              commandRefs={slashCommandRefs}
              onRefresh={onSlashCommandsRefresh}
              onGatewayAction={onGatewayAction}
              gatewayActionBusy={gatewayActionBusy}
              gatewayActionBusyAction={gatewayActionBusyAction}
              onActiveIndex={setActiveSlashIndex}
              onSelect={insertSlashCommand}
            />
          ) : null}
        </div>
        <AttachmentTray attachments={attachments} onRemove={removeAttachment} />
        <div className={["composer-toolbar", dictationToolbarOpen ? "recording" : ""].filter(Boolean).join(" ")}>
          <div className="composer-tools composer-tools-left">
            <div className="composer-add-menu-wrap">
              <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="composerIcon"
                    size="composerIcon"
                    title="Add context"
                    aria-label="Add context"
                  >
                    <Plus data-icon="inline-start" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  side="top"
                  sideOffset={10}
                  className="min-w-[178px]"
                >
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={openFilePicker}>
                      <span>Add files</span>
                      <Paperclip data-icon="inline-end" className="ml-auto" />
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="composer-profile-menu-wrap">
              <ProfileMenu
                profile={profile}
                profiles={profiles}
                connected={connected}
                open={profileMenuOpen}
                disabled={profileSelectionDisabled}
                title={profileSelectorTitle}
                locked={profileSelectionLocked}
                onOpenChange={setProfileMenuOpen}
                onSelect={selectProfile}
              />
            </div>
            <div className="composer-project-menu-wrap">
              <ProjectMenu
                projects={projects}
                selectedProjectId={selectedProjectId}
                connected={connected}
                open={projectMenuOpen}
                disabled={projectSelectionDisabled}
                title={projectSelectorTitle}
                locked={projectSelectionLocked}
                onOpenChange={setProjectMenuOpen}
                onSelect={selectProject}
              />
            </div>
          </div>
          <div className="composer-tools composer-actions">
            {dictationToolbarOpen ? (
              <DictationWaveform
                state={dictation.state}
                onCancel={dictation.state.status === "error" ? dictation.dismissError : dictation.cancel}
                onConfirm={dictation.stop}
              />
            ) : (
              <>
                <div className="composer-model-menu-wrap">
                  <ModelMenu
                    open={modelMenuOpen}
                    disabled={modelSelectionDisabled}
                    title={modelSelectorTitle}
                    selection={displayedModelSelection}
                    providers={filteredModelProviders}
                    modelSearch={modelSearch}
                    modelError={modelError}
                    searchRef={modelSearchRef}
                    onOpenChange={setModelMenuOpen}
                    onSearch={setModelSearch}
                    onSelect={selectModel}
                  />
                </div>
                <Button
                  type="button"
                  variant="composerIcon"
                  size="composerIcon"
                  title={requestActive ? "Wait for the current request to finish" : "Start voice input"}
                  aria-label="Start voice input"
                  disabled={dictationBusy || requestActive}
                  onClick={startVoiceInput}
                >
                  <Mic data-icon="inline-start" />
                </Button>
              </>
            )}
            {!dictationToolbarOpen ? (
              requestActive ? (
                <Button type="button" variant="composerSend" size="composerSend" onClick={onCancel} title="Cancel request">
                  <Square data-icon="inline-start" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="composerSend"
                  size="composerSend"
                  title={
                    !composerCanSend
                      ? "Enter a message or add a file to send"
                      : !runtimeReady
                        ? runtimeNotice || "Runtime is not ready"
                      : sendPending
                        ? "Sending message"
                        : "Send message"
                  }
                  disabled={!composerCanSend || !runtimeReady || sendPending}
                  aria-busy={sendPending}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    void sendWithAttachments();
                  }}
                  onClick={() => void sendWithAttachments()}
                >
                  <Send data-icon="inline-start" />
                </Button>
              )
            ) : null}
          </div>
        </div>
      </form>
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  message,
  runtimeConfig,
  entering,
}: {
  message: Message;
  runtimeConfig: HermesRuntimeConfig;
  entering: boolean;
}) {
  return (
    <article className={["message", message.role, entering ? "message-entering" : ""].filter(Boolean).join(" ")}>
      {message.role === "system" ? (
        <div className="message-kicker">
          <Sparkles size={14} />
          <span>System</span>
        </div>
      ) : null}
      {message.attachments?.length && message.role !== "assistant" ? (
        <MessageAttachments attachments={message.attachments} runtimeConfig={runtimeConfig} />
      ) : null}
      {shouldRenderMessageBody(message) ? (
        <div className="message-body">
          <MessageContent message={message} />
          {eventCount(message.events) ? <MessageEvents events={message.events} /> : null}
        </div>
      ) : null}
      {message.attachments?.length && message.role === "assistant" ? (
        <MessageAttachments attachments={message.attachments} runtimeConfig={runtimeConfig} />
      ) : null}
    </article>
  );
});

function DictationWaveform({
  state,
  onCancel,
  onConfirm,
}: {
  state: DictationState;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const audioLevel = state.status === "recording" ? state.audioLevel : 0;
  const waveformStyle = { "--dictation-level": audioLevel } as CSSProperties;
  const audioLevels = state.status === "recording" ? state.audioLevels : [];
  const statusText =
    state.status === "requesting-permission"
      ? "Requesting microphone..."
      : state.status === "stopping"
        ? "Stopping..."
        : state.status === "sending"
          ? "Sending..."
          : state.status === "error"
            ? state.message
            : "Recording";

  const showStatus = shouldShowVisibleDictationStatus(state);
  const canCancel =
    state.status === "requesting-permission" ||
    state.status === "recording" ||
    state.status === "error";
  const canConfirm = state.status === "recording";

  return (
    <div className="composer-recording-wave-wrap" role={state.status === "error" ? "alert" : "status"} aria-live="polite">
      <div className="composer-recording-waveform" style={waveformStyle} aria-hidden="true">
        {Array.from({ length: DICTATION_WAVEFORM_BAR_COUNT }, (_, index) => (
          <span
            key={`dictation-waveform-bar-${index}`}
            style={{
              "--bar-index": index,
              "--bar-level": audioLevels[index] ?? 0,
            } as CSSProperties}
          />
        ))}
      </div>
      {!showStatus ? <span className="sr-only">{statusText}</span> : null}
      {showStatus ? <span className="composer-recording-status">{statusText}</span> : null}
      <Button
        type="button"
        variant="composerRecordingCancel"
        size="composerRecording"
        title={state.status === "error" ? "Dismiss voice error" : "Cancel voice input"}
        aria-label={state.status === "error" ? "Dismiss voice error" : "Cancel voice input"}
        disabled={!canCancel}
        onClick={onCancel}
      >
        <X data-icon="inline-start" />
      </Button>
      <Button
        type="button"
        variant="composerRecordingConfirm"
        size="composerRecording"
        title={canConfirm ? "Send voice input" : statusText}
        aria-label="Send voice input"
        disabled={!canConfirm}
        onClick={onConfirm}
      >
        <Check data-icon="inline-start" />
      </Button>
    </div>
  );
}

function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) return null;

  return (
    <Button
      className="chat-scroll-bottom-button"
      type="button"
      variant="ghost"
      title="Jump to latest message"
      onClick={() => {
        void scrollToBottom("smooth");
      }}
    >
      <ArrowDown size={16} />
    </Button>
  );
}

function revokeAttachmentPreview(attachment: AttachmentDraft) {
  if (attachment.previewUrl && attachment.previewRevocable) URL.revokeObjectURL(attachment.previewUrl);
}

function voiceRecordingAttachment(recording: VoiceRecording): AttachmentDraft {
  const mimeType = voiceRecordingMimeType(recording);
  return {
    id: crypto.randomUUID(),
    name: voiceRecordingFilename(mimeType),
    kind: "audio",
    mimeType,
    size: recording.file.size,
    lastModified: recording.file.lastModified,
    file: new File([recording.file], voiceRecordingFilename(mimeType), {
      type: mimeType,
      lastModified: recording.file.lastModified,
    }),
    uploadStatus: "local",
  };
}

function voiceRecordingMimeType(recording: VoiceRecording) {
  const mimeType = (recording.mimeType || recording.file.type || "audio/webm").toLowerCase();
  if (mimeType.includes("webm")) return "audio/webm";
  if (mimeType.includes("mp4")) return "audio/mp4";
  if (mimeType.includes("aac")) return "audio/aac";
  if (mimeType.includes("wav")) return "audio/wav";
  return mimeType.startsWith("audio/") ? mimeType : "audio/webm";
}

function voiceRecordingFilename(mimeType: string) {
  if (mimeType.includes("mp4")) return "dictation.mp4";
  if (mimeType.includes("aac")) return "dictation.aac";
  if (mimeType.includes("wav")) return "dictation.wav";
  return "dictation.webm";
}

function pointInRect(x: number, y: number, rect: DOMRect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function slashCommandArrowDirection(key: string): 1 | -1 | 0 {
  if (key === "ArrowDown" || key === "Down") return 1;
  if (key === "ArrowUp" || key === "Up") return -1;
  return 0;
}

function shouldRenderMessage(message: Message) {
  return Boolean(
    message.content.trim() ||
      message.attachments?.length ||
      message.streaming ||
      message.streamEvents?.length ||
      eventCount(message.events),
  );
}

export function shouldRenderMessageBody(message: Message) {
  return Boolean(
    message.content.trim() ||
      message.streaming ||
      message.streamEvents?.length ||
      eventCount(message.events),
  );
}

export function shouldShowChatEmptyState(selectedSessionId: string | null, renderedMessageCount: number) {
  return !selectedSessionId && renderedMessageCount === 0;
}

export function chatTranscriptScrollKey(selectedSessionId: string | null, renderedMessageCount: number) {
  if (!selectedSessionId) return "new-chat";
  return `${selectedSessionId}:${renderedMessageCount > 0 ? "ready" : "pending"}`;
}

export function shouldLockComposerModelSelection(composerBusy: boolean) {
  return composerBusy;
}

function gatewayActionLabel(
  action: "start" | "restart" | null,
  busy: boolean,
  busyAction: "start" | "restart" | "stop" | null,
) {
  if (action === "start") return busy && busyAction === "start" ? "Starting gateway..." : "Start gateway";
  if (action === "restart") return busy && busyAction === "restart" ? "Restarting gateway..." : "Restart gateway";
  return "";
}

export function shouldShowVisibleDictationStatus(state: DictationState) {
  return state.status === "error";
}

export function shouldShowRuntimeNotice(runtimeReady: boolean, runtimeNotice: string) {
  return Boolean(runtimeNotice) && !runtimeReady;
}

export function composerModelSelection(
  newChat: boolean,
  modelSelection: HermesModelSelection | null,
  lockedModelSelection: HermesModelSelection | null,
  sessionModelDraft?: HermesModelSelection,
) {
  return newChat
    ? modelSelection
    : sessionModelDraft || lockedModelSelection || modelSelection;
}

function filterModelProviders(providers: HermesModelProvider[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return providers;
  return providers
    .map((provider) => {
      const providerMatches =
        provider.name.toLowerCase().includes(normalizedQuery) ||
        provider.slug.toLowerCase().includes(normalizedQuery);
      const models = providerMatches
        ? provider.models
        : provider.models.filter((model) => model.toLowerCase().includes(normalizedQuery));
      return { ...provider, models };
    })
    .filter((provider) => provider.models.length);
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
