import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ComponentProps,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
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
  Search,
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
import type {
  HermesModelCatalog,
  HermesModelProvider,
  HermesModelSelection,
  HermesParsedEvents,
  HermesProfile,
  HermesSlashCommand,
  HermesStreamToolEvent,
} from "../../types/hermes";
import { normalizeChatMarkdown } from "./markdown";
import {
  filterSlashCommands,
  moveSlashCommandIndex,
  slashCommandInsertion,
  slashCommandTokenIsPartial,
  slashTokenAtCursor,
} from "./slashCommands";

type ChatViewProps = {
  messages: Message[];
  selectedConversationId: string | null;
  input: string;
  onInput: (value: string) => void;
  onSend: (options?: {
    attachments?: MessageAttachment[];
    modelSelection?: HermesModelSelection | null;
  }) => Promise<boolean> | boolean | void;
  connected: boolean;
  profile: string;
  profiles: HermesProfile[];
  onProfileChange: (profile: string) => void;
  requestActive: boolean;
  onCancel: () => void;
  modelCatalog: HermesModelCatalog | null;
  modelSelection: HermesModelSelection | null;
  lockedModelSelection: HermesModelSelection | null;
  modelLoading: boolean;
  modelError: string | null;
  onModelSelect: (selection: HermesModelSelection) => void;
  slashCommands: HermesSlashCommand[];
  slashCommandsLoading: boolean;
  slashCommandsError: string | null;
  onSlashCommandsRefresh: () => void;
};

type AttachmentDraft = MessageAttachment & {
  previewUrl?: string;
  previewRevocable?: boolean;
};

