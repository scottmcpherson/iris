import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import type {
  AppNotification,
  CommandItem,
  ProfileAction,
  PreviewArtifact,
  PreviewMode,
  PreviewPermissions,
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
import { JobsView } from "./features/jobs/JobsView";
import { useAgentUIAutomations } from "./features/jobs/useIrisAutomations";
import { LivePreviewPane } from "./features/preview/LivePreviewPane";
import {
  createPreviewArtifact,
  createSkillArtifact,
  duplicatePreviewArtifact,
  extensionForMode,
  loadPreviewArtifacts,
  mimeForMode,
  savePreviewArtifacts,
} from "./features/preview/previewArtifacts";
import { defaultPreviewSource } from "./features/preview/previewSamples";
import { renderPreviewDocument } from "./features/preview/renderPreview";
import { CommandMenu } from "./features/polish/CommandMenu";
import { NotificationCenter } from "./features/polish/NotificationCenter";
import { OnboardingOverlay } from "./features/polish/OnboardingOverlay";
import { AppShell } from "./layout/AppShell";
import { loadBooleanValue, saveBooleanValue, storageKeys } from "./app/storage";

function App() {
  const [activeView, setActiveView] = useState<View>("chat");
  const [agentDetailProfile, setAgentDetailProfile] = useState<string | null>(null);
  const [agentSection, setAgentSection] = useState<AgentDetailSection>("overview");
  const [previewOpen, setPreviewOpen] = useState(() => loadPreviewOpenPreference());
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => !loadBooleanValue(storageKeys.onboardingDismissed),
  );
  const [previewArtifacts, setPreviewArtifacts] = useState<PreviewArtifact[]>(() =>
    loadPreviewArtifacts(),
  );
  const [activeArtifactId, setActiveArtifactId] = useState(() => previewArtifacts[0]?.id || "");

  const iris = useIrisRuntime();
  const chat = useAgentUIChat({
    profile: iris.selectedProfile,
    runtimeConfig: iris.runtimeConfig,
  });
  const jobs = useAgentUIAutomations(iris.runtimeConfig, iris.selectedProfile);

  useEffect(() => {
    savePreviewArtifacts(previewArtifacts);
  }, [previewArtifacts]);

  useEffect(() => {
    savePreviewOpenPreference(previewOpen);
  }, [previewOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey) return;

      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        setCommandMenuOpen(true);
      } else if (event.key === "\\" && activeView === "chat") {
        event.preventDefault();
        togglePreviewPane();
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
  }, [activeView]);

  useEffect(() => {
    const unlisten = listen<string>("iris://app-command", (event) => {
      if (event.payload === "refresh") void refreshWithNotice();
      if (event.payload === "show" || event.payload === "command-menu") setCommandMenuOpen(true);
      if (event.payload === "new-chat") {
        setCommandMenuOpen(false);
        window.dispatchEvent(new CustomEvent("iris://new-conversation"));
      }
      if (event.payload === "search") {
        setCommandMenuOpen(false);
        window.dispatchEvent(new CustomEvent("iris://open-conversation-search"));
      }
    });
    return () => {
      void unlisten?.then((dispose: () => void) => dispose());
    };
  }, []);

  const activeArtifact =
    previewArtifacts.find((artifact) => artifact.id === activeArtifactId) || previewArtifacts[0];

  const previewDocument = useMemo(
    () => renderPreviewDocument(activeArtifact.mode, activeArtifact.source, activeArtifact.id),
    [activeArtifact],
  );

  const previewVisible = activeView === "chat" && previewOpen;
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

  const commands = useMemo<CommandItem[]>(
    () => [
      ...(["chat", "agents", "jobs"] as View[]).map((view, index) => ({
        id: `view-${view}`,
        label: `Open ${view}`,
        detail: "Switch workspace",
        shortcut: `⌘${index + 1}`,
        run: () => selectView(view),
      })),
      ...(activeView === "chat"
        ? [
            {
              id: "toggle-preview",
              label: previewOpen ? "Hide Live Preview" : "Show Live Preview",
              detail: "Toggle the artifact preview pane",
              shortcut: "⌘\\",
              run: togglePreviewPane,
            },
          ]
        : []),
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
    [activeView, previewOpen],
  );

  return (
    <>
      <AppShell
        activeView={activeView}
        connected={iris.connected}
        error={iris.status?.error}
        isRefreshing={iris.isRefreshing}
        previewOpen={previewVisible}
        primaryPane={renderPrimaryPane()}
        previewPane={
          <LivePreviewPane
            artifact={activeArtifact}
            artifacts={previewArtifacts}
            document={previewDocument}
            onArtifactNameChange={renameActiveArtifact}
            onArtifactSelect={setActiveArtifactId}
            onDeleteArtifact={deleteActiveArtifact}
            onDuplicateArtifact={duplicateActiveArtifact}
            onExportArtifact={exportActiveArtifact}
            onModeChange={changeActiveArtifactMode}
            onNewArtifact={createNewArtifact}
            onPermissionChange={changeActiveArtifactPermissions}
            onSaveAsSkill={saveActiveArtifactAsSkill}
            onSourceChange={updateActiveArtifactSource}
          />
        }
        topbarPane={
          activeView === "agents" ? (
            <AgentTopbar
              detailProfile={agentDetailProfile}
              profile={agentTopbarProfile}
              rootPath={iris.runtimeConfig.coreApiUrl}
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
        conversations={chat.conversations}
        conversationsByProfile={chat.conversationsByProfile}
        conversationsLoadedByProfile={chat.conversationsLoadedByProfile}
        conversationsLoading={chat.conversationsLoading}
        conversationsLoadingByProfile={chat.conversationsLoadingByProfile}
        historyError={chat.historyError}
        historyErrorsByProfile={chat.historyErrorsByProfile}
        selectedConversationId={chat.selectedConversationId}
        activeConversationIds={chat.activeConversationIds}
        onNewConversation={(profileName) => {
          setActiveView("chat");
          if (profileName && profileName !== iris.selectedProfile) {
            iris.selectProfile(profileName);
          }
          chat.startNewConversation(profileName);
        }}
        onPreviewToggle={togglePreviewPane}
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
        onRefreshConversations={(profileName) => void chat.refreshConversations({ profileName })}
        onSelectConversation={(profileName, conversationId) => {
          setActiveView("chat");
          if (profileName !== iris.selectedProfile) {
            iris.selectProfile(profileName);
          }
          void chat.loadConversation(conversationId, profileName);
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

  function togglePreviewPane() {
    if (activeView !== "chat") return;
    setPreviewOpen((open) => !open);
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

  function updateActiveArtifact(updater: (artifact: PreviewArtifact) => PreviewArtifact) {
    setPreviewArtifacts((current) =>
      current.map((artifact) => (artifact.id === activeArtifact.id ? updater(artifact) : artifact)),
    );
  }

  function updateActiveArtifactSource(source: string) {
    updateActiveArtifact((artifact) => ({ ...artifact, source, updatedAt: Date.now() }));
  }

  function renameActiveArtifact(name: string) {
    updateActiveArtifact((artifact) => ({ ...artifact, name, updatedAt: Date.now() }));
  }

  function changeActiveArtifactPermissions(permissions: PreviewPermissions) {
    updateActiveArtifact((artifact) => ({ ...artifact, permissions, updatedAt: Date.now() }));
  }

  function changeActiveArtifactMode(mode: PreviewMode) {
    updateActiveArtifact((artifact) => ({
      ...artifact,
      mode,
      source: artifact.mode === mode ? artifact.source : defaultPreviewSource(mode),
      name: artifact.mode === mode ? artifact.name : renameForMode(artifact.name, mode),
      permissions: {
        ...artifact.permissions,
        scripts: mode === "react" || mode === "diagram" ? true : artifact.permissions.scripts,
      },
      updatedAt: Date.now(),
    }));
  }

  function createNewArtifact() {
    const artifact = createPreviewArtifact(activeArtifact.mode);
    setPreviewArtifacts((current) => [...current, artifact]);
    setActiveArtifactId(artifact.id);
  }

  function duplicateActiveArtifact() {
    const artifact = duplicatePreviewArtifact(activeArtifact);
    setPreviewArtifacts((current) => [...current, artifact]);
    setActiveArtifactId(artifact.id);
  }

  function deleteActiveArtifact() {
    if (previewArtifacts.length < 2) return;
    const nextArtifacts = previewArtifacts.filter((artifact) => artifact.id !== activeArtifact.id);
    setPreviewArtifacts(nextArtifacts);
    setActiveArtifactId(nextArtifacts[0].id);
  }

  function saveActiveArtifactAsSkill() {
    const skill = createSkillArtifact(activeArtifact);
    setPreviewArtifacts((current) => [...current, skill]);
    setActiveArtifactId(skill.id);
  }

  function exportActiveArtifact() {
    const extension = extensionForMode(activeArtifact.mode);
    const filename = ensureExtension(activeArtifact.name || `artifact.${extension}`, extension);
    const blob = new Blob([activeArtifact.source], { type: `${mimeForMode(activeArtifact.mode)};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
        <JobsView
          activeJobs={jobs.activeJobs}
          busyJobId={jobs.busyJobId}
          completedJobs={jobs.completedJobs}
          deliveries={jobs.deliveries}
          deliveryTarget={jobs.deliveryTarget}
          error={jobs.error}
          loading={jobs.loading}
          pausedJobs={jobs.pausedJobs}
          onAcknowledgeDelivery={(messageId) => void jobs.acknowledgeDelivery(messageId)}
          onCreateScheduledMessage={jobs.createScheduledMessage}
          onDeliveryTargetChange={jobs.updateDeliveryTarget}
          onRefresh={() => void jobs.refresh()}
          onRunJobAction={jobs.runJobAction}
        />
      );
    }
    return (
      <ChatView
        messages={chat.messages}
        selectedConversationId={chat.selectedConversationId}
        input={chat.input}
        onInput={chat.setInput}
        onSend={(options) =>
          chat.sendMessage({
            attachments: options?.attachments,
            modelSelection: options?.modelSelection,
            currentModelSelection: modelCatalog.currentSelection,
          })
        }
        connected={iris.connected}
        profile={iris.selectedProfile}
        profiles={agentProfiles}
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

function renameForMode(name: string, mode: PreviewMode) {
  return ensureExtension(name.replace(/\.[^.]+$/, ""), extensionForMode(mode));
}

function ensureExtension(name: string, extension: string) {
  return name.endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

function loadPreviewOpenPreference() {
  return loadBooleanValue(storageKeys.previewOpen);
}

function savePreviewOpenPreference(open: boolean) {
  saveBooleanValue(storageKeys.previewOpen, open);
}

function profileActionTitle(action: ProfileAction) {
  if (action === "create") return "Agent created";
  if (action === "clone") return "Agent duplicated";
  if (action === "delete") return "Agent deleted";
  if (action === "rename") return "Agent renamed";
  return "Agent switched";
}

function isProfileActionFailure(message: string) {
  return /\b(error|failed|cannot|already exists|does not exist|enter|invalid)\b/i.test(message);
}

export default App;
