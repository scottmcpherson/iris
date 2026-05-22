import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  AlertCircle,
  Check,
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
  Plus,
  RefreshCcw,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  Trash2,
} from "lucide-react";
import irisSidebarIcon from "../assets/iris-sidebar-icon-borderless.png";
import { navItems, viewTitle } from "../app/navigation";
import { loadJsonValue, saveJsonValue, storageKeys } from "../app/storage";
import type { ProfileActionHandler, View } from "../app/types";
import { offlineProfile } from "../app/offlineProfile";
import type { IrisCoreAgent, IrisProject } from "../lib/irisCore";
import type { HermesSession, HermesProfile, HermesStatus } from "../types/hermes";
import {
  SessionActionDialog,
  ProfileActionDialog,
  ProjectActionDialog,
  type SessionDialog,
  type ProfileDialog,
  type ProjectDialog,
} from "./AppShellDialogs";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../shared/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../shared/ui/dropdown-menu";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../shared/ui/command";
import { Button } from "../shared/ui/button";

export const SIDEBAR_AUTO_COLLAPSE_WIDTH = 820;
const SIDEBAR_STANDARD_WIDTH = 252;
const SIDEBAR_COLLAPSED_WIDTH = 0;
const SIDEBAR_MAX_WIDTH = 440;

export function sidebarConnectionStatusLabel(
  connected: boolean,
  status: HermesStatus | null,
) {
  const connectionLabel = sidebarConnectionName(status);
  if (!connected) return `${connectionLabel} · Core offline`;
  return connectionLabel;
}

function sidebarConnectionName(status: HermesStatus | null) {
  const connectionName = status?.activeConnectionName?.trim();
  if (connectionName) return connectionName;
  if (status?.connectionMode === "ssh") return "SSH";
  return "Local";
}

type SidebarWidthBand = "compact" | "regular";

type SessionSearchItem = {
  session: HermesSession;
  profileName: string;
  sourceLabel: string;
  pinKey: string;
  select: () => void;
};

type SidebarOrganization = "projects" | "agents";

type SidebarSectionId = "pinned" | "projects" | "chats" | "agents";

type AppShellProps = {
  activeView: View;
  connected: boolean;
  error?: string | null;
  isRefreshing: boolean;
  primaryPane: ReactNode;
  topbarPane?: ReactNode;
  selectedProfile: string;
  status: HermesStatus | null;
  sessions: HermesSession[];
  sessionsByProfile: Record<string, HermesSession[]>;
  sessionReadStates: Record<string, "read" | "unread">;
  projects: IrisProject[];
  projectAgents: IrisCoreAgent[];
  sessionsByProject: Record<string, HermesSession[]>;
  projectSessionsLoading: Record<string, boolean>;
  projectSessionsLoaded: Record<string, boolean>;
  projectErrors: Record<string, string | null>;
  collapsedProjects: Record<string, boolean>;
  unprojectedSessions: HermesSession[];
  sessionsLoadedByProfile: Record<string, boolean>;
  sessionsLoading: boolean;
  sessionsLoadingByProfile: Record<string, boolean>;
  historyError: string | null;
  historyErrorsByProfile: Record<string, string | null>;
  selectedSessionId: string | null;
  selectedProjectId: string;
  activeSessionIds: string[];
  coreApiUrl: string;
  onNewSession: (profileName?: string, projectId?: string) => void;
  onCreateProject: (payload: { name: string; defaultAgentId: string; systemPrompt: string }) => Promise<IrisProject>;
  onUpdateProject: (
    projectId: string,
    payload: { name: string; defaultAgentId: string; systemPrompt: string },
  ) => Promise<IrisProject>;
  onToggleProjectCollapsed: (projectId: string) => void;
  onRefreshProjects: () => void;
  onRefreshProjectSessions: (projectId: string) => void;
  onEditProfile: (profile: string) => void;
  onProfileAction: ProfileActionHandler;
  onRefresh: () => void;
  onRefreshSessions: (profileName?: string) => void;
  onDeleteSession: (profileName: string, sessionId: string) => Promise<string>;
  onRenameSession: (profileName: string, sessionId: string, title: string) => Promise<string>;
  onSelectSession: (profileName: string, sessionId: string) => void;
  onSelectProjectSession: (projectId: string, profileName: string, sessionId: string) => void;
  onSelectProfile: (profile: string) => void;
  onSelectView: (view: View) => void;
  onOpenDiagnostics?: () => void;
};

