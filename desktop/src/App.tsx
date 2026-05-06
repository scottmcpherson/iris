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
import { useAgentUIChat } from "./features/chat/useHermesChat";
import { useHermesModelCatalog } from "./features/chat/useHermesModelCatalog";
import { useHermesSlashCommands } from "./features/chat/useHermesSlashCommands";
import { useHermesRuntime } from "./features/hermes/useHermesRuntime";
import { JobsView } from "./features/jobs/JobsView";
import { useAgentUIAutomations } from "./features/jobs/useHermesJobs";
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

const onboardingStorageKey = "hermes.desktop.onboarding.dismissed";
const previewOpenStorageKey = "hermes.desktop.preview.open";

function App() {
  const [activeView, setActiveView] = useState<View>("chat");
  const [agentDetailProfile, setAgentDetailProfile] = useState<string | null>(null);
  const [agentSection, setAgentSection] = useState<AgentDetailSection>("overview");
  const [previewOpen, setPreviewOpen] = useState(() => loadPreviewOpenPreference());
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => localStorage.getItem(onboardingStorageKey) !== "true",
  );
  const [previewArtifacts, setPreviewArtifacts] = useState<PreviewArtifact[]>(() =>
    loadPreviewArtifacts(),
  );
  const [activeArtifactId, setActiveArtifactId] = useState(() => previewArtifacts[0]?.id || "");

  const hermes = useHermesRuntime();
  const chat = useAgentUIChat({
    profile: hermes.selectedProfile,
    runtimeConfig: hermes.runtimeConfig,
  });
  const jobs = useAgentUIAutomations(hermes.runtimeConfig, hermes.selectedProfile);

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
    const unlisten = listen<string>("hermes://app-command", (event) => {
      if (event.payload === "refresh") void refreshWithNotice();
      if (event.payload === "show") setCommandMenuOpen(true);
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
  const agentProfiles = hermes.status?.profiles?.length ? hermes.status.profiles : [hermes.activeProfile];
  const selectedProfileSummary =
    agentProfiles.find((profile) => profile.name === hermes.selectedProfile) || hermes.activeProfile;
  const modelCatalog = useHermesModelCatalog({
    profile: hermes.selectedProfile,
    profileSummary: selectedProfileSummary,
    runtimeConfig: hermes.runtimeConfig,
    connected: hermes.connected,
    refreshKey: hermes.status?.checkedAt || 0,
  });
  const slashCommands = useHermesSlashCommands({
    profile: hermes.selectedProfile,
    runtimeConfig: hermes.runtimeConfig,
    connected: hermes.connected,
    refreshKey: hermes.status?.checkedAt || 0,
  });
  const agentTopbarProfile =
    agentProfiles.find((profile) => profile.name === agentDetailProfile) ?? hermes.activeProfile;

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
        detail: "Retry runtime, profile, memory, and skill loading",
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
        activeProfile={hermes.activeProfile}
        connected={hermes.connected}
        error={hermes.status?.error}
        isRefreshing={hermes.isRefreshing}
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
              rootPath={hermes.status?.root || hermes.activeProfile.path}
              section={agentSection}
              onBack={() => {
                setAgentDetailProfile(null);
                setAgentSection("overview");
              }}
              onSectionChange={setAgentSection}
            />
          ) : undefined
        }
        selectedProfile={hermes.selectedProfile}
        status={hermes.status}
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
          if (profileName && profileName !== hermes.selectedProfile) {
            hermes.selectProfile(profileName);
          }
          chat.startNewConversation(profileName);
        }}
        onPreviewToggle={togglePreviewPane}
        onEditProfile={(profileName) => {
          if (profileName !== hermes.selectedProfile) {
            hermes.selectProfile(profileName);
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
          if (profileName !== hermes.selectedProfile) {
            hermes.selectProfile(profileName);
          }
          void chat.loadConversation(conversationId, profileName);
        }}
        onSelectProfile={(profileName) => {
          hermes.selectProfile(profileName);
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
          connected={hermes.connected}
          onClose={dismissOnboarding}
          onOpenSettings={() => {
            setAgentDetailProfile(hermes.selectedProfile);
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
    await hermes.refreshHermes();
    await slashCommands.refreshSlashCommands();
    pushNotification({
      tone: hermes.status?.connected ? "success" : "info",
      title: "Connection refreshed",
      message: hermes.status?.connected ? "Iris profile data is current." : "Iris is still waiting for a route.",
    });
  }

  function dismissOnboarding() {
    localStorage.setItem(onboardingStorageKey, "true");
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
    const message = await hermes.runProfileAction(action, name, sourceProfile);
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
          status={hermes.status}
          activeProfile={hermes.activeProfile}
          selectedProfile={hermes.selectedProfile}
          runtimeConfig={hermes.runtimeConfig}
          memory={hermes.memory}
          skills={hermes.skills}
          section={agentSection}
          onDetailProfileChange={setAgentDetailProfile}
          onSectionChange={setAgentSection}
          onSelectProfile={hermes.selectProfile}
          onRuntimeChange={hermes.updateRuntimeConfig}
          onRefresh={() => void hermes.refreshHermes()}
          onProfileAction={hermes.runProfileAction}
          onResetMemory={hermes.resetMemoryFile}
          onSaveMemory={hermes.saveMemoryFile}
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
        connected={hermes.connected}
        profile={hermes.selectedProfile}
        profiles={agentProfiles}
        onProfileChange={hermes.selectProfile}
        requestActive={chat.requestActive}
        onCancel={() => void chat.cancelMessage()}
        modelCatalog={modelCatalog.catalog}
        modelSelection={modelCatalog.draftSelection}
        lockedModelSelection={chat.selectedModelSelection}
        modelLoading={modelCatalog.loading}
        modelError={modelCatalog.error}
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
  try {
    return localStorage.getItem(previewOpenStorageKey) === "true";
  } catch {
    return false;
  }
}

function savePreviewOpenPreference(open: boolean) {
  try {
    localStorage.setItem(previewOpenStorageKey, String(open));
  } catch {
    // Ignore storage failures; the preview toggle still works for this session.
  }
}

function profileActionTitle(action: ProfileAction) {
  if (action === "create") return "Profile created";
  if (action === "clone") return "Profile duplicated";
  if (action === "delete") return "Profile deleted";
  if (action === "rename") return "Profile renamed";
  return "Profile switched";
}

function isProfileActionFailure(message: string) {
  return /\b(error|failed|cannot|already exists|does not exist|enter|invalid)\b/i.test(message);
}

export default App;
