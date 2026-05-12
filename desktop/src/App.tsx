import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import type {
  AppNotification,
  CommandItem,
  ProfileAction,
  View,
} from "./app/types";
import { AgentsView } from "./features/agents/AgentsView";
import { AgentTopbar } from "./features/agents/AgentTopbar";
import type { AgentDetailSection } from "./features/agents/types";
import { ChatView } from "./features/chat/ChatView";
import { useAgentUIChat } from "./features/chat/useIrisChat";
import { useIrisModelCatalog } from "./features/chat/useIrisModelCatalog";
import { useIrisSlashCommands } from "./features/chat/useIrisSlashCommands";
import { useIrisRuntime } from "./features/iris/useIrisRuntime";
import { AutomationsView } from "./features/automations/AutomationsView";
import { useAgentUIAutomations } from "./features/automations/useIrisAutomations";
import type { HermesInboxMessage, HermesSession } from "./types/hermes";
import { useIrisProjects } from "./features/projects/useIrisProjects";
import { CommandMenu } from "./features/polish/CommandMenu";
import { NotificationCenter } from "./features/polish/NotificationCenter";
import { OnboardingOverlay } from "./features/polish/OnboardingOverlay";
import { AppShell } from "./layout/AppShell";
import { loadBooleanValue, saveBooleanValue, storageKeys } from "./app/storage";
import {
  isProjectSession,
  mergeProjectSessionsForSidebar,
  mergeProjectSessionReadStatesForSidebar,
  projectSessionMembership,
} from "./app/projectSessions";

