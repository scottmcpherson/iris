import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  Folder,
  FolderOpen,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCcw,
  Search,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import irisSidebarIcon from "../assets/iris-sidebar-icon.png";
import { navItems, viewTitle } from "../app/navigation";
import { loadJsonValue, saveJsonValue, storageKeys } from "../app/storage";
import type { ProfileActionHandler, View } from "../app/types";
import { offlineProfile } from "../app/offlineProfile";
import { CodeEditor } from "../shared/CodeEditor";
import type { AgentUICoreAgent, IrisProject } from "../lib/agentuiCore";
import type { HermesConversation, HermesProfile, HermesStatus } from "../types/hermes";

const SIDEBAR_AUTO_COLLAPSE_WIDTH = 1500;
const SIDEBAR_STANDARD_WIDTH = 252;
const SIDEBAR_COLLAPSED_WIDTH = 0;
const SIDEBAR_MAX_WIDTH = 440;

type ProfileDialog =
  | { action: "create"; name: string }
  | { action: "clone"; source: string; name: string }
  | { action: "delete"; source: string; name: string };

type ProjectDialog =
  | { action: "create"; name: string; defaultAgentId: string; systemPrompt: string }
  | { action: "edit"; projectId: string; name: string; defaultAgentId: string; systemPrompt: string };

type ProfileMenu = {
  profile: string;
  top: number;
  left: number;
};

type ProjectMenu = {
  projectId: string;
  top: number;
  left: number;
};

type ConversationMenu = {
  conversation: HermesConversation;
  profileName: string;
  pinKey: string;
  top: number;
  left: number;
};

type ConversationDialog = {
  conversation: HermesConversation;
  profileName: string;
  name: string;
};

type ConversationSearchItem = {
  conversation: HermesConversation;
  profileName: string;
  sourceLabel: string;
  pinKey: string;
  select: () => void;
};

