import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  AlertCircle,
  Copy,
  Ellipsis,
  Folder,
  FolderOpen,
  MessageSquare,
  Pencil,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCcw,
  Search,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { navItems, viewTitle } from "../app/navigation";
import { loadJsonValue, saveJsonValue, storageKeys } from "../app/storage";
import type { ProfileActionHandler, View } from "../app/types";
import { offlineProfile } from "../app/offlineProfile";
import type { HermesConversation, HermesProfile, HermesStatus } from "../types/hermes";

type ProfileDialog =
  | { action: "create"; name: string }
  | { action: "clone"; source: string; name: string }
  | { action: "delete"; source: string; name: string };

type ProfileMenu = {
  profile: string;
  top: number;
  left: number;
};

type ConversationSearchItem = {
  conversation: HermesConversation;
  profileName: string;
};

type AppShellProps = {
  activeView: View;
  connected: boolean;
  error?: string | null;
  isRefreshing: boolean;
  previewOpen: boolean;
  primaryPane: ReactNode;
  previewPane: ReactNode;
  topbarPane?: ReactNode;
  selectedProfile: string;
  status: HermesStatus | null;
  conversations: HermesConversation[];
  conversationsByProfile: Record<string, HermesConversation[]>;
  conversationsLoadedByProfile: Record<string, boolean>;
  conversationsLoading: boolean;
  conversationsLoadingByProfile: Record<string, boolean>;
  historyError: string | null;
  historyErrorsByProfile: Record<string, string | null>;
  selectedConversationId: string | null;
  activeConversationIds: string[];
  coreApiUrl: string;
  onNewConversation: (profileName?: string) => void;
  onPreviewToggle: () => void;
  onEditProfile: (profile: string) => void;
  onProfileAction: ProfileActionHandler;
  onRefresh: () => void;
  onRefreshConversations: (profileName?: string) => void;
  onSelectConversation: (profileName: string, conversationId: string) => void;
  onSelectProfile: (profile: string) => void;
  onSelectView: (view: View) => void;
};

