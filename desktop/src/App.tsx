import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import type {
  CommandItem,
  ProfileAction,
  View,
} from "./app/types";
import { AgentsView } from "./features/agents/AgentsView";
import { AgentTopbar } from "./features/agents/AgentTopbar";
import type { AgentDetailSection } from "./features/agents/types";
import { SettingsView } from "./features/settings/SettingsView";
import { ChatView } from "./features/chat/ChatView";
import { useIrisChat } from "./features/chat/useIrisChat";
import { useIrisModelCatalog } from "./features/chat/useIrisModelCatalog";
import { useIrisSlashCommands } from "./features/chat/useIrisSlashCommands";
import { useIrisRuntime } from "./features/iris/useIrisRuntime";
import { AutomationsView } from "./features/automations/AutomationsView";
import { useIrisAutomations } from "./features/automations/useIrisAutomations";
import type { HermesInboxMessage, HermesSession } from "./types/hermes";
import { useIrisProjects } from "./features/projects/useIrisProjects";
import { CommandMenu } from "./features/polish/CommandMenu";
import { OnboardingOverlay } from "./features/polish/OnboardingOverlay";
import { RuntimeDiagnosticsDialog } from "./features/runtime/RuntimeDiagnosticsDialog";
import { AppShell } from "./layout/AppShell";
import { globalShortcutActionForKey } from "./app/keyboardShortcuts";
import { loadBooleanValue, saveBooleanValue, storageKeys } from "./app/storage";
import { resolveCoreApiUrl } from "./app/runtimeConfig";
import {
  runtimeReadinessForStatus,
} from "./app/runtimeReadiness";
import {
  isProjectSession,
  mergeProjectSessionsForSidebar,
  mergeProjectSessionReadStatesForSidebar,
  projectSessionMembership,
} from "./app/projectSessions";
import { Toaster } from "./shared/ui/sonner";
import { toast } from "sonner";
import {
  installIrisCoreHermesPlugin,
  type IrisCoreGatewayAction,
  type IrisCoreInstallPluginResult,
} from "./lib/irisCore";

type AppNotificationInput = {
  tone: "info" | "success" | "error";
  title: string;
  message: string;
};

type GatewayActionState = {
  action: IrisCoreGatewayAction;
  profile: string;
};