type ModelMenuOption = {
  provider: string;
  providerName: string;
  model: string;
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
  modelCatalog,
  modelSelection,
  lockedModelSelection,
  modelLoading,
  modelError,
  onModelSelect,
  slashCommands,
  slashCommandsLoading,
  slashCommandsError,
  onSlashCommandsRefresh,
}: ChatViewProps) {
  const chatPaneRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelOptionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const slashCommandRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const attachmentsRef = useRef<AttachmentDraft[]>([]);
  const sendPendingRef = useRef(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [activeModelOptionKey, setActiveModelOptionKey] = useState("");
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [composerSelection, setComposerSelection] = useState({ start: input.length, end: input.length });
  const [dismissedSlashToken, setDismissedSlashToken] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const renderedMessages = messages.filter(shouldRenderMessage);
  const newChat = !selectedConversationId && renderedMessages.length === 0;
  const composerBusy = requestActive || sendPending;
  const profileSelectionLocked = !newChat || composerBusy;
  const profileSelectionDisabled = profileSelectionLocked || !connected || profiles.length < 2;
  const displayedModelSelection = lockedModelSelection || modelSelection;
  const modelSelectionLocked = !newChat || composerBusy;
  const modelOptionsAvailable = Boolean(modelCatalog?.providers?.some((provider) => provider.models.length));
  const modelSelectionDisabled = modelSelectionLocked || !connected || modelLoading || !modelOptionsAvailable;
  const modelSelectorTitle = modelSelectionLocked
    ? "Model is locked for this conversation"
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
  const filteredModelOptions = useMemo(
    () => flattenModelOptions(filteredModelProviders),
    [filteredModelProviders],
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
  const profileSelectorTitle = profileSelectionLocked
    ? "Profile is locked for this conversation"
    : !connected
      ? "Connect Iris to select a profile"
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
    if (!modelMenuOpen) return undefined;
    setModelSearch("");
    setActiveModelOptionKey(modelOptionKeyForSelection(displayedModelSelection) || "");
    window.requestAnimationFrame(() => modelSearchRef.current?.focus());

    function handlePointerDown(event: MouseEvent) {
      if (modelMenuRef.current?.contains(event.target as Node)) return;
      setModelMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setModelMenuOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [modelMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const availableKeys = new Set(filteredModelOptions.map(modelOptionKey));
    if (activeModelOptionKey && availableKeys.has(activeModelOptionKey)) return;
    const selectedKey = modelOptionKeyForSelection(displayedModelSelection);
    setActiveModelOptionKey(selectedKey && availableKeys.has(selectedKey) ? selectedKey : modelOptionKey(filteredModelOptions[0]));
  }, [activeModelOptionKey, displayedModelSelection, filteredModelOptions, modelMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen || !activeModelOptionKey) return;
    modelOptionRefs.current[activeModelOptionKey]?.scrollIntoView({ block: "nearest" });
  }, [activeModelOptionKey, modelMenuOpen]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashToken?.query]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    setActiveSlashIndex((current) => Math.min(Math.max(current, 0), Math.max(0, filteredSlashCommands.length - 1)));
  }, [filteredSlashCommands.length, slashMenuOpen]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    const activeCommand = filteredSlashCommands[activeSlashIndex];
    if (activeCommand) slashCommandRefs.current[activeCommand.id]?.scrollIntoView({ block: "nearest" });
  }, [activeSlashIndex, filteredSlashCommands, slashMenuOpen]);

  useEffect(() => {
    if (profileSelectionDisabled) setProfileMenuOpen(false);
  }, [profileSelectionDisabled]);

  useEffect(() => {
    if (modelSelectionDisabled) setModelMenuOpen(false);
  }, [modelSelectionDisabled]);

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

  async function sendWithAttachments() {
    if (requestActive || sendPendingRef.current) return;
    sendPendingRef.current = true;
    setSendPending(true);
    try {
      const attachmentContext = attachments.map(({ previewUrl: _previewUrl, ...attachment }) => attachment);
      const sent = await onSend({
        attachments: attachmentContext,
        modelSelection: displayedModelSelection,
      });
      if (sent === false) return;
      setAttachments((current) => {
        current.forEach(revokeAttachmentPreview);
        return [];
      });
    } finally {
      sendPendingRef.current = false;
      setSendPending(false);
    }
  }

  function selectProfile(nextProfile: string) {
    setProfileMenuOpen(false);
    if (nextProfile === profile || profileSelectionDisabled) return;
    onProfileChange(nextProfile);
  }

  function selectModel(selection: HermesModelSelection) {
    setModelMenuOpen(false);
    if (modelSelectionDisabled) return;
    onModelSelect(selection);
  }

  function updateComposerSelection(element: HTMLTextAreaElement) {
    setComposerSelection({
      start: element.selectionStart,
      end: element.selectionEnd,
    });
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
    if (slashMenuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlashToken(slashTokenKey);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSlashIndex((current) =>
          moveSlashCommandIndex(current, event.key === "ArrowDown" ? 1 : -1, filteredSlashCommands.length),
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
      sendWithAttachments();
    }
  }

  function handleModelSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      const option = filteredModelOptions.find((item) => modelOptionKey(item) === activeModelOptionKey) ||
        filteredModelOptions[0];
      if (option) {
        selectModel({
          provider: option.provider,
          model: option.model,
          providerName: option.providerName,
        });
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!filteredModelOptions.length) return;
    const currentIndex = filteredModelOptions.findIndex((item) => modelOptionKey(item) === activeModelOptionKey);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex === -1
      ? event.key === "ArrowDown" ? 0 : filteredModelOptions.length - 1
      : (currentIndex + direction + filteredModelOptions.length) % filteredModelOptions.length;
    setActiveModelOptionKey(modelOptionKey(filteredModelOptions[nextIndex]));
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
                      {eventCount(message.events) ? <MessageEvents events={message.events} /> : null}
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-state">
                  <div className="view-icon">
                    <Sparkles size={18} />
                  </div>
                  <strong>
                    {requestActive ? (
                      <span className="thinking-shimmer">Thinking...</span>
                    ) : connected ? (
                      "Ready for the first request."
                    ) : (
                      "Connect Iris to start a live chat."
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
        <div className="composer-input-wrap">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => {
              onInput(event.target.value);
              updateComposerSelection(event.target);
            }}
            onClick={(event) => updateComposerSelection(event.currentTarget)}
            onFocus={(event) => updateComposerSelection(event.currentTarget)}
            onKeyUp={(event) => updateComposerSelection(event.currentTarget)}
            onSelect={(event) => updateComposerSelection(event.currentTarget)}
            placeholder={
              selectedConversationId
                ? "Ask for follow-up changes"
                : "Ask Iris to research, build, remember, or create a reusable skill..."
            }
            aria-controls={slashMenuOpen ? "composer-slash-menu" : undefined}
            aria-expanded={slashMenuOpen}
            onKeyDown={handleComposerKeyDown}
          />
          {slashMenuOpen ? (
            <div
              id="composer-slash-menu"
              className="composer-slash-menu"
              role="listbox"
              aria-label="Slash commands"
            >
              {slashCommandsLoading && !filteredSlashCommands.length ? (
                <div className="composer-slash-empty">Loading commands...</div>
              ) : null}
              {slashCommandsError && !filteredSlashCommands.length ? (
                <button
                  type="button"
                  className="composer-slash-row disabled"
                  onClick={onSlashCommandsRefresh}
                >
                  <span className="composer-slash-icon"><Command size={14} /></span>
                  <span className="composer-slash-main">
                    <strong>Commands unavailable</strong>
                    <small>Click to retry</small>
                  </span>
                </button>
              ) : null}
              {!slashCommandsLoading && !slashCommandsError && !filteredSlashCommands.length ? (
                <div className="composer-slash-empty">No matching commands</div>
              ) : null}
              {filteredSlashCommands.map((command, index) => {
                const active = index === activeSlashIndex;
                const meta = command.description || command.category || command.source;
                return (
                  <button
                    key={command.id}
                    ref={(node) => {
                      slashCommandRefs.current[command.id] = node;
                    }}
                    type="button"
                    className="composer-slash-row"
                    role="option"
                    aria-selected={active}
                    data-active={active}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveSlashIndex(index)}
                    onClick={() => insertSlashCommand(command)}
                  >
                    <span className="composer-slash-icon">
                      {command.source === "skill" ? <Sparkles size={14} /> : <Command size={14} />}
                    </span>
                    <span className="composer-slash-main">
                      <strong>{command.label || command.text}</strong>
                      {meta ? <small>{meta}</small> : null}
                    </span>
                    <span className="composer-slash-meta">{active ? "Tab" : command.category}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
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
            <div className="composer-model-menu-wrap" ref={modelMenuRef}>
              <button
                type="button"
                className="composer-model-button"
                title={modelSelectorTitle}
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                aria-label={`Model ${displayedModelSelection?.model || "unavailable"}`}
                disabled={modelSelectionDisabled}
                onClick={() => setModelMenuOpen((open) => !open)}
              >
                <Zap size={14} />
                <span>{displayedModelSelection?.model || "Model"}</span>
                <ChevronDown size={13} />
              </button>
              {modelMenuOpen ? (
                <div className="composer-model-menu" role="menu" aria-label="Choose model">
                  <label className="composer-model-search">
                    <Search size={14} />
                    <input
                      ref={modelSearchRef}
                      value={modelSearch}
                      placeholder="Search models"
                      aria-label="Search models"
                      onChange={(event) => setModelSearch(event.target.value)}
                      onKeyDown={handleModelSearchKeyDown}
                    />
                  </label>
                  {modelError ? <div className="composer-menu-note">{modelError}</div> : null}
                  {filteredModelProviders.length ? null : (
                    <div className="composer-menu-note">No matching models</div>
                  )}
                  {filteredModelProviders.map((provider) =>
                    provider.models.length ? (
                      <div key={provider.slug || provider.name} className="composer-model-group">
                        <div className="composer-model-provider">{provider.name}</div>
                        {provider.models.map((model) => {
                          const optionKey = modelOptionKey({
                            provider: provider.slug,
                            providerName: provider.name,
                            model,
                          });
                          const selected =
                            displayedModelSelection?.provider === provider.slug &&
                            displayedModelSelection?.model === model;
                          const active = activeModelOptionKey === optionKey;
                          return (
                            <button
                              key={optionKey}
                              ref={(node) => {
                                modelOptionRefs.current[optionKey] = node;
                              }}
                              type="button"
                              role="menuitemradio"
                              aria-checked={selected}
                              data-active={active}
                              onClick={() =>
                                selectModel({
                                  provider: provider.slug,
                                  model,
                                  providerName: provider.name,
                                })
                              }
                            >
                              <span>{model}</span>
                              {selected ? <Check size={14} /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null,
                  )}
                </div>
              ) : null}
            </div>
            <button type="button" className="composer-icon-button" title="Voice input">
              <Mic size={16} />
            </button>
            {requestActive ? (
              <button type="button" className="send-button cancel" onClick={onCancel} title="Cancel request">
                <Square size={15} />
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                title={sendPending ? "Sending message" : "Send message"}
                disabled={sendPending}
                aria-busy={sendPending}
              >
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

function flattenModelOptions(providers: HermesModelProvider[]): ModelMenuOption[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      provider: provider.slug,
      providerName: provider.name,
      model,
    })),
  );
}

function modelOptionKey(option: ModelMenuOption | undefined) {
  return option ? `${option.provider}:${option.model}` : "";
}

function modelOptionKeyForSelection(selection: HermesModelSelection | null) {
  return selection ? `${selection.provider}:${selection.model}` : "";
}

function MessageContent({ message }: { message: Message }) {
  if (message.role === "tool") return <StreamToolEvents events={[streamToolEventFromLegacyContent(message.content)]} />;
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