function App() {
  const [activeView, setActiveView] = useState<View>("chat");
  const [agentDetailProfile, setAgentDetailProfile] = useState<string | null>(null);
  const [agentSection, setAgentSection] = useState<AgentDetailSection>("overview");
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => !loadBooleanValue(storageKeys.onboardingDismissed),
  );
  const appCommandHandlerRef = useRef<(payload: string) => void>(() => {});

  const iris = useIrisRuntime();
  const projects = useIrisProjects(iris.runtimeConfig);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const chat = useAgentUIChat({
    profile: iris.selectedProfile,
    runtimeConfig: iris.runtimeConfig,
    isChatViewActive: activeView === "chat",
    onSessionMetadataResolved: (_sessionId, projectId) => {
      if (projectId) void projectsRef.current.refreshProjectSessions(projectId);
    },
  });
  const jobs = useAgentUIAutomations(iris.runtimeConfig, iris.selectedProfile, activeView === "jobs");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey) return;

      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        setCommandMenuOpen(true);
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        void refreshWithNotice();
      } else if (/^[1-3]$/.test(event.key)) {
        event.preventDefault();
        const views: View[] = ["chat", "agents", "jobs"];
        selectView(views[Number(event.key) - 1]);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let disposeListener: (() => void) | null = null;
    const unlisten = listen<string>("iris://app-command", (event) => {
      appCommandHandlerRef.current(event.payload);
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      disposeListener = dispose;
    });
    return () => {
      disposed = true;
      disposeListener?.();
      void unlisten;
    };
  }, []);

  const agentProfiles = iris.status?.profiles?.length ? iris.status.profiles : [iris.activeProfile];
  const selectedProfileSummary =
    agentProfiles.find((profile) => profile.name === iris.selectedProfile) || iris.activeProfile;
  const modelCatalog = useIrisModelCatalog({
    profile: iris.selectedProfile,
    profileSummary: selectedProfileSummary,
    runtimeConfig: iris.runtimeConfig,
    connected: iris.connected,
    refreshKey: iris.status?.checkedAt || 0,
  });
  const slashCommands = useIrisSlashCommands({
    profile: iris.selectedProfile,
    runtimeConfig: iris.runtimeConfig,
    connected: iris.connected,
    refreshKey: iris.status?.checkedAt || 0,
  });
  const agentTopbarProfile =
    agentProfiles.find((profile) => profile.name === agentDetailProfile) ?? iris.activeProfile;
  const projectAgentById = useMemo(
    () => new Map(projects.agents.map((agent) => [agent.id, agent])),
    [projects.agents],
  );
  const projectSessionIdsToPreserve = useMemo(
    () => new Set([chat.selectedSessionId, ...chat.activeSessionIds].filter(Boolean) as string[]),
    [chat.activeSessionIds, chat.selectedSessionId],
  );
  const sidebarSessionsByProject = useMemo(
    () =>
      mergeProjectSessionsForSidebar(
        projects.projects.map((project) => project.id),
        projects.sessionsByProject,
        chat.sessions,
        { preserveProjectSessionIds: projectSessionIdsToPreserve },
      ),
    [chat.sessions, projectSessionIdsToPreserve, projects.sessionsByProject, projects.projects],
  );
  const projectedSessions = useMemo(
    () => projectSessionMembership(sidebarSessionsByProject),
    [sidebarSessionsByProject],
  );
  const unprojectedSessions = useMemo(
    () =>
      chat.sessions.filter((session) =>
        !isProjectSession(session, projectedSessions.ids, projectedSessions.chatIds),
      ),
    [chat.sessions, projectedSessions],
  );
  const sidebarSessionReadStates = useMemo(
    () => mergeProjectSessionReadStatesForSidebar(chat.sessionReadStates, sidebarSessionsByProject),
    [chat.sessionReadStates, sidebarSessionsByProject],
  );

  function openDeliveryChat(delivery: HermesInboxMessage) {
    const targetProfile = delivery.profile || iris.selectedProfile;
    const deliveryMetadata = delivery.metadata || {};
    const deliverySessionId =
      typeof deliveryMetadata.agentuiSessionId === "string"
        ? deliveryMetadata.agentuiSessionId
        : typeof deliveryMetadata.sessionId === "string"
          ? deliveryMetadata.sessionId
          : "";
    const allSessionEntries = [
      ...chat.sessions.map((session) => ({ profile: iris.selectedProfile, projectId: null as string | null, session })),
      ...Object.entries(chat.sessionsByProfile).flatMap(([profileName, sessions]) =>
        sessions.map((session) => ({ profile: profileName, projectId: null as string | null, session })),
      ),
      ...Object.entries(sidebarSessionsByProject).flatMap(([projectId, sessions]) =>
        sessions.map((session) => ({ profile: sessionProfile(session) || targetProfile, projectId, session })),
      ),
    ];
    const match = allSessionEntries.find(
      ({ session }) =>
        Boolean(deliverySessionId && session.id === deliverySessionId) ||
        session.chatId === delivery.chatId ||
        session.id === delivery.chatId,
    );
    const sessionId = match?.session.id || deliverySessionId || (delivery.chatId.startsWith("session_") ? delivery.chatId : "");
    if (!sessionId) {
      pushNotification({
        tone: "info",
        title: "Chat not found",
        message: "Refresh sessions, then try opening this delivery again.",
      });
      return;
    }
    const profileName = match?.profile || targetProfile;
    setActiveView("chat");
    projects.selectProject(match?.projectId || null);
    if (profileName !== iris.selectedProfile) {
      iris.selectProfile(profileName);
    }
    void chat.loadSession(sessionId, profileName);
  }

  const commands = useMemo<CommandItem[]>(
    () => [
      ...(["chat", "agents", "jobs"] as View[]).map((view, index) => ({
        id: `view-${view}`,
        label: `Open ${view}`,
        detail: "Switch workspace",
        shortcut: `⌘${index + 1}`,
        run: () => selectView(view),
      })),
      {
        id: "refresh",
        label: "Refresh Iris Connection",
        detail: "Retry runtime, agent, memory, and skill loading",
        shortcut: "⌘R",
        run: () => void refreshWithNotice(),
      },
      {
        id: "setup",
        label: "Open Onboarding",
        detail: "Review first-run setup steps",
        run: () => setOnboardingOpen(true),
      },
    ],
    [activeView],
  );

  appCommandHandlerRef.current = (payload: string) => {
    if (payload === "refresh") void refreshWithNotice();
    if (payload === "show" || payload === "command-menu") setCommandMenuOpen(true);
    if (payload === "new-chat") {
      setCommandMenuOpen(false);
      window.dispatchEvent(new CustomEvent("iris://new-session"));
    }
    if (payload === "search") {
      setCommandMenuOpen(false);
      window.dispatchEvent(new CustomEvent("iris://open-session-search"));
    }
  };

  return (
    <>
      <AppShell
        activeView={activeView}
        connected={iris.connected}
        error={iris.status?.error}
        isRefreshing={iris.isRefreshing}
        primaryPane={renderPrimaryPane()}
        topbarPane={
          activeView === "agents" ? (
            <AgentTopbar
              detailProfile={agentDetailProfile}
              profile={agentTopbarProfile}
              section={agentSection}
              onBack={() => {
                setAgentDetailProfile(null);
                setAgentSection("overview");
              }}
              onSectionChange={setAgentSection}
            />
          ) : undefined
        }
        selectedProfile={iris.selectedProfile}
        status={iris.status}
        coreApiUrl={iris.runtimeConfig.coreApiUrl}
        sessions={chat.sessions}
        sessionsByProfile={chat.sessionsByProfile}
        sessionReadStates={sidebarSessionReadStates}
        projects={projects.projects}
        projectAgents={projects.agents}
        sessionsByProject={sidebarSessionsByProject}
        projectSessionsLoading={projects.projectSessionsLoading}
        projectSessionsLoaded={projects.projectSessionsLoaded}
        projectErrors={projects.projectErrors}
        collapsedProjects={projects.collapsedProjects}
        unprojectedSessions={unprojectedSessions}
        selectedProjectId={projects.selectedProjectId}
        onCreateProject={async (payload) => {
          const project = await projects.createProject(payload);
          pushNotification({
            tone: "success",
            title: "Project created",
            message: `${project.name} is ready.`,
          });
          return project;
        }}
        onUpdateProject={async (projectId, payload) => {
          const project = await projects.updateProject(projectId, payload);
          pushNotification({
            tone: "success",
            title: "Project updated",
            message: `${project.name} is current.`,
          });
          return project;
        }}
        onToggleProjectCollapsed={projects.toggleProjectCollapsed}
        onRefreshProjects={() => void projects.refreshProjects()}
        onRefreshProjectSessions={(projectId) => void projects.refreshProjectSessions(projectId)}
        sessionsLoadedByProfile={chat.sessionsLoadedByProfile}
        sessionsLoading={chat.sessionsLoading}
        sessionsLoadingByProfile={chat.sessionsLoadingByProfile}
        historyError={chat.historyError}
        historyErrorsByProfile={chat.historyErrorsByProfile}
        selectedSessionId={chat.selectedSessionId}
        activeSessionIds={chat.activeSessionIds}
        onNewSession={(profileName, projectId) => {
          setActiveView("chat");
          if (projectId) {
            const project = projects.projects.find((item) => item.id === projectId);
            const agent = project ? projectAgentById.get(project.defaultAgentId) : null;
            projects.selectProject(projectId);
            if (agent && agent.runtimeProfile !== iris.selectedProfile) {
              iris.selectProfile(agent.runtimeProfile);
              chat.startNewSession(agent.runtimeProfile);
            } else {
              chat.startNewSession(profileName || iris.selectedProfile);
            }
            return;
          }
          projects.selectProject(null);
          if (profileName && profileName !== iris.selectedProfile) {
            iris.selectProfile(profileName);
          }
          chat.startNewSession(profileName);
        }}
        onEditProfile={(profileName) => {
          if (profileName !== iris.selectedProfile) {
            iris.selectProfile(profileName);
          }
          setAgentDetailProfile(profileName);
          setAgentSection("overview");
          setActiveView("agents");
        }}
        onProfileAction={runProfileActionWithNotice}
        onRefresh={() => void refreshWithNotice()}
        onRefreshSessions={(profileName) => void chat.refreshSessions({ profileName })}
        onDeleteSession={async (profileName, sessionId) => {
          const message = await chat.deleteSession(profileName, sessionId);
          const failed = isSessionActionFailure(message);
          pushNotification({
            tone: failed ? "error" : "success",
            title: failed ? "Session delete failed" : "Session deleted",
            message,
          });
          if (!failed) {
            for (const project of projects.projects) {
              void projects.refreshProjectSessions(project.id);
            }
          }
          return message;
        }}
        onRenameSession={async (profileName, sessionId, title) => {
          const message = await chat.renameSession(profileName, sessionId, title);
          const failed = isSessionActionFailure(message);
          pushNotification({
            tone: failed ? "error" : "success",
            title: failed ? "Session rename failed" : "Session renamed",
            message,
          });
          return message;
        }}
        onSelectSession={(profileName, sessionId) => {
          setActiveView("chat");
          projects.selectProject(null);
          if (profileName !== iris.selectedProfile) {
            iris.selectProfile(profileName);
          }
          void chat.loadSession(sessionId, profileName);
        }}
        onSelectProjectSession={(projectId, profileName, sessionId) => {
          setActiveView("chat");
          projects.selectProject(projectId);
          if (profileName !== iris.selectedProfile) {
            iris.selectProfile(profileName);
          }
          void chat.loadSession(sessionId, profileName);
        }}
        onSelectProfile={(profileName) => {
          iris.selectProfile(profileName);
        }}
        onSelectView={selectView}
      />
      <CommandMenu
        commands={commands}
        open={commandMenuOpen}
        onClose={() => setCommandMenuOpen(false)}
      />
      <NotificationCenter
        notifications={notifications}
        onDismiss={(id) => setNotifications((current) => current.filter((item) => item.id !== id))}
      />
      {onboardingOpen ? (
        <OnboardingOverlay
          connected={iris.connected}
          onClose={dismissOnboarding}
          onOpenSettings={() => {
            setAgentDetailProfile(iris.selectedProfile);
            setAgentSection("overview");
            setActiveView("agents");
            dismissOnboarding();
          }}
          onRefresh={() => void refreshWithNotice()}
        />
      ) : null}
    </>
  );

  async function refreshWithNotice() {
    await iris.refreshIris();
    await slashCommands.refreshSlashCommands();
    pushNotification({
      tone: iris.status?.connected ? "success" : "info",
      title: "Connection refreshed",
      message: iris.status?.connected ? "Iris agent data is current." : "Iris is still waiting for a route.",
    });
  }

  function dismissOnboarding() {
    saveBooleanValue(storageKeys.onboardingDismissed, true);
    setOnboardingOpen(false);
  }

  function selectView(view: View) {
    setActiveView(view);
    if (view === "agents") {
      setAgentDetailProfile(null);
      setAgentSection("overview");
    }
  }

  function pushNotification(notification: Omit<AppNotification, "id">) {
    const id = crypto.randomUUID();
    setNotifications((current) => [{ id, ...notification }, ...current].slice(0, 4));
    window.setTimeout(() => {
      setNotifications((current) => current.filter((item) => item.id !== id));
    }, 5200);
  }

  async function runProfileActionWithNotice(action: ProfileAction, name: string, sourceProfile?: string) {
    const message = await iris.runProfileAction(action, name, sourceProfile);
    pushNotification({
      tone: isProfileActionFailure(message) ? "error" : "success",
      title: profileActionTitle(action),
      message,
    });
    return message;
  }

  function renderPrimaryPane() {
    if (activeView === "agents") {
      return (
        <AgentsView
          detailProfile={agentDetailProfile}
          status={iris.status}
          activeProfile={iris.activeProfile}
          selectedProfile={iris.selectedProfile}
          runtimeConfig={iris.runtimeConfig}
          memory={iris.memory}
          skills={iris.skills}
          section={agentSection}
          onDetailProfileChange={setAgentDetailProfile}
          onSectionChange={setAgentSection}
          onSelectProfile={iris.selectProfile}
          onRuntimeChange={iris.updateRuntimeConfig}
          onRefresh={() => void iris.refreshIris()}
          onProfileAction={iris.runProfileAction}
          onResetMemory={iris.resetMemoryFile}
          onSaveMemory={iris.saveMemoryFile}
        />
      );
    }
    if (activeView === "jobs") {
      return (
        <AutomationsView
          activeAutomations={jobs.activeAutomations}
          busyAutomationId={jobs.busyAutomationId}
          connected={iris.connected}
          deliveries={jobs.deliveries}
          error={jobs.error}
          pausedAutomations={jobs.pausedAutomations}
          projects={projects.projects}
          selectedProjectId={projects.selectedProjectId}
          onAcknowledgeDelivery={(messageId) => void jobs.acknowledgeDelivery(messageId)}
          onCreateScheduledMessage={jobs.createScheduledMessage}
          onOpenDeliveryChat={openDeliveryChat}
          onProjectChange={(projectId) => {
            projects.selectProject(projectId);
            if (!projectId) return;
            const project = projects.projects.find((item) => item.id === projectId);
            const agent = project ? projectAgentById.get(project.defaultAgentId) : null;
            if (agent && agent.runtimeProfile !== iris.selectedProfile) {
              iris.selectProfile(agent.runtimeProfile);
            }
          }}
          onRunJobAction={jobs.runJobAction}
          onUpdateScheduledMessage={jobs.updateScheduledMessage}
        />
      );
    }
    return (
      <ChatView
        messages={chat.messages}
        selectedSessionId={chat.selectedSessionId}
        input={chat.input}
        onInput={chat.setInput}
        onSend={(options) =>
          chat.sendMessage({
            text: options?.text,
            attachments: options?.attachments,
            modelSelection: options?.modelSelection,
            projectId: (options?.projectId ?? projects.selectedProjectId) || null,
            currentModelSelection: modelCatalog.currentSelection,
            onAttachmentUploadError: options?.onAttachmentUploadError,
          }).then((sent) => {
            const projectId = (options?.projectId ?? projects.selectedProjectId) || null;
            if (sent && projectId) {
              window.setTimeout(() => void projects.refreshProjectSessions(projectId), 1400);
            }
            return sent;
          })
        }
        connected={iris.connected}
        profile={iris.selectedProfile}
        profiles={agentProfiles}
        projects={projects.projects}
        selectedProjectId={projects.selectedProjectId}
        onProjectChange={(projectId) => {
          projects.selectProject(projectId);
          if (!projectId) return;
          const project = projects.projects.find((item) => item.id === projectId);
          const agent = project ? projectAgentById.get(project.defaultAgentId) : null;
          if (agent && agent.runtimeProfile !== iris.selectedProfile) {
            iris.selectProfile(agent.runtimeProfile);
          }
        }}
        onProfileChange={iris.selectProfile}
        requestActive={chat.requestActive}
        onCancel={() => void chat.cancelMessage()}
        modelCatalog={modelCatalog.catalog}
        modelSelection={modelCatalog.draftSelection}
        lockedModelSelection={chat.selectedModelSelection}
        modelLoading={modelCatalog.loading}
        modelError={modelCatalog.error}
        runtimeConfig={iris.runtimeConfig}
        onModelSelect={modelCatalog.selectDraftModel}
        slashCommands={slashCommands.commands}
        slashCommandsLoading={slashCommands.loading}
        slashCommandsError={slashCommands.error}
        onSlashCommandsRefresh={() => void slashCommands.refreshSlashCommands()}
      />
    );
  }
}

function profileActionTitle(action: ProfileAction) {
  if (action === "create") return "Agent created";
  if (action === "clone") return "Agent duplicated";
  if (action === "delete") return "Agent deleted";
  if (action === "rename") return "Agent renamed";
  return "Agent switched";
}

function sessionProfile(session: HermesSession) {
  const metadata = session.metadata || {};
  return typeof metadata.runtimeProfile === "string" ? metadata.runtimeProfile : "";
}

function isProfileActionFailure(message: string) {
  return /\b(error|failed|cannot|already exists|does not exist|enter|invalid)\b/i.test(message);
}

function isSessionActionFailure(message: string) {
  return /\b(error|failed|cannot|could not|does not exist|not found|not allowed|enter|invalid|legacy|http|urlopen|connection refused|refused)\b/i.test(message);
}

export default App;