export function AppShell({
  activeView,
  connected,
  error,
  isRefreshing,
  previewOpen,
  primaryPane,
  previewPane,
  topbarPane,
  selectedProfile,
  status,
  conversations,
  conversationsByProfile,
  conversationsLoadedByProfile,
  conversationsLoading,
  conversationsLoadingByProfile,
  historyError,
  historyErrorsByProfile,
  selectedConversationId,
  activeConversationIds,
  coreApiUrl,
  onNewConversation,
  onPreviewToggle,
  onEditProfile,
  onProfileAction,
  onRefresh,
  onRefreshConversations,
  onSelectConversation,
  onSelectProfile,
  onSelectView,
}: AppShellProps) {
  const profiles = status?.profiles ?? [offlineProfile];
  const [profileMenu, setProfileMenu] = useState<ProfileMenu | null>(null);
  const [profileDialog, setProfileDialog] = useState<ProfileDialog | null>(null);
  const [profileActionBusy, setProfileActionBusy] = useState(false);
  const [profileActionError, setProfileActionError] = useState("");
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState("");
  const [conversationSearchIndex, setConversationSearchIndex] = useState(0);
  const conversationSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [collapsedSessionProfiles, setCollapsedSessionProfiles] = useState<Record<string, boolean>>(
    () => loadCollapsedSessionProfiles(),
  );

  const conversationSearchItems = useMemo(() => {
    const seen = new Set<string>();
    const items: ConversationSearchItem[] = [];

    for (const profile of profiles) {
      const profileConversations =
        profile.name === selectedProfile
          ? conversations
          : conversationsByProfile[profile.name] || [];

      for (const conversation of profileConversations) {
        const key = `${profile.name}:${conversation.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ conversation, profileName: profile.name });
      }
    }

    return items.sort(
      (left, right) =>
        conversationMillis(right.conversation.lastActiveAt) -
        conversationMillis(left.conversation.lastActiveAt),
    );
  }, [conversations, conversationsByProfile, profiles, selectedProfile]);

  const filteredConversationSearchItems = useMemo(() => {
    const query = conversationSearchQuery.trim().toLowerCase();
    const source = query
      ? conversationSearchItems.filter(({ conversation, profileName }) =>
          `${conversation.title} ${profileName} ${conversation.id}`.toLowerCase().includes(query),
        )
      : conversationSearchItems;

    return source.slice(0, 9);
  }, [conversationSearchItems, conversationSearchQuery]);

  useEffect(() => {
    for (const profile of profiles) {
      if (collapsedSessionProfiles[profile.name]) continue;
      if (conversationsLoadedByProfile[profile.name]) continue;
      if (conversationsLoadingByProfile[profile.name]) continue;
      onRefreshConversations(profile.name);
    }
  }, [
    collapsedSessionProfiles,
    conversationsLoadedByProfile,
    conversationsLoadingByProfile,
    onRefreshConversations,
    profiles,
  ]);

  useEffect(() => {
    if (!profileMenu) return undefined;

    const closeMenu = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".profile-menu-wrap, .profile-context-menu")) return;
      setProfileMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileMenu(null);
    };
    const closeOnLayoutChange = () => {
      setProfileMenu(null);
    };

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnLayoutChange);
    window.addEventListener("scroll", closeOnLayoutChange, true);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnLayoutChange);
      window.removeEventListener("scroll", closeOnLayoutChange, true);
    };
  }, [profileMenu]);

  useEffect(() => {
    if (!conversationSearchOpen) return undefined;
    setConversationSearchIndex(0);
    const focusTimer = window.setTimeout(() => {
      conversationSearchInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [conversationSearchOpen]);

  useEffect(() => {
    setConversationSearchIndex(0);
  }, [conversationSearchQuery]);

  useEffect(() => {
    if (!filteredConversationSearchItems.length) {
      setConversationSearchIndex(0);
      return;
    }
    setConversationSearchIndex((current) =>
      clamp(current, 0, filteredConversationSearchItems.length - 1),
    );
  }, [filteredConversationSearchItems.length]);

  useEffect(() => {
    const handleOpenSearch = () => {
      openConversationSearch();
    };
    const handleNewConversation = () => {
      startSelectedProfileConversation();
    };
    const handleShortcut = (event: KeyboardEvent) => {
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey || event.altKey || event.shiftKey) return;

      if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        openConversationSearch();
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        startSelectedProfileConversation();
      }
    };

    window.addEventListener("iris://new-conversation", handleNewConversation);
    window.addEventListener("iris://open-conversation-search", handleOpenSearch);
    window.addEventListener("keydown", handleShortcut, { capture: true });
    return () => {
      window.removeEventListener("iris://new-conversation", handleNewConversation);
      window.removeEventListener("iris://open-conversation-search", handleOpenSearch);
      window.removeEventListener("keydown", handleShortcut, { capture: true });
    };
  }, [
    conversationsLoadedByProfile,
    conversationsLoadingByProfile,
    onNewConversation,
    onRefreshConversations,
    profiles,
    selectedProfile,
  ]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-drag-zone" data-tauri-drag-region />
        <div className="brand-block">
          <div className="brand-mark">
            <Sparkles size={18} />
          </div>
          <div>
            <p className="brand-name">Iris</p>
            <p className="brand-status">
              <span className={connected ? "status-dot connected" : "status-dot"} />
              {connected ? "Chat route online" : "Route offline"}
            </p>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isNewChatAction = item.id === "chat";
            return (
              <Fragment key={item.id}>
                <button
                  className={[
                    "nav-item",
                    isNewChatAction ? "new-chat-nav-item" : "",
                    !isNewChatAction && activeView === item.id ? "active" : "",
                  ].filter(Boolean).join(" ")}
                  aria-label={isNewChatAction ? "Start new chat" : undefined}
                  aria-keyshortcuts={isNewChatAction ? "Meta+N" : undefined}
                  title={isNewChatAction ? "Start new chat" : undefined}
                  onMouseDown={isNewChatAction ? (event) => event.preventDefault() : undefined}
                  onClick={() => {
                    if (isNewChatAction) {
                      onNewConversation(selectedProfile);
                      return;
                    }
                    onSelectView(item.id);
                  }}
                >
                  <Icon size={17} />
                  <span>{item.label}</span>
                  {isNewChatAction ? <kbd className="nav-shortcut">⌘N</kbd> : null}
                </button>
                {isNewChatAction ? (
                  <button
                    type="button"
                    className={conversationSearchOpen ? "nav-item conversation-search-nav active" : "nav-item conversation-search-nav"}
                    aria-keyshortcuts="Meta+G"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={openConversationSearch}
                  >
                    <Search size={17} />
                    <span>Search</span>
                    <kbd className="nav-shortcut">⌘G</kbd>
                  </button>
                ) : null}
              </Fragment>
            );
          })}
        </nav>

        <div className="sidebar-section profile-tree">
          <div className="profile-tree-header">
            <p className="sidebar-label">Agents</p>
            <div className="profile-tree-actions">
              <button
                type="button"
                className="sidebar-icon-button"
                onClick={() => openProfileCreateDialog()}
                aria-label="Create agent"
                title="Create agent"
              >
                <Plus size={14} />
              </button>
              <button
                type="button"
                className="sidebar-icon-button"
                onClick={() => onRefreshConversations(selectedProfile)}
                disabled={conversationsLoading}
                title="Refresh conversations"
              >
                <RefreshCcw size={13} className={conversationsLoading ? "spin" : ""} />
              </button>
            </div>
          </div>
          <div className="profile-list">
            {profiles.map((profile) => {
              const selected = profile.name === selectedProfile;
              const collapsed = Boolean(collapsedSessionProfiles[profile.name]);
              const profileConversations = selected
                ? conversations
                : conversationsByProfile[profile.name] || [];
              const profileLoading = selected
                ? conversationsLoading
                : Boolean(conversationsLoadingByProfile[profile.name]);
              const profileError = selected
                ? historyError
                : historyErrorsByProfile[profile.name] || null;
              const showSessionBranch =
                !collapsed &&
                (selected ||
                  Boolean(profileError) ||
                  profileLoading ||
                  !conversationsLoadedByProfile[profile.name] ||
                  profileConversations.length > 0);
              const ProfileFolderIcon = collapsed ? Folder : FolderOpen;
              return (
                <div key={profile.name} className="profile-node">
                  <div className="profile-node-row">
                    <button
                      type="button"
                      className="profile-node-button"
                      aria-expanded={!collapsed}
                      onClick={() => {
                        const willExpand = collapsed;
                        toggleSessionsCollapsed(profile.name);
                        if (
                          willExpand &&
                          !conversationsLoadedByProfile[profile.name] &&
                          !conversationsLoadingByProfile[profile.name]
                        ) {
                          onRefreshConversations(profile.name);
                        }
                      }}
                    >
                      <ProfileFolderIcon size={16} />
                      <span>{profile.name}</span>
                    </button>
                    <div className="profile-row-actions">
                      <div className="profile-menu-wrap">
                        <button
                          type="button"
                          className="profile-row-action profile-menu-trigger"
                          title={`More actions for ${profile.name}`}
                          aria-label={`More actions for ${profile.name}`}
                          aria-haspopup="menu"
                          aria-expanded={profileMenu?.profile === profile.name}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleProfileMenu(profile.name, event.currentTarget);
                          }}
                        >
                          <Ellipsis size={17} />
                        </button>
                      </div>
                      <button
                        type="button"
                        className="profile-row-action profile-new-chat-action"
                        title={`Start new chat in ${profile.name}`}
                        aria-label={`Start new chat in ${profile.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!selected) onSelectProfile(profile.name);
                          expandSessions(profile.name);
                          onNewConversation(profile.name);
                        }}
                      >
                        <SquarePen size={16} />
                      </button>
                    </div>
                  </div>
                  {showSessionBranch ? (
                    <div className="session-branch">
                      {profileError ? <div className="history-notice">{profileError}</div> : null}
                      {profileConversations.length ? (
                        profileConversations.map((conversation) => {
                          const running = activeConversationIds.includes(conversation.id);
                          return (
                            <button
                              type="button"
                              key={conversation.id}
                              className={[
                                "sidebar-session",
                                selected && conversation.id === selectedConversationId ? "active" : "",
                                running ? "running" : "",
                              ].filter(Boolean).join(" ")}
                              onClick={() => onSelectConversation(profile.name, conversation.id)}
                            >
                              <span>{conversation.title}</span>
                              <em
                                className={running ? "sidebar-session-status streaming" : "sidebar-session-status"}
                                aria-label={running ? "Streaming response" : undefined}
                              >
                                {running ? <i aria-hidden="true" /> : timeLabel(conversation.lastActiveAt)}
                              </em>
                            </button>
                          );
                        })
                      ) : (
                        <div className="history-empty compact">
                          {profileLoading ? "Loading conversations..." : "No conversations yet."}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <button className="sidebar-refresh" onClick={onRefresh} disabled={isRefreshing}>
          <RefreshCcw size={15} className={isRefreshing ? "spin" : ""} />
          Refresh connection
        </button>
      </aside>

      <main className="workspace">
        <header className={topbarPane ? "topbar custom-topbar" : "topbar"}>
          <div className="topbar-drag-zone" data-tauri-drag-region />
          {topbarPane ?? (
            <>
              <div className="topbar-title">
                <p>{viewTitle(activeView)}</p>
                <span>{coreApiUrl}</span>
              </div>
              <div className="topbar-actions">
                {activeView === "chat" ? (
                  <button
                    className="icon-button"
                    title={previewOpen ? "Hide preview" : "Show preview"}
                    onClick={onPreviewToggle}
                  >
                    {previewOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </header>

        {error ? (
          <div className="connection-banner">
            <AlertCircle size={16} />
            <span>{error}</span>
            <button className="small-button" onClick={onRefresh} disabled={isRefreshing}>
              Retry
            </button>
          </div>
        ) : null}

        <section
          className={[
            "content-grid",
            previewOpen ? "preview-visible" : "",
            activeView === "chat" ? "chat-content" : "",
          ].filter(Boolean).join(" ")}
        >
          <div className={activeView === "chat" ? "primary-pane chat-primary-pane" : "primary-pane"}>
            {primaryPane}
          </div>
          {previewOpen ? previewPane : null}
        </section>
      </main>
      {conversationSearchOpen ? renderConversationSearch() : null}
      {profileMenu ? renderProfileMenu() : null}
      {profileDialog ? renderProfileDialog() : null}
    </div>
  );

  function openConversationSearch() {
    for (const profile of profiles) {
      if (profile.sessionCount < 1) continue;
      if (conversationsLoadedByProfile[profile.name]) continue;
      if (conversationsLoadingByProfile[profile.name]) continue;
      onRefreshConversations(profile.name);
    }
    setConversationSearchQuery("");
    setConversationSearchIndex(0);
    setConversationSearchOpen(true);
  }

  function closeConversationSearch() {
    setConversationSearchOpen(false);
    setConversationSearchQuery("");
    setConversationSearchIndex(0);
  }

  function startSelectedProfileConversation() {
    closeConversationSearch();
    onNewConversation(selectedProfile);
  }

  function selectConversationSearchItem(item: ConversationSearchItem) {
    closeConversationSearch();
    expandSessions(item.profileName);
    onSelectConversation(item.profileName, item.conversation.id);
  }

  function renderConversationSearch() {
    const heading = conversationSearchQuery.trim() ? "Matching chats" : "Recent chats";
    const loadingAnyConversation = Object.values(conversationsLoadingByProfile).some(Boolean);

    return (
      <div className="conversation-search-scrim" role="presentation" onMouseDown={closeConversationSearch}>
        <section
          className="conversation-search-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Search chats"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="conversation-search-input-wrap">
            <Search size={18} />
            <input
              ref={conversationSearchInputRef}
              value={conversationSearchQuery}
              placeholder="Search chats"
              onChange={(event) => setConversationSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeConversationSearch();
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setConversationSearchIndex((current) =>
                    clamp(current + 1, 0, Math.max(0, filteredConversationSearchItems.length - 1)),
                  );
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setConversationSearchIndex((current) =>
                    clamp(current - 1, 0, Math.max(0, filteredConversationSearchItems.length - 1)),
                  );
                }
                if (event.key === "Enter" && filteredConversationSearchItems[conversationSearchIndex]) {
                  event.preventDefault();
                  selectConversationSearchItem(filteredConversationSearchItems[conversationSearchIndex]);
                }
                if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
                  const shortcutIndex = Number(event.key) - 1;
                  const item = filteredConversationSearchItems[shortcutIndex];
                  if (item) {
                    event.preventDefault();
                    selectConversationSearchItem(item);
                  }
                }
              }}
            />
            <button
              type="button"
              className="icon-button conversation-search-close"
              title="Close search"
              onClick={closeConversationSearch}
            >
              <X size={15} />
            </button>
          </div>
          <div className="conversation-search-results">
            <p className="conversation-search-heading">
              {loadingAnyConversation && !conversationSearchItems.length ? "Loading chats" : heading}
            </p>
            {filteredConversationSearchItems.length ? (
              filteredConversationSearchItems.map((item, index) => (
                <button
                  type="button"
                  key={`${item.profileName}:${item.conversation.id}`}
                  className={index === conversationSearchIndex ? "conversation-search-row active" : "conversation-search-row"}
                  onMouseEnter={() => setConversationSearchIndex(index)}
                  onClick={() => selectConversationSearchItem(item)}
                >
                  <MessageSquare size={16} />
                  <span>{item.conversation.title}</span>
                  <small>{item.profileName}</small>
                  <kbd>{`⌘${index + 1}`}</kbd>
                </button>
              ))
            ) : (
              <p className="conversation-search-empty">
                {loadingAnyConversation ? "Loading conversations..." : "No matching chats."}
              </p>
            )}
          </div>
        </section>
      </div>
    );
  }

  function toggleSessionsCollapsed(profileName: string) {
    setCollapsedSessionProfiles((current) => {
      const next = { ...current, [profileName]: !current[profileName] };
      saveCollapsedSessionProfiles(next);
      return next;
    });
  }

  function expandSessions(profileName: string) {
    setCollapsedSessionProfiles((current) => {
      if (!current[profileName]) return current;
      const next = { ...current, [profileName]: false };
      saveCollapsedSessionProfiles(next);
      return next;
    });
  }

  function openProfileCreateDialog() {
    setProfileActionError("");
    setProfileMenu(null);
    setProfileDialog({ action: "create", name: nextProfileName("new-agent", profiles) });
  }

  function openProfileCloneDialog(source: string) {
    setProfileActionError("");
    setProfileDialog({ action: "clone", source, name: nextProfileName(`${source}-copy`, profiles) });
  }

  function openProfileDeleteDialog(source: string) {
    if (source === "default") return;
    setProfileActionError("");
    setProfileDialog({ action: "delete", source, name: "" });
  }

  function toggleProfileMenu(profileName: string, trigger: HTMLElement) {
    setProfileMenu((current) => {
      if (current?.profile === profileName) return null;
      const rect = trigger.getBoundingClientRect();
      const menuWidth = 166;
      const menuHeight = 112;
      const left = clamp(rect.right - menuWidth, 8, window.innerWidth - menuWidth - 8);
      const below = rect.bottom + 6;
      const top = below + menuHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - menuHeight - 6)
        : below;
      return { profile: profileName, top, left };
    });
  }

  function renderProfileMenu() {
    if (!profileMenu) return null;
    const profile = profiles.find((item) => item.name === profileMenu.profile);
    if (!profile) return null;

    return (
      <div
        className="profile-context-menu"
        role="menu"
        style={{ top: profileMenu.top, left: profileMenu.left }}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setProfileMenu(null);
            onEditProfile(profile.name);
          }}
        >
          <Pencil size={14} />
          Edit profile
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setProfileMenu(null);
            openProfileCloneDialog(profile.name);
          }}
        >
          <Copy size={14} />
          Duplicate
        </button>
        <button
          type="button"
          role="menuitem"
          className="danger-menu-item"
          disabled={profile.name === "default"}
          title={profile.name === "default" ? "The default agent cannot be deleted" : undefined}
          onClick={() => {
            setProfileMenu(null);
            openProfileDeleteDialog(profile.name);
          }}
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>
    );
  }

  function closeProfileDialog() {
    if (profileActionBusy) return;
    setProfileDialog(null);
    setProfileActionError("");
  }

  async function submitProfileDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profileDialog || profileActionBusy) return;

    const name = profileDialog.name.trim();
    if (profileDialog.action !== "delete" && !name) {
      setProfileActionError("Enter an agent name.");
      return;
    }
    if (profileDialog.action === "delete" && name !== profileDialog.source) {
      setProfileActionError(`Type ${profileDialog.source} to delete this profile.`);
      return;
    }

    setProfileActionBusy(true);
    setProfileActionError("");
    const message =
      profileDialog.action === "clone"
        ? await onProfileAction("clone", name, profileDialog.source)
        : profileDialog.action === "delete"
          ? await onProfileAction("delete", profileDialog.source, profileDialog.source)
          : await onProfileAction("create", name);
    setProfileActionBusy(false);

    if (isProfileActionFailure(message)) {
      setProfileActionError(message);
      return;
    }
    setProfileDialog(null);
  }

  function renderProfileDialog() {
    const dialog = profileDialog;
    if (!dialog) return null;
    const isDelete = dialog.action === "delete";
    const isClone = dialog.action === "clone";
    const source = "source" in dialog ? dialog.source : "";
    const title = isDelete
      ? `Delete ${source}`
      : isClone
        ? `Duplicate ${source}`
        : "New agent";
    const label = isDelete ? "Confirm agent name" : "Agent name";
    const submitLabel = isDelete ? "Delete" : isClone ? "Duplicate" : "Create";
    const inputValue = dialog.name;
    const submitDisabled =
      profileActionBusy ||
      (isDelete ? inputValue.trim() !== source : !inputValue.trim());

    return (
      <div className="profile-action-modal" role="dialog" aria-modal="true" aria-labelledby="profile-action-title">
        <form onSubmit={submitProfileDialog}>
          <div>
            <p className="eyebrow">{isDelete ? "Agent deletion" : "Agent management"}</p>
            <h2 id="profile-action-title">{title}</h2>
          </div>
          <label>
            <span>{label}</span>
            <input
              autoFocus
              value={inputValue}
              placeholder={isDelete ? source : "agent-name"}
              onChange={(event) => setProfileDialog({ ...dialog, name: event.target.value })}
            />
          </label>
          {profileActionError ? <p className="profile-action-error">{profileActionError}</p> : null}
          <div className="profile-action-modal-actions">
            <button type="button" className="small-button settings-button" onClick={closeProfileDialog}>
              Cancel
            </button>
            <button
              type="submit"
              className={isDelete ? "small-button settings-button danger" : "small-button settings-button"}
              disabled={submitDisabled}
            >
              {profileActionBusy ? "Working..." : submitLabel}
            </button>
          </div>
        </form>
      </div>
    );
  }
}

function nextProfileName(base: string, profiles: HermesProfile[]) {
  const names = new Set(profiles.map((profile) => profile.name));
  if (!names.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

function isProfileActionFailure(message: string) {
  return /\b(error|failed|cannot|already exists|does not exist|enter|invalid)\b/i.test(message);
}

function loadCollapsedSessionProfiles() {
  const parsed = loadJsonValue<Record<string, unknown>>(storageKeys.collapsedSessionProfiles, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, Boolean(value)]),
      )
    : {};
}

function saveCollapsedSessionProfiles(value: Record<string, boolean>) {
  saveJsonValue(storageKeys.collapsedSessionProfiles, value);
}

function timeLabel(value: number | null) {
  if (!value) return "Unknown";
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  const delta = Date.now() - millis;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "now";
  if (delta < hour) return `${Math.floor(delta / minute)}m`;
  if (delta < day) return `${Math.floor(delta / hour)}h`;
  if (delta < 14 * day) return `${Math.floor(delta / day)}d`;
  return new Date(millis).toLocaleDateString();
}

function conversationMillis(value: number | null) {
  if (!value) return 0;
  return value > 1_000_000_000_000 ? value : value * 1000;
}