type SidebarSectionId = "projects" | "chats" | "agents";

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
  conversationReadStates: Record<string, "read" | "unread">;
  projects: IrisProject[];
  projectAgents: AgentUICoreAgent[];
  conversationsByProject: Record<string, HermesConversation[]>;
  projectConversationsLoading: Record<string, boolean>;
  projectConversationsLoaded: Record<string, boolean>;
  projectErrors: Record<string, string | null>;
  collapsedProjects: Record<string, boolean>;
  unprojectedConversations: HermesConversation[];
  conversationsLoadedByProfile: Record<string, boolean>;
  conversationsLoading: boolean;
  conversationsLoadingByProfile: Record<string, boolean>;
  historyError: string | null;
  historyErrorsByProfile: Record<string, string | null>;
  selectedConversationId: string | null;
  selectedProjectId: string;
  activeConversationIds: string[];
  coreApiUrl: string;
  onNewConversation: (profileName?: string, projectId?: string) => void;
  onCreateProject: (payload: { name: string; defaultAgentId: string; systemPrompt: string }) => Promise<IrisProject>;
  onUpdateProject: (
    projectId: string,
    payload: { name: string; defaultAgentId: string; systemPrompt: string },
  ) => Promise<IrisProject>;
  onToggleProjectCollapsed: (projectId: string) => void;
  onRefreshProjects: () => void;
  onRefreshProjectConversations: (projectId: string) => void;
  onPreviewToggle: () => void;
  onEditProfile: (profile: string) => void;
  onProfileAction: ProfileActionHandler;
  onRefresh: () => void;
  onRefreshConversations: (profileName?: string) => void;
  onDeleteConversation: (profileName: string, conversationId: string) => Promise<string>;
  onRenameConversation: (profileName: string, conversationId: string, title: string) => Promise<string>;
  onSelectConversation: (profileName: string, conversationId: string) => void;
  onSelectProjectConversation: (projectId: string, profileName: string, conversationId: string) => void;
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
  conversationReadStates,
  projects,
  projectAgents,
  conversationsByProject,
  projectConversationsLoading,
  projectConversationsLoaded,
  projectErrors,
  collapsedProjects,
  unprojectedConversations,
  conversationsLoadedByProfile,
  conversationsLoading,
  conversationsLoadingByProfile,
  historyError,
  historyErrorsByProfile,
  selectedConversationId,
  selectedProjectId,
  activeConversationIds,
  coreApiUrl,
  onNewConversation,
  onCreateProject,
  onUpdateProject,
  onToggleProjectCollapsed,
  onRefreshProjects,
  onRefreshProjectConversations,
  onPreviewToggle,
  onEditProfile,
  onProfileAction,
  onRefresh,
  onRefreshConversations,
  onDeleteConversation,
  onRenameConversation,
  onSelectConversation,
  onSelectProjectConversation,
  onSelectProfile,
  onSelectView,
}: AppShellProps) {
  const profiles = status?.profiles ?? [offlineProfile];
  const [profileMenu, setProfileMenu] = useState<ProfileMenu | null>(null);
  const [projectMenu, setProjectMenu] = useState<ProjectMenu | null>(null);
  const [conversationMenu, setConversationMenu] = useState<ConversationMenu | null>(null);
  const [profileDialog, setProfileDialog] = useState<ProfileDialog | null>(null);
  const [projectDialog, setProjectDialog] = useState<ProjectDialog | null>(null);
  const [conversationDialog, setConversationDialog] = useState<ConversationDialog | null>(null);
  const [confirmDeleteConversationKey, setConfirmDeleteConversationKey] = useState("");
  const [profileActionBusy, setProfileActionBusy] = useState(false);
  const [profileActionError, setProfileActionError] = useState("");
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [projectActionError, setProjectActionError] = useState("");
  const [conversationActionBusy, setConversationActionBusy] = useState(false);
  const [conversationActionError, setConversationActionError] = useState("");
  const [pinnedConversations, setPinnedConversations] = useState<Record<string, boolean>>(
    () => loadPinnedConversations(),
  );
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState("");
  const [conversationSearchIndex, setConversationSearchIndex] = useState(0);
  const conversationSearchInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarWidthBandRef = useRef(widthBandForWindow());
  const sidebarCollapsedRef = useRef(sidebarWidthBandRef.current === "compact");
  const expandedBeforeResponsiveCollapseRef = useRef(!sidebarCollapsedRef.current);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(sidebarCollapsedRef.current);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_STANDARD_WIDTH);
  const [collapsedSessionProfiles, setCollapsedSessionProfiles] = useState<Record<string, boolean>>(
    () => loadCollapsedSessionProfiles(),
  );
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState<Record<SidebarSectionId, boolean>>(
    () => loadCollapsedSidebarSections(),
  );
  const projectsSectionCollapsed = Boolean(collapsedSidebarSections.projects);
  const chatsSectionCollapsed = Boolean(collapsedSidebarSections.chats);
  const agentsSectionCollapsed = Boolean(collapsedSidebarSections.agents);

  useEffect(() => {
    sidebarCollapsedRef.current = sidebarCollapsed;
  }, [sidebarCollapsed]);

  useEffect(() => {
    const handleSidebarShortcut = (event: KeyboardEvent) => {
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      setSidebarCollapsedWithTransition((current) => !current);
    };

    window.addEventListener("keydown", handleSidebarShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleSidebarShortcut, { capture: true });
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const nextBand = widthBandForWindow();
      const previousBand = sidebarWidthBandRef.current;

      if (previousBand === "regular" && nextBand === "compact") {
        expandedBeforeResponsiveCollapseRef.current = !sidebarCollapsedRef.current;
      }

      if (nextBand === "compact") {
        setSidebarCollapsedWithTransition(true);
        sidebarWidthBandRef.current = nextBand;
        return;
      }

      if (
        previousBand === "compact" &&
        nextBand === "regular" &&
        expandedBeforeResponsiveCollapseRef.current
      ) {
        setSidebarCollapsedWithTransition(false);
      }

      sidebarWidthBandRef.current = nextBand;
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const conversationSearchItems = useMemo(() => {
    const seen = new Set<string>();
    const items: ConversationSearchItem[] = [];

    for (const project of projects) {
      for (const conversation of conversationsByProject[project.id] || []) {
        const profileName = runtimeProfileForConversation(conversation, selectedProfile);
        const key = `project:${project.id}:${conversation.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          conversation,
          profileName,
          sourceLabel: `${project.name} / ${profileName}`,
          pinKey: projectConversationPinKey(project.id, conversation.id),
          select: () => onSelectProjectConversation(project.id, profileName, conversation.id),
        });
      }
    }

    for (const conversation of unprojectedConversations) {
      const profileName = runtimeProfileForConversation(conversation, selectedProfile);
      const key = `chat:${profileName}:${conversation.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        conversation,
        profileName,
        sourceLabel: `Sessions / ${profileName}`,
        pinKey: unprojectedConversationPinKey(profileName, conversation.id),
        select: () => onSelectConversation(profileName, conversation.id),
      });
    }

    for (const profile of profiles) {
      const profileConversations =
        profile.name === selectedProfile
          ? conversations
          : conversationsByProfile[profile.name] || [];

      for (const conversation of profileConversations) {
        const key = `agent:${profile.name}:${conversation.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          conversation,
          profileName: profile.name,
          sourceLabel: profile.name,
          pinKey: agentConversationPinKey(profile.name, conversation.id),
          select: () => onSelectConversation(profile.name, conversation.id),
        });
      }
    }

    return items.sort(
      (left, right) =>
        conversationMillis(right.conversation.lastActiveAt) -
        conversationMillis(left.conversation.lastActiveAt),
    );
  }, [
    conversations,
    conversationsByProfile,
    conversationsByProject,
    onSelectConversation,
    onSelectProjectConversation,
    profiles,
    projects,
    selectedProfile,
    unprojectedConversations,
  ]);

  const filteredConversationSearchItems = useMemo(() => {
    const query = conversationSearchQuery.trim().toLowerCase();
    const source = query
      ? conversationSearchItems.filter(({ conversation, profileName, sourceLabel }) =>
          `${conversation.title} ${profileName} ${sourceLabel} ${conversation.id}`.toLowerCase().includes(query),
        )
      : conversationSearchItems;

    return source.slice(0, 9);
  }, [conversationSearchItems, conversationSearchQuery]);

  const pinnedConversationItems = useMemo(() => {
    const items = conversationSearchItems.filter(({ pinKey }) =>
      Boolean(pinnedConversations[pinKey]),
    );
    return items.sort(
      (left, right) =>
        conversationMillis(right.conversation.lastActiveAt) -
        conversationMillis(left.conversation.lastActiveAt),
    );
  }, [conversationSearchItems, pinnedConversations]);

  useEffect(() => {
    if (agentsSectionCollapsed) return;
    for (const profile of profiles) {
      if (collapsedSessionProfiles[profile.name]) continue;
      if (conversationsLoadedByProfile[profile.name]) continue;
      if (conversationsLoadingByProfile[profile.name]) continue;
      onRefreshConversations(profile.name);
    }
  }, [
    agentsSectionCollapsed,
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
    if (!projectMenu) return undefined;

    const closeMenu = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".project-menu-wrap, .profile-context-menu")) return;
      setProjectMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenu(null);
    };
    const closeOnLayoutChange = () => {
      setProjectMenu(null);
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
  }, [projectMenu]);

  useEffect(() => {
    if (!conversationMenu) return undefined;
    setConfirmDeleteConversationKey("");

    const closeMenu = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".conversation-context-menu, .sidebar-session-row")) return;
      setConversationMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConversationMenu(null);
    };
    const closeOnLayoutChange = () => {
      setConversationMenu(null);
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
  }, [conversationMenu]);

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
    onRefreshProjectConversations,
    projectConversationsLoaded,
    projectConversationsLoading,
    projects,
    profiles,
    selectedProfile,
  ]);

  const shellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--workspace-left": `${sidebarCollapsed ? 0 : sidebarWidth}px`,
  } as CSSProperties;

  const shellClassName = [
    "app-shell",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    sidebarResizing ? "sidebar-resizing" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={shellClassName} style={shellStyle}>
      <button
        type="button"
        className="sidebar-toggle"
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!sidebarCollapsed}
        aria-keyshortcuts="Meta+B"
        title="Toggle sidebar (⌘B)"
        onClick={() => setSidebarCollapsedWithTransition((current) => !current)}
      >
        {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
      <aside className="sidebar">
        <div className="window-drag-zone" data-tauri-drag-region />
        <div className="brand-block">
          <div className="brand-mark">
            <img src={irisSidebarIcon} alt="" draggable={false} />
          </div>
          <div>
            <p className="brand-name">Iris</p>
            <p className="brand-status">
              <span className={connected ? "status-dot connected" : "status-dot"} />
              {connected ? "Session route online" : "Route offline"}
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
                  aria-label={isNewChatAction ? "Start new session" : item.label}
                  aria-keyshortcuts={isNewChatAction ? "Meta+N" : undefined}
                  title={isNewChatAction ? "Start new session" : item.label}
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
                    aria-label="Search sessions"
                    aria-keyshortcuts="Meta+G"
                    title="Search sessions"
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

        <div className="sidebar-scroll-region">
          {pinnedConversationItems.length ? (
            <div className="sidebar-section pinned-tree">
              <div className="profile-tree-header">
                <p className="sidebar-label">Pinned</p>
              </div>
              <div className="pinned-list">
                {pinnedConversationItems.map((item) =>
                  renderConversationRow(item.profileName, item.conversation, {
                    pinnedSection: true,
                    rightLabel: timeLabel(item.conversation.lastActiveAt),
                    pinKey: item.pinKey,
                    onSelect: item.select,
                  }),
                )}
              </div>
            </div>
          ) : null}

          <div className="sidebar-section profile-tree projects-tree">
            <div className="profile-tree-header">
              {renderSidebarSectionToggle("projects", "Projects", projectsSectionCollapsed)}
              <div className="profile-tree-actions sidebar-section-actions">
                <button
                  type="button"
                  className="sidebar-icon-button"
                  onClick={onRefreshProjects}
                  title="Refresh projects"
                >
                  <RefreshCcw size={13} />
                </button>
                <button
                  type="button"
                  className="sidebar-icon-button"
                  onClick={openProjectCreateDialog}
                  aria-label="Create project"
                  title="Create project"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
            {!projectsSectionCollapsed ? (
              <div className="profile-list" id="sidebar-projects-section">
                {projects.length ? (
                  projects.map((project) => renderProjectNode(project))
                ) : (
                  <div className="history-empty compact">
                    {projectErrors.list ? projectErrors.list : "No projects yet."}
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="sidebar-section profile-tree chats-tree">
            <div className="profile-tree-header">
              {renderSidebarSectionToggle("chats", "Sessions", chatsSectionCollapsed)}
            </div>
            {!chatsSectionCollapsed ? (
              <div className="profile-list flat-chat-list" id="sidebar-chats-section">
                {unpinnedScopedConversations(
                  unprojectedConversations,
                  (conversation) =>
                    unprojectedConversationPinKey(runtimeProfileForConversation(conversation, selectedProfile), conversation.id),
                  pinnedConversations,
                ).length ? (
                  unpinnedScopedConversations(
                    unprojectedConversations,
                    (conversation) =>
                      unprojectedConversationPinKey(runtimeProfileForConversation(conversation, selectedProfile), conversation.id),
                    pinnedConversations,
                  ).map((conversation) => {
                    const profileName = runtimeProfileForConversation(conversation, selectedProfile);
                    return renderConversationRow(profileName, conversation, {
                      pinKey: unprojectedConversationPinKey(profileName, conversation.id),
                      selected: !selectedProjectId && profileName === selectedProfile && conversation.id === selectedConversationId,
                      keySuffix: "unprojected",
                    });
                  })
                ) : (
                  <div className="history-empty compact">No unprojected sessions yet.</div>
                )}
              </div>
            ) : null}
          </div>

          <div className="sidebar-section profile-tree">
            <div className="profile-tree-header">
              {renderSidebarSectionToggle("agents", "Agents", agentsSectionCollapsed)}
              <div className="profile-tree-actions sidebar-section-actions">
                <button
                  type="button"
                  className="sidebar-icon-button"
                  onClick={() => onRefreshConversations(selectedProfile)}
                  disabled={conversationsLoading}
                  title="Refresh sessions"
                >
                  <RefreshCcw size={13} className={conversationsLoading ? "spin" : ""} />
                </button>
                <button
                  type="button"
                  className="sidebar-icon-button"
                  onClick={() => openProfileCreateDialog()}
                  aria-label="Create agent"
                  title="Create agent"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
            {!agentsSectionCollapsed ? (
              <div className="profile-list" id="sidebar-agents-section">
                {profiles.map((profile) => {
                  const selected = profile.name === selectedProfile;
                  const collapsed = Boolean(collapsedSessionProfiles[profile.name]);
                  const profileConversations = selected
                    ? conversations
                    : conversationsByProfile[profile.name] || [];
                  const visibleProfileConversations = unpinnedProfileConversations(
                    profile.name,
                    profileConversations,
                    pinnedConversations,
                  );
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
                      visibleProfileConversations.length > 0);
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
                            title={`Start new session in ${profile.name}`}
                            aria-label={`Start new session in ${profile.name}`}
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
                          {visibleProfileConversations.length ? (
                            visibleProfileConversations.map((conversation) =>
                              renderConversationRow(profile.name, conversation, {
                                pinKey: agentConversationPinKey(profile.name, conversation.id),
                                selected: profile.name === selectedProfile && !selectedProjectId && conversation.id === selectedConversationId,
                                keySuffix: "profile",
                              }),
                            )
                          ) : (
                            <div className="history-empty compact">
                              {profileLoading ? "Loading sessions..." : "No sessions yet."}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        <button className="sidebar-refresh" onClick={onRefresh} disabled={isRefreshing} title="Refresh connection">
          <RefreshCcw size={15} className={isRefreshing ? "spin" : ""} />
          <span>Refresh connection</span>
        </button>
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={startSidebarResize}
        />
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
      {projectMenu ? renderProjectMenu() : null}
      {conversationMenu ? renderConversationMenu() : null}
      {profileDialog ? renderProfileDialog() : null}
      {projectDialog ? renderProjectDialog() : null}
      {conversationDialog ? renderConversationDialog() : null}
    </div>
  );

  function renderProjectNode(project: IrisProject) {
    const collapsed = Boolean(collapsedProjects[project.id]);
    const projectConversations = conversationsByProject[project.id] || [];
    const visibleProjectConversations = unpinnedScopedConversations(
      projectConversations,
      (conversation) => projectConversationPinKey(project.id, conversation.id),
      pinnedConversations,
    );
    const projectLoading = Boolean(projectConversationsLoading[project.id]);
    const projectError = projectErrors[project.id] || null;
    const showSessionBranch =
      !collapsed &&
      (Boolean(projectError) ||
        projectLoading ||
        !projectConversationsLoaded[project.id] ||
        visibleProjectConversations.length > 0);
    const ProjectFolderIcon = collapsed ? Folder : FolderOpen;
    const defaultAgent = projectAgents.find((agent) => agent.id === project.defaultAgentId);
    const profileName = defaultAgent?.runtimeProfile || selectedProfile;

    return (
      <div key={project.id} className="profile-node project-node">
        <div
          className="profile-node-row"
          onContextMenu={(event) => {
            event.preventDefault();
            openProjectMenu(project.id, event.clientX, event.clientY);
          }}
        >
          <button
            type="button"
            className="profile-node-button"
            aria-expanded={!collapsed}
            onClick={() => {
              const willExpand = collapsed;
              onToggleProjectCollapsed(project.id);
              if (
                willExpand &&
                !projectConversationsLoaded[project.id] &&
                !projectConversationsLoading[project.id]
              ) {
                onRefreshProjectConversations(project.id);
              }
            }}
          >
            <ProjectFolderIcon size={16} />
            <span>{project.name}</span>
          </button>
          <div className="profile-row-actions">
            <div className="project-menu-wrap">
              <button
                type="button"
                className="profile-row-action profile-menu-trigger"
                title={`More actions for ${project.name}`}
                aria-label={`More actions for ${project.name}`}
                aria-haspopup="menu"
                aria-expanded={projectMenu?.projectId === project.id}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleProjectMenu(project.id, event.currentTarget);
                }}
              >
                <Ellipsis size={17} />
              </button>
            </div>
            <button
              type="button"
              className="profile-row-action profile-new-chat-action"
              title={`Start new session in ${project.name}`}
              aria-label={`Start new session in ${project.name}`}
              onClick={(event) => {
                event.stopPropagation();
                if (collapsed) onToggleProjectCollapsed(project.id);
                onNewConversation(profileName, project.id);
              }}
            >
              <SquarePen size={16} />
            </button>
          </div>
        </div>
        {showSessionBranch ? (
          <div className="session-branch">
            {projectError ? <div className="history-notice">{projectError}</div> : null}
            {visibleProjectConversations.length ? (
              visibleProjectConversations.map((conversation) => {
                const conversationProfileName = runtimeProfileForConversation(conversation, profileName);
                return renderConversationRow(conversationProfileName, conversation, {
                  pinKey: projectConversationPinKey(project.id, conversation.id),
                  selected: selectedProjectId === project.id && conversation.id === selectedConversationId,
                  onSelect: () => onSelectProjectConversation(project.id, conversationProfileName, conversation.id),
                  keySuffix: `project-${project.id}`,
                });
              })
            ) : (
              <div className="history-empty compact">
                {projectLoading ? "Loading sessions..." : "No sessions yet."}
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  function renderConversationRow(
    profileName: string,
    conversation: HermesConversation,
    options: {
      pinnedSection?: boolean;
      rightLabel?: string;
      pinKey?: string;
      selected?: boolean;
      onSelect?: () => void;
      keySuffix?: string;
    } = {},
  ) {
    const running = activeConversationIds.includes(conversation.id);
    const selected = options.selected ?? (profileName === selectedProfile && conversation.id === selectedConversationId);
    const unread = !selected && !running && conversationReadState(conversationReadStates, conversation) === "unread";
    const pinKey = options.pinKey || agentConversationPinKey(profileName, conversation.id);
    const pinned = isConversationPinned(pinKey);
    const rightLabel = options.rightLabel || timeLabel(conversation.lastActiveAt);
    const rowClassName = [
      "sidebar-session-row",
      selected ? "active" : "",
      running ? "running" : "",
      pinned ? "pinned" : "",
      options.pinnedSection ? "pinned-section-row" : "",
    ].filter(Boolean).join(" ");

    return (
      <div
        key={`${pinKey}:${options.keySuffix || (options.pinnedSection ? "pinned" : "tree")}`}
        className={rowClassName}
        onContextMenu={(event) => {
          event.preventDefault();
          openConversationMenu(profileName, conversation, pinKey, event.clientX, event.clientY);
        }}
      >
        <button
          type="button"
          className="sidebar-session-pin"
          aria-label={pinned ? `Unpin ${conversation.title}` : `Pin ${conversation.title}`}
          title={pinned ? "Unpin session" : "Pin session"}
          onClick={(event) => {
            event.stopPropagation();
            toggleConversationPinned(pinKey);
          }}
        >
          <Pin size={14} />
        </button>
        <button
          type="button"
          className="sidebar-session"
          onClick={options.onSelect || (() => onSelectConversation(profileName, conversation.id))}
        >
          <span>{conversation.title}</span>
          <em
            className={[
              "sidebar-session-status",
              running ? "streaming" : "",
              unread ? "unread" : "",
            ].filter(Boolean).join(" ")}
            aria-label={running ? "Streaming response" : unread ? "Unread response" : undefined}
          >
            {running ? <i aria-hidden="true" /> : unread ? <i aria-hidden="true" /> : rightLabel}
          </em>
        </button>
      </div>
    );
  }

  function openConversationSearch() {
    for (const project of projects) {
      if (projectConversationsLoaded[project.id]) continue;
      if (projectConversationsLoading[project.id]) continue;
      onRefreshProjectConversations(project.id);
    }
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

  function setSidebarCollapsedWithTransition(next: boolean | ((current: boolean) => boolean)) {
    const current = sidebarCollapsedRef.current;
    const resolved = typeof next === "function" ? next(current) : next;
    if (resolved === current) return;

    sidebarCollapsedRef.current = resolved;
    setSidebarCollapsed(resolved);
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSidebarResizing(true);
    const startX = event.clientX;
    const startWidth = sidebarCollapsedRef.current ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clamp(startWidth + moveEvent.clientX - startX, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAX_WIDTH);
      if (nextWidth < SIDEBAR_STANDARD_WIDTH) {
        setSidebarCollapsedWithTransition(true);
        return;
      }

      setSidebarWidth(nextWidth);
      setSidebarCollapsedWithTransition(false);
    };
    const endResize = () => {
      setSidebarResizing(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endResize, { once: true });
    window.addEventListener("pointercancel", endResize, { once: true });
  }

  function selectConversationSearchItem(item: ConversationSearchItem) {
    closeConversationSearch();
    expandSessions(item.profileName);
    item.select();
  }

  function renderConversationSearch() {
    const heading = conversationSearchQuery.trim() ? "Matching sessions" : "Recent sessions";
    const loadingAnyConversation = Object.values(conversationsLoadingByProfile).some(Boolean);

    return (
      <div className="conversation-search-scrim" role="presentation" onMouseDown={closeConversationSearch}>
        <section
          className="conversation-search-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Search sessions"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="conversation-search-input-wrap">
            <Search size={18} />
            <input
              ref={conversationSearchInputRef}
              value={conversationSearchQuery}
              placeholder="Search sessions"
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
              {loadingAnyConversation && !conversationSearchItems.length ? "Loading sessions" : heading}
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
                  <small>{item.sourceLabel}</small>
                  <kbd>{`⌘${index + 1}`}</kbd>
                </button>
              ))
            ) : (
              <p className="conversation-search-empty">
                {loadingAnyConversation ? "Loading sessions..." : "No matching sessions."}
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

  function toggleSidebarSection(section: SidebarSectionId) {
    setCollapsedSidebarSections((current) => {
      const next = { ...current, [section]: !current[section] };
      saveCollapsedSidebarSections(next);
      return next;
    });
  }

  function renderSidebarSectionToggle(section: SidebarSectionId, label: string, collapsed: boolean) {
    const SectionIcon = collapsed ? ChevronRight : ChevronDown;
    return (
      <button
        type="button"
        className="sidebar-section-toggle"
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${label.toLowerCase()} section`}
        aria-expanded={!collapsed}
        aria-controls={`sidebar-${section}-section`}
        title={`${collapsed ? "Expand" : "Collapse"} ${label.toLowerCase()}`}
        onClick={() => toggleSidebarSection(section)}
      >
        <span className="sidebar-label">{label}</span>
        <SectionIcon className="sidebar-section-chevron" size={13} />
      </button>
    );
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

  function openProjectCreateDialog() {
    setProjectActionError("");
    setProjectMenu(null);
    setProjectDialog({
      action: "create",
      name: nextProjectName("new-project", projects),
      defaultAgentId: projectAgents[0]?.id || "",
      systemPrompt: "",
    });
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

  function toggleProjectMenu(projectId: string, trigger: HTMLElement) {
    setProjectMenu((current) => {
      if (current?.projectId === projectId) return null;
      const rect = trigger.getBoundingClientRect();
      const menuWidth = 166;
      const menuHeight = 44;
      const left = clamp(rect.right - menuWidth, 8, window.innerWidth - menuWidth - 8);
      const below = rect.bottom + 6;
      const top = below + menuHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - menuHeight - 6)
        : below;
      return { projectId, top, left };
    });
  }

  function openProjectMenu(projectId: string, clientX: number, clientY: number) {
    const menuWidth = 166;
    const menuHeight = 44;
    setProjectMenu({
      projectId,
      left: clamp(clientX, 8, window.innerWidth - menuWidth - 8),
      top: clamp(clientY, 8, window.innerHeight - menuHeight - 8),
    });
  }

  function openConversationMenu(
    profileName: string,
    conversation: HermesConversation,
    pinKey: string,
    clientX: number,
    clientY: number,
  ) {
    const menuWidth = 174;
    const menuHeight = 112;
    setConversationMenu({
      profileName,
      conversation,
      pinKey,
      left: clamp(clientX, 8, window.innerWidth - menuWidth - 8),
      top: clamp(clientY, 8, window.innerHeight - menuHeight - 8),
    });
  }

  function isConversationPinned(pinKey: string) {
    return Boolean(pinnedConversations[pinKey]);
  }

  function toggleConversationPinned(pinKey: string) {
    setPinnedConversations((current) => {
      const next = { ...current };
      if (next[pinKey]) {
        delete next[pinKey];
      } else {
        next[pinKey] = true;
      }
      savePinnedConversations(next);
      return next;
    });
  }

  function removePinnedConversation(conversationId: string, pinKey: string) {
    setPinnedConversations((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (key === pinKey || key.endsWith(`:${conversationId}`)) {
          delete next[key];
        }
      }
      savePinnedConversations(next);
      return next;
    });
  }

  function openConversationRenameDialog(profileName: string, conversation: HermesConversation) {
    setConversationActionError("");
    setConversationDialog({ profileName, conversation, name: conversation.title });
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

  function renderProjectMenu() {
    if (!projectMenu) return null;
    const project = projects.find((item) => item.id === projectMenu.projectId);
    if (!project) return null;

    return (
      <div
        className="profile-context-menu"
        role="menu"
        style={{ top: projectMenu.top, left: projectMenu.left }}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setProjectMenu(null);
            setProjectActionError("");
            setProjectDialog({
              action: "edit",
              projectId: project.id,
              name: project.name,
              defaultAgentId: project.defaultAgentId,
              systemPrompt: project.systemPrompt,
            });
          }}
        >
          <Pencil size={14} />
          Edit
        </button>
      </div>
    );
  }

  function renderConversationMenu() {
    if (!conversationMenu) return null;
    const pinned = isConversationPinned(conversationMenu.pinKey);
    const deleteArmed = confirmDeleteConversationKey === conversationMenu.pinKey;
    const deleteDisabled =
      conversationActionBusy || activeConversationIds.includes(conversationMenu.conversation.id);

    return (
      <div
        className="profile-context-menu conversation-context-menu"
        role="menu"
        style={{ top: conversationMenu.top, left: conversationMenu.left }}
        onMouseLeave={resetConfirmDeleteConversation}
        onPointerLeave={resetConfirmDeleteConversation}
      >
        <button
          type="button"
          role="menuitem"
          onMouseEnter={resetConfirmDeleteConversation}
          onPointerEnter={resetConfirmDeleteConversation}
          onClick={() => {
            toggleConversationPinned(conversationMenu.pinKey);
            setConversationMenu(null);
          }}
        >
          <Pin size={14} />
          {pinned ? "Unpin" : "Pin"}
        </button>
        <button
          type="button"
          role="menuitem"
          onMouseEnter={resetConfirmDeleteConversation}
          onPointerEnter={resetConfirmDeleteConversation}
          onClick={() => {
            const { profileName, conversation } = conversationMenu;
            setConversationMenu(null);
            openConversationRenameDialog(profileName, conversation);
          }}
        >
          <Pencil size={14} />
          Rename
        </button>
        <button
          type="button"
          role="menuitem"
          className={deleteArmed ? "danger-menu-item confirm-menu-item" : "danger-menu-item"}
          disabled={deleteDisabled}
          title={activeConversationIds.includes(conversationMenu.conversation.id) ? "Wait for the active response to finish before deleting" : undefined}
          onMouseLeave={resetConfirmDeleteConversation}
          onPointerLeave={resetConfirmDeleteConversation}
          onClick={() => {
            if (deleteDisabled) return;
            if (!deleteArmed) {
              setConfirmDeleteConversationKey(conversationMenu.pinKey);
              return;
            }
            const { profileName, conversation, pinKey } = conversationMenu;
            void runConversationDelete(profileName, conversation.id, pinKey);
          }}
        >
          <Trash2 size={14} />
          {conversationActionBusy ? "Deleting..." : deleteArmed ? "Confirm delete" : "Delete"}
        </button>
      </div>
    );
  }

  function closeProfileDialog() {
    if (profileActionBusy) return;
    setProfileDialog(null);
    setProfileActionError("");
  }

  function closeProjectDialog() {
    if (projectActionBusy) return;
    setProjectDialog(null);
    setProjectActionError("");
  }

  function closeConversationDialog() {
    if (conversationActionBusy) return;
    setConversationDialog(null);
    setConversationActionError("");
  }

  function resetConfirmDeleteConversation() {
    setConfirmDeleteConversationKey("");
  }

  async function submitConversationDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversationDialog || conversationActionBusy) return;

    const name = conversationDialog.name.trim();
    if (!name) {
      setConversationActionError("Enter a session name.");
      return;
    }

    setConversationActionBusy(true);
    setConversationActionError("");
    const message = await onRenameConversation(
      conversationDialog.profileName,
      conversationDialog.conversation.id,
      name,
    );
    setConversationActionBusy(false);

    if (isConversationActionFailure(message)) {
      setConversationActionError(message);
      return;
    }
    setConversationDialog(null);
  }

  async function runConversationDelete(profileName: string, conversationId: string, pinKey: string) {
    setConversationActionBusy(true);
    setConversationActionError("");
    const message = await onDeleteConversation(profileName, conversationId);
    setConversationActionBusy(false);
    if (isConversationActionFailure(message)) {
      setConversationActionError(message);
      setConfirmDeleteConversationKey("");
      return;
    }
    removePinnedConversation(conversationId, pinKey);
    setConfirmDeleteConversationKey("");
    setConversationMenu(null);
  }

  async function submitProjectDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectDialog || projectActionBusy) return;

    const name = projectDialog.name.trim();
    if (!name) {
      setProjectActionError("Enter a project name.");
      return;
    }
    if (!projectDialog.defaultAgentId) {
      setProjectActionError("Choose a default agent.");
      return;
    }

    setProjectActionBusy(true);
    setProjectActionError("");
    try {
      if (projectDialog.action === "create") {
        await onCreateProject({
          name,
          defaultAgentId: projectDialog.defaultAgentId,
          systemPrompt: projectDialog.systemPrompt,
        });
      } else {
        await onUpdateProject(projectDialog.projectId, {
          name,
          defaultAgentId: projectDialog.defaultAgentId,
          systemPrompt: projectDialog.systemPrompt,
        });
      }
      setProjectDialog(null);
    } catch (error) {
      setProjectActionError(error instanceof Error ? error.message : "Could not save project.");
    } finally {
      setProjectActionBusy(false);
    }
  }

  function renderProjectDialog() {
    const dialog = projectDialog;
    if (!dialog) return null;
    const isCreate = dialog.action === "create";
    const submitDisabled =
      projectActionBusy ||
      !dialog.name.trim() ||
      !dialog.defaultAgentId;
    const agentOptions = projectAgentOptions(projectAgents, dialog.defaultAgentId);

    return (
      <div className="profile-action-modal project-action-modal" role="dialog" aria-modal="true" aria-labelledby="project-action-title">
        <form onSubmit={submitProjectDialog}>
          <div>
            <p className="eyebrow">{isCreate ? "Project management" : "Project"}</p>
            <h2 id="project-action-title">{isCreate ? "New project" : "Edit project"}</h2>
          </div>
          <label>
            <span>Project name</span>
            <input
              autoFocus
              value={dialog.name}
              placeholder="new-project"
              onChange={(event) => setProjectDialog({ ...dialog, name: event.target.value })}
            />
          </label>
          <label>
            <span>Default agent</span>
            <select
              value={dialog.defaultAgentId}
              onChange={(event) => setProjectDialog({ ...dialog, defaultAgentId: event.target.value })}
            >
              {agentOptions.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName || agent.runtimeProfile || agent.id}
                </option>
              ))}
            </select>
          </label>
          <div className="project-prompt-editor">
            <span>System prompt</span>
            <CodeEditor
              value={dialog.systemPrompt}
              onChange={(value) => setProjectDialog({ ...dialog, systemPrompt: value })}
              metadata={[
                { label: "lines", value: `${dialog.systemPrompt.split("\n").length} lines` },
                { label: "scope", value: "project only" },
              ]}
            />
          </div>
          {projectActionError ? <p className="profile-action-error">{projectActionError}</p> : null}
          <div className="profile-action-modal-actions">
            <button type="button" className="small-button settings-button" onClick={closeProjectDialog}>
              Cancel
            </button>
            <button type="submit" className="small-button settings-button" disabled={submitDisabled}>
              {projectActionBusy ? "Working..." : isCreate ? "Create" : "Save"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  function renderConversationDialog() {
    const dialog = conversationDialog;
    if (!dialog) return null;
    const inputValue = dialog.name;
    const submitDisabled = conversationActionBusy || !inputValue.trim();

    return (
      <div className="profile-action-modal" role="dialog" aria-modal="true" aria-labelledby="conversation-action-title">
        <form onSubmit={submitConversationDialog}>
          <div>
            <p className="eyebrow">Session</p>
            <h2 id="conversation-action-title">Rename session</h2>
          </div>
          <label>
            <span>Session name</span>
            <input
              autoFocus
              value={inputValue}
              placeholder="Session name"
              onChange={(event) => setConversationDialog({ ...dialog, name: event.target.value })}
            />
          </label>
          {conversationActionError ? <p className="profile-action-error">{conversationActionError}</p> : null}
          <div className="profile-action-modal-actions">
            <button type="button" className="small-button settings-button" onClick={closeConversationDialog}>
              Cancel
            </button>
            <button type="submit" className="small-button settings-button" disabled={submitDisabled}>
              {conversationActionBusy ? "Working..." : "Rename"}
            </button>
          </div>
        </form>
      </div>
    );
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

function nextProjectName(base: string, projects: IrisProject[]) {
  const names = new Set(projects.map((project) => project.name));
  if (!names.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function projectAgentOptions(agents: AgentUICoreAgent[], selectedAgentId: string) {
  if (!selectedAgentId || agents.some((agent) => agent.id === selectedAgentId)) return agents;
  return [
    {
      id: selectedAgentId,
      runtimeId: "",
      runtimeKind: "",
      displayName: selectedAgentId,
      runtimeProfile: selectedAgentId,
      isDefault: false,
    },
    ...agents,
  ];
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

function isProfileActionFailure(message: string) {
  return /\b(error|failed|cannot|already exists|does not exist|enter|invalid)\b/i.test(message);
}

function isConversationActionFailure(message: string) {
  return /\b(error|failed|cannot|could not|does not exist|not found|not allowed|enter|invalid|legacy|http|urlopen|connection refused|refused)\b/i.test(message);
}

function loadCollapsedSessionProfiles() {
  const parsed = loadJsonValue<Record<string, unknown>>(storageKeys.collapsedSessionProfiles, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, Boolean(value)]),
      )
    : {};
}

function loadCollapsedSidebarSections(): Record<SidebarSectionId, boolean> {
  const parsed = loadJsonValue<Record<string, unknown>>(storageKeys.collapsedSidebarSections, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { projects: false, chats: false, agents: false };
  return {
    projects: Boolean(parsed.projects),
    chats: Boolean(parsed.chats),
    agents: Boolean(parsed.agents),
  };
}

function loadPinnedConversations() {
  const parsed = loadJsonValue<Record<string, unknown>>(storageKeys.pinnedConversations, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.fromEntries(
        Object.entries(parsed)
          .filter(([key]) => key.includes(":"))
          .map(([key, value]) => [key, Boolean(value)]),
      )
    : {};
}

function savePinnedConversations(value: Record<string, boolean>) {
  saveJsonValue(storageKeys.pinnedConversations, value);
}

function agentConversationPinKey(profileName: string, conversationId: string) {
  return `agent:${profileName}:${conversationId}`;
}

function projectConversationPinKey(projectId: string, conversationId: string) {
  return `project:${projectId}:${conversationId}`;
}

function unprojectedConversationPinKey(profileName: string, conversationId: string) {
  return `chat:${profileName}:${conversationId}`;
}

function legacyConversationPinKey(profileName: string, conversationId: string) {
  return `${profileName}:${conversationId}`;
}

export function unpinnedProfileConversations<T extends { id: string }>(
  profileName: string,
  conversations: T[],
  pinnedConversations: Record<string, boolean>,
) {
  return conversations.filter((conversation) =>
    !pinnedConversations[agentConversationPinKey(profileName, conversation.id)] &&
    !pinnedConversations[legacyConversationPinKey(profileName, conversation.id)],
  );
}

function unpinnedScopedConversations<T extends { id: string }>(
  conversations: T[],
  pinKey: (conversation: T) => string,
  pinnedConversations: Record<string, boolean>,
) {
  return conversations.filter((conversation) => !pinnedConversations[pinKey(conversation)]);
}

function runtimeProfileForConversation(conversation: HermesConversation, fallback: string) {
  const origin = conversation.origin || {};
  const metadata = conversation.metadata || {};
  return String(origin.runtimeProfile || metadata.runtimeProfile || fallback || "default");
}

function conversationReadState(
  states: Record<string, "read" | "unread">,
  conversation: HermesConversation,
) {
  return states[conversation.id] || conversation.readState?.state || "read";
}

function saveCollapsedSessionProfiles(value: Record<string, boolean>) {
  saveJsonValue(storageKeys.collapsedSessionProfiles, value);
}

function saveCollapsedSidebarSections(value: Record<SidebarSectionId, boolean>) {
  saveJsonValue(storageKeys.collapsedSidebarSections, value);
}

function widthBandForWindow() {
  if (typeof window === "undefined") return "regular";
  return window.innerWidth <= SIDEBAR_AUTO_COLLAPSE_WIDTH ? "compact" : "regular";
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