export function AppShell({
  activeView,
  connected,
  error,
  isRefreshing,
  primaryPane,
  topbarPane,
  selectedProfile,
  status,
  sessions,
  sessionsByProfile,
  sessionReadStates,
  projects,
  projectAgents,
  sessionsByProject,
  projectSessionsLoading,
  projectSessionsLoaded,
  projectErrors,
  collapsedProjects,
  unprojectedSessions,
  sessionsLoadedByProfile,
  sessionsLoading,
  sessionsLoadingByProfile,
  historyError,
  historyErrorsByProfile,
  selectedSessionId,
  selectedProjectId,
  activeSessionIds,
  coreApiUrl,
  onNewSession,
  onCreateProject,
  onUpdateProject,
  onToggleProjectCollapsed,
  onRefreshProjects,
  onRefreshProjectSessions,
  onEditProfile,
  onProfileAction,
  onRefresh,
  onRefreshSessions,
  onDeleteSession,
  onRenameSession,
  onSelectSession,
  onSelectProjectSession,
  onSelectProfile,
  onSelectView,
  onOpenDiagnostics,
}: AppShellProps) {
  const profiles = status?.profiles ?? [offlineProfile];
  const showSelectedSession = activeView === "chat";
  const [sessionContextMenuKey, setSessionContextMenuKey] = useState("");
  const [profileDialog, setProfileDialog] = useState<ProfileDialog | null>(null);
  const [projectDialog, setProjectDialog] = useState<ProjectDialog | null>(null);
  const [sessionDialog, setSessionDialog] = useState<SessionDialog | null>(null);
  const [confirmDeleteSessionKey, setConfirmDeleteSessionKey] = useState("");
  const [profileActionBusy, setProfileActionBusy] = useState(false);
  const [profileActionError, setProfileActionError] = useState("");
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [projectActionError, setProjectActionError] = useState("");
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState("");
  const [pinnedSessions, setPinnedSessions] = useState<Record<string, boolean>>(
    () => loadPinnedSessions(),
  );
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [sidebarOrganization, setSidebarOrganization] = useState<SidebarOrganization>(
    () => loadSidebarOrganization(),
  );
  const sessionSearchInputRef = useRef<HTMLInputElement | null>(null);
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
  const pinnedSectionCollapsed = Boolean(collapsedSidebarSections.pinned);
  const statusDotClassName = [
    "status-dot",
    connected ? "connected" : "",
  ].filter(Boolean).join(" ");

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
      const resizeDecision = sidebarResponsiveResizeDecision({
        previousBand,
        nextBand,
        sidebarCollapsed: sidebarCollapsedRef.current,
        expandedBeforeResponsiveCollapse: expandedBeforeResponsiveCollapseRef.current,
      });

      expandedBeforeResponsiveCollapseRef.current = resizeDecision.expandedBeforeResponsiveCollapse;

      if (resizeDecision.nextCollapsed !== null) {
        setSidebarCollapsedWithTransition(resizeDecision.nextCollapsed);
      }

      sidebarWidthBandRef.current = nextBand;
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const sessionSearchItems = useMemo(
    () =>
      buildSessionSearchItems({
        sessions,
        sessionsByProfile,
        sessionsByProject,
        onSelectSession,
        onSelectProjectSession,
        profiles,
        projects,
        selectedProfile,
        unprojectedSessions,
      }),
    [
      sessions,
      sessionsByProfile,
      sessionsByProject,
      onSelectSession,
      onSelectProjectSession,
      profiles,
      projects,
      selectedProfile,
      unprojectedSessions,
    ],
  );

  const filteredSessionSearchItems = useMemo(() => {
    const query = sessionSearchQuery.trim().toLowerCase();
    const source = query
      ? sessionSearchItems.filter(({ session, profileName, sourceLabel }) =>
          `${session.title} ${profileName} ${sourceLabel} ${session.id}`.toLowerCase().includes(query),
        )
      : sessionSearchItems;

    return source.slice(0, 9);
  }, [sessionSearchItems, sessionSearchQuery]);

  const pinnedSessionItems = useMemo(() => {
    const items = sessionSearchItems
      .map((item) => {
        const pinnedKey = pinnedPinKeyForSessionItem(item, pinnedSessions);
        return pinnedKey ? { ...item, pinKey: pinnedKey } : null;
      })
      .filter((item): item is SessionSearchItem => Boolean(item));
    return items.sort(
      (left, right) =>
        sessionMillis(right.session.lastActiveAt) -
        sessionMillis(left.session.lastActiveAt),
    );
  }, [sessionSearchItems, pinnedSessions]);

  useEffect(() => {
    if (sidebarOrganization !== "agents" || agentsSectionCollapsed) return;
    for (const profile of profiles) {
      if (collapsedSessionProfiles[profile.name]) continue;
      if (sessionsLoadedByProfile[profile.name]) continue;
      if (sessionsLoadingByProfile[profile.name]) continue;
      onRefreshSessions(profile.name);
    }
  }, [
    agentsSectionCollapsed,
    collapsedSessionProfiles,
    sessionsLoadedByProfile,
    sessionsLoadingByProfile,
    onRefreshSessions,
    profiles,
    sidebarOrganization,
  ]);

  useEffect(() => {
    if (!sessionSearchOpen) return undefined;
    const focusTimer = window.setTimeout(() => {
      sessionSearchInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [sessionSearchOpen]);

  useEffect(() => {
    const handleOpenSearch = () => {
      openSessionSearch();
    };
    const handleNewSession = () => {
      startSelectedProfileSession();
    };
    const handleShortcut = (event: KeyboardEvent) => {
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey || event.altKey || event.shiftKey) return;

      if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        openSessionSearch();
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        startSelectedProfileSession();
      }
    };

    window.addEventListener("iris://new-session", handleNewSession);
    window.addEventListener("iris://open-session-search", handleOpenSearch);
    window.addEventListener("keydown", handleShortcut, { capture: true });
    return () => {
      window.removeEventListener("iris://new-session", handleNewSession);
      window.removeEventListener("iris://open-session-search", handleOpenSearch);
      window.removeEventListener("keydown", handleShortcut, { capture: true });
    };
  }, [
    sessionsLoadedByProfile,
    sessionsLoadingByProfile,
    onNewSession,
    onRefreshSessions,
    onRefreshProjectSessions,
    projectSessionsLoaded,
    projectSessionsLoading,
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
      <Button
        type="button"
        variant="ghost"
        className="sidebar-toggle"
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!sidebarCollapsed}
        aria-keyshortcuts="Meta+B"
        title="Toggle sidebar (⌘B)"
        onClick={() => setSidebarCollapsedWithTransition((current) => !current)}
      >
        {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </Button>
      <aside className="sidebar">
        <div className="window-drag-zone" data-tauri-drag-region />
        <div className="flex items-center flex-none gap-3 min-h-11 pt-0 px-2 pb-[18px]">
          <div className="brand-mark">
            <img src={irisSidebarIcon} alt="" draggable={false} />
          </div>
          <div>
            <p className="brand-name">Iris</p>
            {onOpenDiagnostics ? (
              <button
                type="button"
                className="brand-status brand-status-button"
                onClick={onOpenDiagnostics}
                aria-label="Open runtime diagnostics"
                title="Diagnose and recover the runtime"
              >
                <span className={statusDotClassName} />
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{sidebarConnectionStatusLabel(connected, status)}</span>
              </button>
            ) : (
              <p className="brand-status">
                <span className={statusDotClassName} />
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{sidebarConnectionStatusLabel(connected, status)}</span>
              </p>
            )}
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isNewChatAction = item.id === "chat";
            return (
              <Fragment key={item.id}>
                <Button
                  type="button"
                  variant="ghost"
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
                      onNewSession(selectedProfile);
                      return;
                    }
                    onSelectView(item.id);
                  }}
                >
                  <Icon size={17} />
                  <span>{item.label}</span>
                  {isNewChatAction ? <kbd className="nav-shortcut">⌘N</kbd> : null}
                </Button>
                {isNewChatAction ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className={sessionSearchOpen ? "nav-item session-search-nav active" : "nav-item session-search-nav"}
                    aria-label="Search sessions"
                    aria-keyshortcuts="Meta+G"
                    title="Search sessions"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={openSessionSearch}
                  >
                    <Search size={17} />
                    <span>Search</span>
                    <kbd className="nav-shortcut">⌘G</kbd>
                  </Button>
                ) : null}
              </Fragment>
            );
          })}
        </nav>

        <div className="sidebar-scroll-region">
          {pinnedSessionItems.length ? (
            <div className="sidebar-section pinned-tree">
              <div className="profile-tree-header">
                {renderSidebarSectionToggle("pinned", "Pinned", pinnedSectionCollapsed)}
              </div>
              {!pinnedSectionCollapsed ? (
                <div className="pinned-list" id="sidebar-pinned-section">
                  {pinnedSessionItems.map((item) =>
                    renderSessionRow(item.profileName, item.session, {
                      pinnedSection: true,
                      rightLabel: timeLabel(item.session.lastActiveAt),
                      pinKey: item.pinKey,
                      onSelect: item.select,
                    }),
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {sidebarOrganization === "projects" ? (
            <>
              <div className="sidebar-section profile-tree projects-tree">
                <div className="profile-tree-header">
                  {renderSidebarSectionToggle("projects", "Projects", projectsSectionCollapsed)}
                  <div className="profile-tree-actions sidebar-section-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      className="sidebar-icon-button"
                      onClick={onRefreshProjects}
                      title="Refresh projects"
                    >
                      <RefreshCcw size={13} />
                    </Button>
                    {renderSidebarOrganizationButton()}
                    <Button
                      type="button"
                      variant="ghost"
                      className="sidebar-icon-button"
                      onClick={openProjectCreateDialog}
                      aria-label="Create project"
                      title="Create project"
                    >
                      <Plus size={14} />
                    </Button>
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
                    {unpinnedScopedSessions(
                      unprojectedSessions,
                      (session) =>
                        unprojectedSessionPinKey(runtimeProfileForSession(session, selectedProfile), session.id),
                      pinnedSessions,
                    ).length ? (
                      unpinnedScopedSessions(
                        unprojectedSessions,
                        (session) =>
                          unprojectedSessionPinKey(runtimeProfileForSession(session, selectedProfile), session.id),
                        pinnedSessions,
                      ).map((session) => {
                        const profileName = runtimeProfileForSession(session, selectedProfile);
                        return renderSessionRow(profileName, session, {
                          pinKey: unprojectedSessionPinKey(profileName, session.id),
                          selected:
                            showSelectedSession &&
                            !selectedProjectId &&
                            profileName === selectedProfile &&
                            session.id === selectedSessionId,
                          keySuffix: "unprojected",
                        });
                      })
                    ) : (
                      <div className="history-empty compact">No unprojected sessions yet.</div>
                    )}
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="sidebar-section profile-tree">
              <div className="profile-tree-header">
                {renderSidebarSectionToggle("agents", "Agents", agentsSectionCollapsed)}
                <div className="profile-tree-actions sidebar-section-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    className="sidebar-icon-button"
                    onClick={() => onRefreshSessions(selectedProfile)}
                    disabled={sessionsLoading}
                    title="Refresh sessions"
                  >
                    <RefreshCcw size={13} className={sessionsLoading ? "spin" : ""} />
                  </Button>
                  {renderSidebarOrganizationButton()}
                  <Button
                    type="button"
                    variant="ghost"
                    className="sidebar-icon-button"
                    onClick={() => openProfileCreateDialog()}
                    aria-label="Create agent"
                    title="Create agent"
                  >
                    <Plus size={14} />
                  </Button>
                </div>
              </div>
              {!agentsSectionCollapsed ? (
                <div className="profile-list" id="sidebar-agents-section">
                  {profiles.map((profile) => {
                    const selected = profile.name === selectedProfile;
                    const collapsed = Boolean(collapsedSessionProfiles[profile.name]);
                    const profileSessions = selected
                      ? sessions
                      : sessionsByProfile[profile.name] || [];
                    const visibleProfileSessions = unpinnedProfileSessions(
                      profile.name,
                      profileSessions,
                      pinnedSessions,
                    );
                    const profileLoading = selected
                      ? sessionsLoading
                      : Boolean(sessionsLoadingByProfile[profile.name]);
                    const profileError = selected
                      ? historyError
                      : historyErrorsByProfile[profile.name] || null;
                    const showSessionBranch =
                      !collapsed &&
                      (selected ||
                        Boolean(profileError) ||
                        profileLoading ||
                        !sessionsLoadedByProfile[profile.name] ||
                        visibleProfileSessions.length > 0);
                    const ProfileFolderIcon = collapsed ? Folder : FolderOpen;
                    return (
                      <div key={profile.name} className="profile-node">
                        <div className="profile-node-row">
                          <Button
                            type="button"
                            variant="ghost"
                            className="profile-node-button"
                            aria-expanded={!collapsed}
                            onClick={() => {
                              const willExpand = collapsed;
                              toggleSessionsCollapsed(profile.name);
                              if (
                                willExpand &&
                                !sessionsLoadedByProfile[profile.name] &&
                                !sessionsLoadingByProfile[profile.name]
                              ) {
                                onRefreshSessions(profile.name);
                              }
                            }}
                          >
                            <ProfileFolderIcon size={16} />
                            <span>{profile.name}</span>
                          </Button>
                          <div className="flex items-center gap-0.5 pr-0">
                            <DropdownMenu onOpenChange={(open) => {
                              if (open) closeSidebarMenus();
                            }}>
                              <div className="relative flex items-center">
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    className="profile-row-action profile-menu-trigger"
                                    title={`More actions for ${profile.name}`}
                                    aria-label={`More actions for ${profile.name}`}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <Ellipsis size={17} />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" sideOffset={6}>
                                  <DropdownMenuGroup>
                                    <DropdownMenuItem onSelect={() => onEditProfile(profile.name)}>
                                      <Pencil data-icon="inline-start" />
                                      Edit profile
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => openProfileCloneDialog(profile.name)}>
                                      <Copy data-icon="inline-start" />
                                      Duplicate
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      variant="destructive"
                                      disabled={profile.name === "default"}
                                      title={profile.name === "default" ? "The default agent cannot be deleted" : undefined}
                                      onSelect={() => openProfileDeleteDialog(profile.name)}
                                    >
                                      <Trash2 data-icon="inline-start" />
                                      Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuGroup>
                                </DropdownMenuContent>
                              </div>
                            </DropdownMenu>
                            <Button
                              type="button"
                              variant="ghost"
                              className="profile-row-action opacity-[0.76]"
                              title={`Start new session in ${profile.name}`}
                              aria-label={`Start new session in ${profile.name}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (!selected) onSelectProfile(profile.name);
                                expandSessions(profile.name);
                                onNewSession(profile.name);
                              }}
                            >
                              <SquarePen size={16} />
                            </Button>
                          </div>
                        </div>
                        {showSessionBranch ? (
                          <div className="session-branch">
                            {profileError ? <div className="history-notice">{profileError}</div> : null}
                            {visibleProfileSessions.length ? (
                              visibleProfileSessions.map((session) =>
                                renderSessionRow(profile.name, session, {
                                  pinKey: agentSessionPinKey(profile.name, session.id),
                                  selected:
                                    showSelectedSession &&
                                    profile.name === selectedProfile &&
                                    !selectedProjectId &&
                                    session.id === selectedSessionId,
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
          )}
        </div>

        <Button
          type="button"
          variant="ghost"
          className={activeView === "settings" ? "nav-item flex-none mt-3 active" : "nav-item flex-none mt-3"}
          aria-label="Settings"
          onClick={() => onSelectView("settings")}
          title="Settings"
        >
          <Settings size={17} />
          <span>Settings</span>
        </Button>
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
              {activeView === "chat" ? (
                <div className="min-w-0 pointer-events-none">
                  <p>{viewTitle(activeView)}</p>
                  <span>{coreApiUrl}</span>
                </div>
              ) : null}
            </>
          )}
        </header>

        {error ? (
          <div className="connection-banner">
            <AlertCircle size={16} />
            <span>{error}</span>
            <Button size="appSmall" onClick={onRefresh} disabled={isRefreshing}>
              Retry
            </Button>
          </div>
        ) : null}

        <section
          className={[
            "content-grid",
            activeView === "chat" ? "chat-content" : "",
          ].filter(Boolean).join(" ")}
        >
          <div className={activeView === "chat" ? "primary-pane chat-primary-pane" : "primary-pane"}>
            {primaryPane}
          </div>
        </section>
      </main>
      {sessionSearchOpen ? renderSessionSearch() : null}
      {profileDialog ? (
        <ProfileActionDialog
          dialog={profileDialog}
          busy={profileActionBusy}
          error={profileActionError}
          onCancel={closeProfileDialog}
          onChange={setProfileDialog}
          onSubmit={submitProfileDialog}
        />
      ) : null}
      {projectDialog ? (
        <ProjectActionDialog
          dialog={projectDialog}
          busy={projectActionBusy}
          error={projectActionError}
          projectAgents={projectAgents}
          onCancel={closeProjectDialog}
          onChange={setProjectDialog}
          onSubmit={submitProjectDialog}
        />
      ) : null}
      {sessionDialog ? (
        <SessionActionDialog
          dialog={sessionDialog}
          busy={sessionActionBusy}
          error={sessionActionError}
          onCancel={closeSessionDialog}
          onChange={setSessionDialog}
          onSubmit={submitSessionDialog}
        />
      ) : null}
    </div>
  );

  function renderProjectNode(project: IrisProject) {
    const collapsed = Boolean(collapsedProjects[project.id]);
    const projectSessions = sessionsByProject[project.id] || [];
    const visibleProjectSessions = unpinnedScopedSessions(
      projectSessions,
      (session) => projectSessionPinKey(project.id, session.id),
      pinnedSessions,
    );
    const projectLoading = Boolean(projectSessionsLoading[project.id]);
    const projectError = projectErrors[project.id] || null;
    const showSessionBranch =
      !collapsed &&
      (Boolean(projectError) ||
        projectLoading ||
        !projectSessionsLoaded[project.id] ||
        visibleProjectSessions.length > 0);
    const ProjectFolderIcon = collapsed ? Folder : FolderOpen;
    const defaultAgent = projectAgents.find((agent) => agent.id === project.defaultAgentId);
    const profileName = defaultAgent?.runtimeProfile || selectedProfile;

    return (
      <div key={project.id} className="profile-node project-node">
        <ContextMenu onOpenChange={(open) => {
          if (open) closeSidebarMenus();
        }}>
          <ContextMenuTrigger asChild>
            <div className="profile-node-row">
              <Button
                type="button"
                variant="ghost"
                className="profile-node-button"
                aria-expanded={!collapsed}
                onClick={() => {
                  const willExpand = collapsed;
                  onToggleProjectCollapsed(project.id);
                  if (
                    willExpand &&
                    !projectSessionsLoaded[project.id] &&
                    !projectSessionsLoading[project.id]
                  ) {
                    onRefreshProjectSessions(project.id);
                  }
                }}
              >
                <ProjectFolderIcon size={16} />
                <span>{project.name}</span>
              </Button>
              <div className="flex items-center gap-0.5 pr-0">
                <DropdownMenu onOpenChange={(open) => {
                  if (open) closeSidebarMenus();
                }}>
                  <div className="project-menu-wrap">
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="profile-row-action profile-menu-trigger"
                        title={`More actions for ${project.name}`}
                        aria-label={`More actions for ${project.name}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Ellipsis size={17} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={6}>
                      <DropdownMenuGroup>
                        <DropdownMenuItem onSelect={() => openProjectEditDialog(project)}>
                          <Pencil data-icon="inline-start" />
                          Edit
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </div>
                </DropdownMenu>
                <Button
                  type="button"
                  variant="ghost"
                  className="profile-row-action opacity-[0.76]"
                  title={`Start new session in ${project.name}`}
                  aria-label={`Start new session in ${project.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (collapsed) onToggleProjectCollapsed(project.id);
                    onNewSession(profileName, project.id);
                  }}
                >
                  <SquarePen size={16} />
                </Button>
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuGroup>
              <ContextMenuItem onSelect={() => openProjectEditDialog(project)}>
                <Pencil data-icon="inline-start" />
                Edit
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
        {showSessionBranch ? (
          <div className="session-branch">
            {projectError ? <div className="history-notice">{projectError}</div> : null}
            {visibleProjectSessions.length ? (
              visibleProjectSessions.map((session) => {
                const sessionProfileName = runtimeProfileForSession(session, profileName);
                return renderSessionRow(sessionProfileName, session, {
                  pinKey: projectSessionPinKey(project.id, session.id),
                  selected:
                    showSelectedSession &&
                    selectedProjectId === project.id &&
                    session.id === selectedSessionId,
                  onSelect: () => onSelectProjectSession(project.id, sessionProfileName, session.id),
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

  function renderSessionRow(
    profileName: string,
    session: HermesSession,
    options: {
      pinnedSection?: boolean;
      rightLabel?: string;
      pinKey?: string;
      selected?: boolean;
      onSelect?: () => void;
      keySuffix?: string;
    } = {},
  ) {
    const running = activeSessionIds.includes(session.id);
    const selected =
      options.selected ??
      (showSelectedSession && profileName === selectedProfile && session.id === selectedSessionId);
    const unread = !selected && !running && sessionReadState(sessionReadStates, session) === "unread";
    const pinKey = options.pinKey || agentSessionPinKey(profileName, session.id);
    const pinned = isSessionPinned(pinKey);
    const rightLabel = options.rightLabel || timeLabel(session.lastActiveAt);
    const contextTarget = sessionContextMenuKey === pinKey;
    const deleteArmed = confirmDeleteSessionKey === pinKey;
    const deleteDisabled = sessionActionBusy || activeSessionIds.includes(session.id);
    const rowClassName = [
      "sidebar-session-row",
      selected ? "active" : "",
      contextTarget ? "context-target" : "",
      running ? "running" : "",
      pinned ? "pinned" : "",
      options.pinnedSection ? "pinned-section-row" : "",
    ].filter(Boolean).join(" ");

    return (
      <ContextMenu
        key={`${pinKey}:${options.keySuffix || (options.pinnedSection ? "pinned" : "tree")}`}
        onOpenChange={(open) => {
          if (open) {
            closeSidebarMenus();
            setSessionContextMenuKey(pinKey);
            return;
          }
          setSessionContextMenuKey((current) => current === pinKey ? "" : current);
          resetConfirmDeleteSession();
        }}
      >
        <ContextMenuTrigger asChild>
          <div className={rowClassName}>
            <Button
              type="button"
              variant="ghost"
              className="sidebar-session-pin"
              aria-label={pinned ? `Unpin ${session.title}` : `Pin ${session.title}`}
              title={pinned ? "Unpin session" : "Pin session"}
              onClick={(event) => {
                event.stopPropagation();
                toggleSessionPinned(pinKey);
              }}
            >
              <Pin size={14} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="sidebar-session"
              onClick={options.onSelect || (() => onSelectSession(profileName, session.id))}
            >
              <span>{session.title}</span>
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
            </Button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          onMouseLeave={resetConfirmDeleteSession}
          onPointerLeave={resetConfirmDeleteSession}
        >
          <ContextMenuGroup>
            <ContextMenuItem
              onFocus={resetConfirmDeleteSession}
              onPointerEnter={resetConfirmDeleteSession}
              onSelect={() => {
                setSessionContextMenuKey("");
                toggleSessionPinned(pinKey);
              }}
            >
              <Pin data-icon="inline-start" />
              {pinned ? "Unpin" : "Pin"}
            </ContextMenuItem>
            <ContextMenuItem
              onFocus={resetConfirmDeleteSession}
              onPointerEnter={resetConfirmDeleteSession}
              onSelect={() => {
                setSessionContextMenuKey("");
                openSessionRenameDialog(profileName, session);
              }}
            >
              <Pencil data-icon="inline-start" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              variant={deleteArmed ? "confirm" : "destructive"}
              disabled={deleteDisabled}
              title={activeSessionIds.includes(session.id) ? "Wait for the active response to finish before deleting" : undefined}
              onPointerLeave={resetConfirmDeleteSession}
              onSelect={(event) => {
                if (deleteDisabled) return;
                if (!deleteArmed) {
                  event.preventDefault();
                  setConfirmDeleteSessionKey(pinKey);
                  return;
                }
                void runSessionDelete(profileName, session.id, pinKey);
              }}
            >
              {deleteArmed ? <Check data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
              {sessionActionBusy ? "Deleting..." : deleteArmed ? "Confirm delete" : "Delete"}
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  function openSessionSearch() {
    for (const project of projects) {
      if (projectSessionsLoaded[project.id]) continue;
      if (projectSessionsLoading[project.id]) continue;
      onRefreshProjectSessions(project.id);
    }
    for (const profile of profiles) {
      if (profile.sessionCount < 1) continue;
      if (sessionsLoadedByProfile[profile.name]) continue;
      if (sessionsLoadingByProfile[profile.name]) continue;
      onRefreshSessions(profile.name);
    }
    setSessionSearchQuery("");
    setSessionSearchOpen(true);
  }

  function closeSessionSearch() {
    setSessionSearchOpen(false);
    setSessionSearchQuery("");
  }

  function startSelectedProfileSession() {
    closeSessionSearch();
    onNewSession(selectedProfile);
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

  function selectSessionSearchItem(item: SessionSearchItem) {
    closeSessionSearch();
    expandSessions(item.profileName);
    item.select();
  }

  function renderSessionSearch() {
    const heading = sessionSearchQuery.trim() ? "Matching sessions" : "Recent sessions";
    const loadingAnySession = Object.values(sessionsLoadingByProfile).some(Boolean);

    return (
      <CommandDialog
        open={sessionSearchOpen}
        onOpenChange={(open) => {
          if (!open) closeSessionSearch();
        }}
        title="Search sessions"
        description="Search recent sessions"
        commandProps={{ shouldFilter: false }}
        showCloseButton={false}
      >
        <CommandInput
          ref={sessionSearchInputRef}
          value={sessionSearchQuery}
          placeholder="Search sessions"
          aria-label="Search sessions"
          onValueChange={setSessionSearchQuery}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              const shortcutIndex = Number(event.key) - 1;
              const item = filteredSessionSearchItems[shortcutIndex];
              if (item) {
                selectSessionSearchItem(item);
              }
            }
          }}
        />
        <CommandList className="max-h-[430px]">
          <CommandGroup heading={loadingAnySession && !sessionSearchItems.length ? "Loading sessions" : heading}>
            {filteredSessionSearchItems.map((item, index) => (
              <CommandItem
                key={`${item.profileName}:${item.session.id}`}
                value={sessionSearchCommandValue(item)}
                className="grid min-h-[43px] grid-cols-[auto_minmax(0,1fr)_minmax(72px,auto)_auto] gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px]"
                onSelect={() => selectSessionSearchItem(item)}
              >
                <MessageSquare data-icon="inline-start" />
                <span className="truncate">{item.session.title}</span>
                <small className="truncate text-xs text-menu-muted-foreground group-data-[selected=true]:text-menu-selected-muted-foreground">
                  {item.sourceLabel}
                </small>
                <CommandShortcut>{`⌘${index + 1}`}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
          {!filteredSessionSearchItems.length ? (
            <CommandEmpty>{loadingAnySession ? "Loading sessions..." : "No matching sessions."}</CommandEmpty>
          ) : null}
        </CommandList>
      </CommandDialog>
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
      <Button
        type="button"
        variant="ghost"
        className="sidebar-section-toggle"
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${label.toLowerCase()} section`}
        aria-expanded={!collapsed}
        aria-controls={`sidebar-${section}-section`}
        title={`${collapsed ? "Expand" : "Collapse"} ${label.toLowerCase()}`}
        onClick={() => toggleSidebarSection(section)}
      >
        <span className="sidebar-label">{label}</span>
        <SectionIcon className="sidebar-section-chevron" size={13} />
      </Button>
    );
  }

  function renderSidebarOrganizationButton() {
    return (
      <DropdownMenu onOpenChange={(open) => {
        if (open) closeSidebarMenus();
      }}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="sidebar-icon-button sidebar-organization-trigger"
            aria-label="Organize sidebar"
            title={`Organize by ${sidebarOrganization === "projects" ? "project" : "agent"}`}
            onClick={(event) => event.stopPropagation()}
          >
            <SlidersHorizontal size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6}>
          <DropdownMenuLabel>Organize</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sidebarOrganization}
            onValueChange={(value) => selectSidebarOrganization(value as SidebarOrganization)}
          >
            <DropdownMenuRadioItem value="projects">By project</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="agents">By agent</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
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
    setProfileDialog({ action: "create", name: "" });
  }

  function openProjectCreateDialog() {
    setProjectActionError("");
    setProjectDialog({
      action: "create",
      name: "",
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

  function selectSidebarOrganization(value: SidebarOrganization) {
    setSidebarOrganization(value);
    saveSidebarOrganization(value);
  }

  function closeSidebarMenus() {
    setSessionContextMenuKey("");
    resetConfirmDeleteSession();
  }

  function isSessionPinned(pinKey: string) {
    return Boolean(pinnedSessions[pinKey]);
  }

  function toggleSessionPinned(pinKey: string) {
    setPinnedSessions((current) => {
      const next = { ...current };
      if (next[pinKey]) {
        delete next[pinKey];
      } else {
        next[pinKey] = true;
      }
      savePinnedSessions(next);
      return next;
    });
  }

  function removePinnedSession(sessionId: string, pinKey: string) {
    setPinnedSessions((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (key === pinKey || key.endsWith(`:${sessionId}`)) {
          delete next[key];
        }
      }
      savePinnedSessions(next);
      return next;
    });
  }

  function openSessionRenameDialog(profileName: string, session: HermesSession) {
    setSessionActionError("");
    setSessionDialog({ profileName, session, name: session.title });
  }

  function openProjectEditDialog(project: IrisProject) {
    setProjectActionError("");
    setProjectDialog({
      action: "edit",
      projectId: project.id,
      name: project.name,
      defaultAgentId: project.defaultAgentId,
      systemPrompt: project.systemPrompt,
    });
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

  function closeSessionDialog() {
    if (sessionActionBusy) return;
    setSessionDialog(null);
    setSessionActionError("");
  }

  function resetConfirmDeleteSession() {
    setConfirmDeleteSessionKey("");
  }

  async function submitSessionDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionDialog || sessionActionBusy) return;

    const name = sessionDialog.name.trim();
    if (!name) {
      setSessionActionError("Enter a session name.");
      return;
    }

    setSessionActionBusy(true);
    setSessionActionError("");
    const message = await onRenameSession(
      sessionDialog.profileName,
      sessionDialog.session.id,
      name,
    );
    setSessionActionBusy(false);

    if (isSessionActionFailure(message)) {
      setSessionActionError(message);
      return;
    }
    setSessionDialog(null);
  }

  async function runSessionDelete(profileName: string, sessionId: string, pinKey: string) {
    setSessionActionBusy(true);
    setSessionActionError("");
    const message = await onDeleteSession(profileName, sessionId);
    setSessionActionBusy(false);
    if (isSessionActionFailure(message)) {
      setSessionActionError(message);
      setConfirmDeleteSessionKey("");
      return;
    }
    removePinnedSession(sessionId, pinKey);
    setConfirmDeleteSessionKey("");
    setSessionContextMenuKey("");
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

function isSessionActionFailure(message: string) {
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { pinned: false, projects: false, chats: false, agents: false };
  }
  return {
    pinned: Boolean(parsed.pinned),
    projects: Boolean(parsed.projects),
    chats: Boolean(parsed.chats),
    agents: Boolean(parsed.agents),
  };
}

function loadSidebarOrganization(): SidebarOrganization {
  const value = loadJsonValue<string>(storageKeys.sidebarOrganization, "projects");
  return value === "agents" ? "agents" : "projects";
}

function loadPinnedSessions() {
  const parsed = loadJsonValue<Record<string, unknown>>(storageKeys.pinnedSessions, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.fromEntries(
        Object.entries(parsed)
          .filter(([key]) => key.includes(":"))
          .map(([key, value]) => [key, Boolean(value)]),
      )
    : {};
}

function savePinnedSessions(value: Record<string, boolean>) {
  saveJsonValue(storageKeys.pinnedSessions, value);
}

function agentSessionPinKey(profileName: string, sessionId: string) {
  return `agent:${profileName}:${sessionId}`;
}

function projectSessionPinKey(projectId: string, sessionId: string) {
  return `project:${projectId}:${sessionId}`;
}

function unprojectedSessionPinKey(profileName: string, sessionId: string) {
  return `chat:${profileName}:${sessionId}`;
}

export function buildSessionSearchItems({
  sessions,
  sessionsByProfile,
  sessionsByProject,
  onSelectSession,
  onSelectProjectSession,
  profiles,
  projects,
  selectedProfile,
  unprojectedSessions,
}: {
  sessions: HermesSession[];
  sessionsByProfile: Record<string, HermesSession[]>;
  sessionsByProject: Record<string, HermesSession[]>;
  onSelectSession: (profileName: string, sessionId: string) => void;
  onSelectProjectSession: (projectId: string, profileName: string, sessionId: string) => void;
  profiles: HermesProfile[];
  projects: IrisProject[];
  selectedProfile: string;
  unprojectedSessions: HermesSession[];
}) {
  const seen = new Set<string>();
  const items: SessionSearchItem[] = [];

  const pushItem = (profileName: string, session: HermesSession, item: SessionSearchItem) => {
    const key = sessionSearchIdentityKey(profileName, session.id);
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const project of projects) {
    for (const session of sessionsByProject[project.id] || []) {
      const profileName = runtimeProfileForSession(session, selectedProfile);
      pushItem(profileName, session, {
        session,
        profileName,
        sourceLabel: `${project.name} / ${profileName}`,
        pinKey: projectSessionPinKey(project.id, session.id),
        select: () => onSelectProjectSession(project.id, profileName, session.id),
      });
    }
  }

  for (const session of unprojectedSessions) {
    const profileName = runtimeProfileForSession(session, selectedProfile);
    pushItem(profileName, session, {
      session,
      profileName,
      sourceLabel: `Sessions / ${profileName}`,
      pinKey: unprojectedSessionPinKey(profileName, session.id),
      select: () => onSelectSession(profileName, session.id),
    });
  }

  for (const profile of profiles) {
    const profileSessions =
      profile.name === selectedProfile
        ? sessions
        : sessionsByProfile[profile.name] || [];

    for (const session of profileSessions) {
      pushItem(profile.name, session, {
        session,
        profileName: profile.name,
        sourceLabel: profile.name,
        pinKey: agentSessionPinKey(profile.name, session.id),
        select: () => onSelectSession(profile.name, session.id),
      });
    }
  }

  return items.sort(
    (left, right) =>
      sessionMillis(right.session.lastActiveAt) -
      sessionMillis(left.session.lastActiveAt),
  );
}

function sessionSearchIdentityKey(profileName: string, sessionId: string) {
  return `${profileName}:${sessionId}`;
}

export function sessionSearchCommandValue(item: SessionSearchItem) {
  return `${item.session.id} ${item.session.title} ${item.profileName} ${item.sourceLabel}`;
}

function legacySessionPinKey(profileName: string, sessionId: string) {
  return `${profileName}:${sessionId}`;
}

function pinnedPinKeyForSessionItem(
  item: SessionSearchItem,
  pinnedSessions: Record<string, boolean>,
) {
  const candidates = [
    item.pinKey,
    agentSessionPinKey(item.profileName, item.session.id),
    unprojectedSessionPinKey(item.profileName, item.session.id),
    legacySessionPinKey(item.profileName, item.session.id),
  ];

  return candidates.find((pinKey) => pinnedSessions[pinKey]) || "";
}

export function unpinnedProfileSessions<T extends { id: string }>(
  profileName: string,
  sessions: T[],
  pinnedSessions: Record<string, boolean>,
) {
  return sessions.filter((session) =>
    !pinnedSessions[agentSessionPinKey(profileName, session.id)] &&
    !pinnedSessions[legacySessionPinKey(profileName, session.id)],
  );
}

function unpinnedScopedSessions<T extends { id: string }>(
  sessions: T[],
  pinKey: (session: T) => string,
  pinnedSessions: Record<string, boolean>,
) {
  return sessions.filter((session) => !pinnedSessions[pinKey(session)]);
}

function runtimeProfileForSession(session: HermesSession, fallback: string) {
  const origin = session.origin || {};
  const metadata = session.metadata || {};
  return String(origin.runtimeProfile || metadata.runtimeProfile || fallback || "default");
}

function sessionReadState(
  states: Record<string, "read" | "unread">,
  session: HermesSession,
) {
  return states[session.id] || session.readState?.state || "read";
}

function saveCollapsedSessionProfiles(value: Record<string, boolean>) {
  saveJsonValue(storageKeys.collapsedSessionProfiles, value);
}

function saveCollapsedSidebarSections(value: Record<SidebarSectionId, boolean>) {
  saveJsonValue(storageKeys.collapsedSidebarSections, value);
}

function saveSidebarOrganization(value: SidebarOrganization) {
  saveJsonValue(storageKeys.sidebarOrganization, value);
}

export function widthBandForWindow(): SidebarWidthBand {
  if (typeof window === "undefined") return "regular";
  return window.innerWidth <= SIDEBAR_AUTO_COLLAPSE_WIDTH ? "compact" : "regular";
}

export function sidebarResponsiveResizeDecision({
  previousBand,
  nextBand,
  sidebarCollapsed,
  expandedBeforeResponsiveCollapse,
}: {
  previousBand: SidebarWidthBand;
  nextBand: SidebarWidthBand;
  sidebarCollapsed: boolean;
  expandedBeforeResponsiveCollapse: boolean;
}) {
  if (previousBand === "regular" && nextBand === "compact") {
    return {
      nextCollapsed: true,
      expandedBeforeResponsiveCollapse: !sidebarCollapsed,
    };
  }

  if (previousBand === "compact" && nextBand === "regular" && expandedBeforeResponsiveCollapse) {
    return {
      nextCollapsed: false,
      expandedBeforeResponsiveCollapse,
    };
  }

  return {
    nextCollapsed: null,
    expandedBeforeResponsiveCollapse,
  };
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

function sessionMillis(value: number | null) {
  if (!value) return 0;
  return value > 1_000_000_000_000 ? value : value * 1000;
}