function App() {
  const [activeView, setActiveView] = useState<View>("chat");
  const [agentDetailProfile, setAgentDetailProfile] = useState<string | null>(null);
  const [agentSection, setAgentSection] = useState<AgentDetailSection>("overview");
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [gatewayActionState, setGatewayActionState] = useState<GatewayActionState | null>(null);
  const [adapterInstallBusyProfile, setAdapterInstallBusyProfile] = useState("");
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => !loadBooleanValue(storageKeys.onboardingDismissed),
  );
  const appCommandHandlerRef = useRef<(payload: string) => void>(() => {});
  const refreshWithNoticeRef = useRef<() => Promise<void>>(async () => {});

  const iris = useIrisRuntime();
  const gatewayActionBusy = Boolean(gatewayActionState);
  const [chatProfile, setChatProfile] = useState("default");
  const projects = useIrisProjects(iris.runtimeConfig, iris.connected ? "connected" : "offline");
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const chat = useIrisChat({
    profile: chatProfile,
    runtimeConfig: iris.runtimeConfig,
    isChatViewActive: activeView === "chat",
    onSessionMetadataResolved: (_sessionId, projectId) => {
      if (projectId) void projectsRef.current.refreshProjectSessions(projectId);
    },
  });
  const jobs = useIrisAutomations(iris.runtimeConfig, iris.selectedProfile, activeView === "jobs");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = globalShortcutActionForKey(event);
      if (!action) return;

      if (action.type === "open-command-menu") {
        event.preventDefault();
        setCommandMenuOpen(true);
      } else if (action.type === "refresh") {
        event.preventDefault();
        void refreshWithNoticeRef.current();
      } else if (action.type === "select-view") {
        event.preventDefault();
        selectView(action.view);
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
  const runtimeReadiness = runtimeReadinessForStatus(iris.status, selectedProfileSummary);
  const chatProfileSummary =
    agentProfiles.find((profile) => profile.name === chatProfile) || selectedProfileSummary;
  const chatRuntimeReadiness = runtimeReadinessForStatus(iris.status, chatProfileSummary);
  const sidebarStatusProfile = activeView === "chat" ? chatProfile : iris.selectedProfile;
  const modelCatalog = useIrisModelCatalog({
    profile: chatProfile,
    profileSummary: chatProfileSummary,
    runtimeConfig: iris.runtimeConfig,
    connected: iris.connected,
    refreshKey: iris.status?.checkedAt || 0,
  });
  const slashCommands = useIrisSlashCommands({
    profile: chatProfile,
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
  const sidebarSessions = chat.sessionsByProfile[iris.selectedProfile] ||
    (chatProfile === iris.selectedProfile ? chat.sessions : []);
  const sidebarSessionsLoading = chatProfile === iris.selectedProfile
    ? chat.sessionsLoading
    : Boolean(chat.sessionsLoadingByProfile[iris.selectedProfile]);
  const sidebarHistoryError = chatProfile === iris.selectedProfile
    ? chat.historyError
    : chat.historyErrorsByProfile[iris.selectedProfile] || null;
  const sidebarSessionsByProject = useMemo(
    () =>
      mergeProjectSessionsForSidebar(
        projects.projects.map((project) => project.id),
        projects.sessionsByProject,
        sidebarSessions,
        { preserveProjectSessionIds: projectSessionIdsToPreserve },
      ),
    [projectSessionIdsToPreserve, projects.sessionsByProject, projects.projects, sidebarSessions],
  );
  const projectedSessions = useMemo(
    () => projectSessionMembership(sidebarSessionsByProject),
    [sidebarSessionsByProject],
  );
  const unprojectedSessions = useMemo(
    () =>
      sidebarSessions.filter((session) =>
        !isProjectSession(session, projectedSessions.ids, projectedSessions.chatIds),
      ),
    [projectedSessions, sidebarSessions],
  );
  const sidebarSessionReadStates = useMemo(
    () => mergeProjectSessionReadStatesForSidebar(chat.sessionReadStates, sidebarSessionsByProject),
    [chat.sessionReadStates, sidebarSessionsByProject],
  );

  async function runGatewayAction(action: IrisCoreGatewayAction, profileName = iris.selectedProfile) {
    if (gatewayActionState) return;
    setGatewayActionState({ action, profile: profileName });
    try {
      const result = await iris.runGatewayAction(action, profileName);
      if (result.ok) {
        toast.success(`Hermes gateway ${action} completed.`);
      } else {
        toast.error(result.error || result.command?.stderr || result.command?.stdout || `Hermes gateway ${action} failed.`);
      }
      await Promise.all([
        modelCatalog.refreshModelCatalog(),
        slashCommands.refreshSlashCommands(),
        jobs.refresh(),
      ]);
    } finally {
      setGatewayActionState(null);
    }
  }

  async function installAdapterForProfile(profileName = iris.selectedProfile) {
    if (adapterInstallBusyProfile) return;
    setAdapterInstallBusyProfile(profileName);
    try {
      let installedOk = false;
      try {
        const result = await installIrisCoreHermesPlugin(iris.runtimeConfig);
        const detail = pluginInstallSummary(result);
        installedOk = result.ok && detail.ok;
        toast[installedOk ? "success" : "error"](detail.message);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Iris could not install the Iris adapter.");
      }
      if (installedOk) {
        const profile = agentProfiles.find((item) => item.name === profileName);
        if (profile?.gatewayRunning) await runGatewayAction("restart", profileName);
        else await iris.refreshIris(profileName);
      }
    } finally {
      setAdapterInstallBusyProfile("");
    }
  }

  function openDeliveryChat(delivery: HermesInboxMessage) {
    const targetProfile = delivery.profile || iris.selectedProfile;
    const deliveryMetadata = delivery.metadata || {};
    const deliverySessionId =
      typeof deliveryMetadata.irisSessionId === "string"
        ? deliveryMetadata.irisSessionId
        : typeof deliveryMetadata.sessionId === "string"
          ? deliveryMetadata.sessionId
          : "";
    const allSessionEntries = [
      ...sidebarSessions.map((session) => ({ profile: iris.selectedProfile, projectId: null as string | null, session })),
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
    setChatProfile(profileName);
    void chat.loadSession(sessionId, profileName);
  }

  const commands = useMemo<CommandItem[]>(
    () => [
      ...(["chat", "agents", "jobs"] as View[]).map((view, index) => ({
        id: `view-${view}`,
        label: view === "jobs" ? "Open automations" : `Open ${view}`,
        detail: "Switch workspace",
        shortcut: `⌘${index + 1}`,
        run: () => selectView(view),
      })),
      {
        id: "refresh",
        label: "Refresh Iris Connection",
        detail: "Retry runtime, agent, memory, and skill loading",
        shortcut: "⌘R",
        run: () => void refreshWithNoticeRef.current(),
      },
      {
        id: "setup",
        label: "Open Onboarding",
        detail: "Review first-run setup steps",
        run: () => setOnboardingOpen(true),
      },
      {
        id: "view-settings",
        label: "Open settings",
        detail: "Configure app runtime and connection settings",
        run: () => selectView("settings"),
      },
    ],
    [activeView],
  );

  appCommandHandlerRef.current = (payload: string) => {
    if (payload === "refresh") void refreshWithNoticeRef.current();
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
  refreshWithNoticeRef.current = refreshWithNotice;

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
        statusProfile={sidebarStatusProfile}
        status={iris.status}
        coreApiUrl={resolveCoreApiUrl(iris.runtimeConfig)}
        sessions={sidebarSessions}
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
        sessionsLoading={sidebarSessionsLoading}
        sessionsLoadingByProfile={chat.sessionsLoadingByProfile}
        historyError={sidebarHistoryError}
        historyErrorsByProfile={chat.historyErrorsByProfile}
        selectedSessionId={chat.selectedSessionId}
        activeSessionIds={chat.activeSessionIds}
        onNewSession={(profileName, projectId) => {
          setActiveView("chat");
          if (projectId) {
            const project = projects.projects.find((item) => item.id === projectId);
            const agent = project ? projectAgentById.get(project.defaultAgentId) : null;
            projects.selectProject(projectId);
            const targetProfile = agent?.runtimeProfile || profileName || chatProfile;
            setChatProfile(targetProfile);
            chat.startNewSession(targetProfile);
            return;
          }
          projects.selectProject(null);
          const targetProfile = profileName || chatProfile;
          setChatProfile(targetProfile);
          chat.startNewSession(targetProfile);
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
          setChatProfile(profileName);
          void chat.loadSession(sessionId, profileName);
        }}
        onSelectProjectSession={(projectId, profileName, sessionId) => {
          setActiveView("chat");
          projects.selectProject(projectId);
          setChatProfile(profileName);
          void chat.loadSession(sessionId, profileName);
        }}
        onSelectProfile={(profileName) => {
          iris.selectProfile(profileName);
        }}
        onSelectView={selectView}
        onOpenDiagnostics={() => setDiagnosticsOpen(true)}
      />
      <RuntimeDiagnosticsDialog
        open={diagnosticsOpen}
        status={iris.status}
        selectedProfile={sidebarStatusProfile}
        runtimeConfig={iris.runtimeConfig}
        gatewayActionBusy={gatewayActionBusy}
        onOpenChange={setDiagnosticsOpen}
        onRuntimeChange={iris.updateRuntimeConfig}
        onGatewayAction={async (action) => {
          await runGatewayAction(action, sidebarStatusProfile);
        }}
        onRefresh={() => void iris.refreshIris()}
        onOpenSettings={() => setActiveView("settings")}
      />
      <CommandMenu
        commands={commands}
        open={commandMenuOpen}
        onClose={() => setCommandMenuOpen(false)}
      />
      <Toaster closeButton visibleToasts={4} duration={5200} position="bottom-right" />
      {onboardingOpen ? (
        <OnboardingOverlay
          connected={iris.connected}
          status={iris.status}
          runtimeConfig={iris.runtimeConfig}
          onClose={dismissOnboarding}
          onOpenSettings={() => {
            setActiveView("settings");
            dismissOnboarding();
          }}
          onRefresh={() => void refreshWithNotice()}
          onRuntimeChange={iris.updateRuntimeConfig}
        />
      ) : null}
    </>
  );

  async function refreshWithNotice() {
    const nextStatus = await iris.refreshIris();
    const connected = nextStatus?.connected ?? iris.status?.connected;
    const loadedProfileNames = Object.entries(chat.sessionsLoadedByProfile)
      .filter(([, loaded]) => loaded)
      .map(([profileName]) => profileName);
    const profileNamesToRefresh = new Set([iris.selectedProfile, ...loadedProfileNames]);
    const loadedProjectIds = Object.entries(projects.projectSessionsLoaded)
      .filter(([, loaded]) => loaded)
      .map(([projectId]) => projectId);

    await Promise.all([
      slashCommands.refreshSlashCommands(),
      ...(connected
        ? [
            ...Array.from(profileNamesToRefresh).map((profileName) =>
              chat.refreshSessions({ profileName, silent: true }),
            ),
            ...loadedProjectIds.map((projectId) => projects.refreshProjectSessions(projectId)),
          ]
        : []),
    ]);
    pushNotification({
      tone: connected ? "success" : "info",
      title: "Connection refreshed",
      message: connected ? "Iris agent data is current." : "Iris is still waiting for a route.",
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

  function pushNotification(notification: AppNotificationInput) {
    toast[notification.tone](notification.title, {
      description: notification.message,
    });
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
          runtimeReadiness={runtimeReadiness}
          gatewayActionBusy={gatewayActionBusy}
          gatewayActionBusyAction={gatewayActionState?.action || null}
          gatewayActionBusyProfile={gatewayActionState?.profile || ""}
          adapterInstallBusyProfile={adapterInstallBusyProfile}
          onDetailProfileChange={setAgentDetailProfile}
          onSectionChange={setAgentSection}
          onSelectProfile={iris.selectProfile}
          onRuntimeChange={iris.updateRuntimeConfig}
          onRefresh={() => void iris.refreshIris()}
          onProfileAction={iris.runProfileAction}
          onGatewayAction={(action, profileName) => void runGatewayAction(action, profileName)}
          onInstallAdapter={(profileName) => void installAdapterForProfile(profileName)}
          onOpenSettings={() => setActiveView("settings")}
          onResetMemory={iris.resetMemoryFile}
          onSaveMemory={iris.saveMemoryFile}
        />
      );
    }
    if (activeView === "settings") {
      return (
        <SettingsView
          status={iris.status}
          profile={iris.activeProfile}
          selectedProfile={iris.selectedProfile}
          runtimeConfig={iris.runtimeConfig}
          mode="settings"
          runtimeReadiness={runtimeReadiness}
          gatewayActionBusy={gatewayActionBusy}
          gatewayActionBusyAction={gatewayActionState?.action || null}
          adapterInstallBusy={adapterInstallBusyProfile === iris.selectedProfile}
          onRuntimeChange={iris.updateRuntimeConfig}
          onRefresh={() => void iris.refreshIris()}
          onProfileAction={iris.runProfileAction}
          onGatewayAction={(action) => void runGatewayAction(action)}
          onInstallAdapter={() => void installAdapterForProfile(iris.selectedProfile)}
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
          deliveriesLoading={jobs.deliveriesLoading}
          error={jobs.error}
          pausedAutomations={jobs.pausedAutomations}
          runtimeReadiness={runtimeReadiness}
          gatewayActionBusy={gatewayActionBusy}
          gatewayActionBusyAction={gatewayActionState?.action || null}
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
            if (agent) {
              setChatProfile(agent.runtimeProfile);
            }
          }}
          onRunJobAction={jobs.runJobAction}
          onGatewayAction={(action) => void runGatewayAction(action)}
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
        profile={chatProfile}
        profiles={agentProfiles}
        projects={projects.projects}
        selectedProjectId={projects.selectedProjectId}
        onProjectChange={(projectId) => {
          projects.selectProject(projectId);
          if (!projectId) return;
          const project = projects.projects.find((item) => item.id === projectId);
          const agent = project ? projectAgentById.get(project.defaultAgentId) : null;
          if (agent) {
            setChatProfile(agent.runtimeProfile);
          }
        }}
        onProfileChange={setChatProfile}
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
        runtimeReadiness={chatRuntimeReadiness}
        gatewayActionBusy={gatewayActionBusy}
        gatewayActionBusyAction={gatewayActionState?.action || null}
        onGatewayAction={(action) => void runGatewayAction(action, chatProfile)}
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

function pluginInstallSummary(result: IrisCoreInstallPluginResult) {
  if (!result?.ok) {
    return {
      ok: false,
      message: result?.error || "Iris adapter install failed.",
    };
  }
  if (result.enabled === false) {
    return {
      ok: false,
      message:
        result.enableError ||
        "Iris adapter files were copied, but Hermes did not enable them.",
    };
  }
  return {
    ok: true,
    message: result.restartRequired
      ? "Iris adapter installed. Restarting this agent gateway to load it."
      : "Iris adapter installed.",
  };
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
