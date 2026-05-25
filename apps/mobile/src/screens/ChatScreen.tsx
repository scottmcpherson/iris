import { useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowDown, Bot, Folder, Zap } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAgentsQuery,
  useCreateSessionMutation,
  useModelCatalogQuery,
  useProjectsQuery,
  useSendMessageMutation,
  useSessionDetailQuery,
  useSlashCommandsQuery,
  sessionKeys,
} from "@iris/iris-query";
import {
  activeRequestCompletedByHistory,
  appendOptimisticSend,
  createClientRequestId,
  formatPromptWithAttachments,
  replaceOptimisticSend,
  sessionTitleFromPrompt,
  toChatMessages,
  type ChatMessage,
} from "@iris/chat-core";
import {
  cancelMessage,
  getEvents,
  getLatestEventCursor,
  type IrisCoreAgent,
  type IrisCoreModelSelection,
  type IrisProject,
} from "@iris/core-client";
import { ChatComposer } from "../components/ChatComposer";
import { ComposerOptionMenu, type ComposerOptionGroup } from "../components/ComposerOptionMenu";
import { MessageBubble } from "../components/MessageBubble";
import { MobileSidebarDrawer, SidebarButton } from "../components/MobileSidebar";
import { type OptionSheetItem } from "../components/OptionSheet";
import { useMobileAttachmentDrafts } from "../chat/mobileAttachments";
import { mergeMobileChatEvent, mobileChatEventInfo, mobileSendMetadata } from "../chat/mobileChat";
import { markMobileSessionRead } from "../chat/sessionReadState";
import {
  TRANSCRIPT_BUTTON_SETTLE_DELAYS_MS,
  TRANSCRIPT_STREAM_SETTLE_DELAYS_MS,
  isTranscriptAtBottom,
} from "../chat/transcriptScroll";
import { useIrisConnection } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";

const HEADER_BAR_HEIGHT = 60;
const NO_PROJECT_ID = "__no-project__";

export function ChatScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();
  const { sessionId: routeSessionId, projectId: routeProjectId } = useLocalSearchParams<{
    sessionId?: string;
    projectId?: string;
  }>();
  const isExistingSession = typeof routeSessionId === "string" && routeSessionId.length > 0;
  const initialProjectId = typeof routeProjectId === "string" ? routeProjectId : "";
  const { client, clientKey } = useIrisConnection();
  const queryClient = useQueryClient();

  // New-session selection state — ignored once a session exists.
  const agentsQuery = useAgentsQuery(client, clientKey);
  const projectsQuery = useProjectsQuery(client, clientKey);
  const createSession = useCreateSessionMutation(client, clientKey);
  const agents = useMemo(() => agentsQuery.data?.agents || [], [agentsQuery.data?.agents]);
  const projects = useMemo(() => projectsQuery.data?.projects || [], [projectsQuery.data?.projects]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialProjectId || null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [createdSessionId, setCreatedSessionId] = useState("");

  const sessionId = isExistingSession ? routeSessionId : createdSessionId;

  const detailQuery = useSessionDetailQuery(client, clientKey, isExistingSession ? routeSessionId : "");
  const sendMutation = useSendMessageMutation(client, clientKey);
  const attachmentDrafts = useMobileAttachmentDrafts();

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;
  const selectedAgent = selectedAgentForState(agents, selectedAgentId, selectedProject) || null;
  // Active agent: existing sessions take it from the loaded session, new chats from the picker.
  const agentId = isExistingSession ? detailQuery.data?.session.agentId || "" : selectedAgent?.id || "";
  const runtimeProfile = isExistingSession
    ? detailQuery.data?.session.runtimeProfile || ""
    : selectedAgent?.runtimeProfile || "";

  const modelCatalogQuery = useModelCatalogQuery(client, clientKey, agentId);
  const slashCommandsQuery = useSlashCommandsQuery(client, clientKey, agentId);

  const [modelSelection, setModelSelection] = useState<IrisCoreModelSelection | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const cursorRef = useRef(0);
  const isAtBottomRef = useRef(true);
  const scrollSettleTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const activeRequestIdRef = useRef("");
  const pollInFlightRef = useRef(false);
  const processedDeliveryIdsRef = useRef<Set<string>>(new Set());
  const [eventCursorReady, setEventCursorReady] = useState(false);
  const [requestActive, setRequestActive] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [composerHeight, setComposerHeight] = useState(0);
  const activeSelectionReadMarkedRef = useRef("");

  const currentModelSelection = modelCatalogQuery.data?.current || null;
  const sessionModelSelection = isExistingSession
    ? modelSelectionFromSession(detailQuery.data?.session.metadata)
    : null;
  const displayedModelSelection = modelSelection || sessionModelSelection || currentModelSelection;

  const historyMessages = useMemo(
    () => toChatMessages(detailQuery.data?.messages || []),
    [detailQuery.data?.messages],
  );

  const pickersLocked = Boolean(sessionId);
  const agentItems = useMemo(() => agentOptions(agents, selectedAgent?.id || ""), [agents, selectedAgent?.id]);
  const projectItems = useMemo(() => projectOptions(projects, selectedProjectId), [projects, selectedProjectId]);
  const modelItems = useMemo(
    () => modelOptions(modelCatalogQuery.data?.providers || [], displayedModelSelection),
    [modelCatalogQuery.data?.providers, displayedModelSelection],
  );
  const modelGroups = useMemo(
    () => modelGroupOptions(modelCatalogQuery.data?.providers || [], displayedModelSelection),
    [modelCatalogQuery.data?.providers, displayedModelSelection],
  );
  const sending = createSession.isPending || sendMutation.isPending;
  const showEmptyPanel = !isExistingSession && messages.length === 0;

  // Existing sessions seed their transcript from history. While a request is active,
  // keep the live stream until history has the completed assistant turn.
  useEffect(() => {
    if (!isExistingSession) return;
    const activeRequestId = activeRequestIdRef.current;
    if (activeRequestId && !activeRequestCompletedByHistory(detailQuery.data?.messages || [], activeRequestId)) {
      return;
    }
    if (activeRequestId) {
      activeRequestIdRef.current = "";
      setRequestActive(false);
    }
    setMessages(historyMessages);
  }, [detailQuery.data?.messages, historyMessages, isExistingSession]);

  useEffect(() => {
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    processedDeliveryIdsRef.current = new Set();
    pollInFlightRef.current = false;
    cursorRef.current = 0;
    setCursor(0);
    setEventCursorReady(!isExistingSession && Boolean(sessionId));
    const timer = setTimeout(() => scrollToLatest(false), 0);
    return () => clearTimeout(timer);
  }, [isExistingSession, sessionId]);

  useEffect(() => {
    if (!isAtBottomRef.current) return undefined;
    const timer = setTimeout(() => scrollToLatest(false, requestActive ? "stream" : "none"), 0);
    return () => clearTimeout(timer);
  }, [messages, requestActive]);

  useEffect(() => {
    return () => {
      for (const timer of scrollSettleTimersRef.current) clearTimeout(timer);
      scrollSettleTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (isExistingSession || !agents.length || selectedAgentId) return;
    const projectAgent = selectedProject ? agents.find((agent) => agent.id === selectedProject.defaultAgentId) : null;
    setSelectedAgentId(projectAgent?.id || agents.find((agent) => agent.isDefault)?.id || agents[0]?.id || "");
  }, [agents, isExistingSession, selectedAgentId, selectedProject]);

  useEffect(() => {
    setModelSelection(null);
  }, [agentId, sessionId]);

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  useEffect(() => {
    if (!client || !sessionId) return;
    const activeSelectionKey = `${clientKey}:${sessionId}`;
    const activeReadState = detailQuery.data?.session.readState;
    if (activeReadState?.state === "read") {
      activeSelectionReadMarkedRef.current = activeSelectionKey;
      return;
    }
    if (activeSelectionReadMarkedRef.current === activeSelectionKey && activeReadState?.state !== "unread") return;
    activeSelectionReadMarkedRef.current = activeSelectionKey;
    markMobileSessionRead({
      client,
      clientKey,
      existingReadState: activeReadState,
      metadata: { reason: "active-selection" },
      queryClient,
      sessionId,
    });
  }, [client, clientKey, detailQuery.data?.session.readState, queryClient, sessionId]);

  // Existing sessions must not poll until the cursor is bootstrapped; otherwise
  // old delivery events replay over the already-loaded history transcript.
  useEffect(() => {
    if (!sessionId || !client) {
      setEventCursorReady(false);
      return undefined;
    }
    if (!isExistingSession) {
      setEventCursorReady(true);
      return undefined;
    }
    let cancelled = false;
    setEventCursorReady(false);
    getLatestEventCursor(client).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        cursorRef.current = result.cursor;
        setCursor(result.cursor);
        setEventCursorReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, isExistingSession, sessionId]);

  useEffect(() => {
    if (!client || !sessionId || !eventCursorReady) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      void pollEvents();
    }, requestActive ? 500 : 2000);
    void pollEvents();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };

    async function pollEvents() {
      if (!client || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const result = await getEvents(client, { after: cursorRef.current, limit: 80, agentId });
        if (!result.ok || cancelled) return;
        if (result.cursor !== cursorRef.current) {
          cursorRef.current = result.cursor;
          setCursor(result.cursor);
        }
        const sessionEvents = result.events
          .filter((item) => item.sessionId === sessionId)
          .sort((left, right) => left.cursor - right.cursor);
        for (const event of sessionEvents) {
          const info = mobileChatEventInfo(event);
          if (processedDeliveryIdsRef.current.has(info.deliveryId)) continue;
          processedDeliveryIdsRef.current.add(info.deliveryId);
          if (processedDeliveryIdsRef.current.size > 500) {
            processedDeliveryIdsRef.current = new Set(
              Array.from(processedDeliveryIdsRef.current).slice(-250),
            );
          }
          setMessages((current) => mergeMobileChatEvent(current, event).messages);
          if (shouldMarkActiveSessionRead(event.type, event.role)) {
            markMobileSessionRead({
              client,
              clientKey,
              existingReadState: detailQuery.data?.session.readState,
              metadata: {
                reason: "active-delivery",
                eventCursor: event.cursor,
              },
              queryClient,
              sessionId,
            });
          }
          if (info.requestFinished && (!activeRequestIdRef.current || info.clientRequestId === activeRequestIdRef.current)) {
            activeRequestIdRef.current = "";
            setRequestActive(false);
            queryClient.invalidateQueries({ queryKey: sessionKeys.all(clientKey) });
            queryClient.invalidateQueries({ queryKey: sessionKeys.detail(clientKey, sessionId) });
          }
        }
      } finally {
        pollInFlightRef.current = false;
      }
    }
  }, [agentId, client, clientKey, detailQuery.data?.session.readState, eventCursorReady, queryClient, requestActive, sessionId]);

  async function send(text: string) {
    if (!client || requestActive || sending) return false;
    if (!isExistingSession && !selectedAgent) return false;
    const prompt = text.trim();
    if (!prompt && !attachmentDrafts.attachments.length) return false;
    const clientRequestId = createClientRequestId();
    let optimisticAppended = false;
    setRequestActive(true);
    activeRequestIdRef.current = clientRequestId;
    isAtBottomRef.current = true;
    setIsAtBottom(true);

    try {
      // New chats have no history to anchor against, so align the cursor before the first send.
      if (!isExistingSession && agentId) {
        const latestCursor = await getLatestEventCursor(client, agentId);
        if (latestCursor.ok) {
          cursorRef.current = latestCursor.cursor;
          setCursor(latestCursor.cursor);
        }
      }
      const uploadedAttachments = await attachmentDrafts.uploadForSend(client, {
        profile: runtimeProfile,
        sessionId,
        messageId: clientRequestId,
      });
      const promptWithAttachments = formatPromptWithAttachments(prompt, uploadedAttachments);
      const optimistic = appendOptimisticSend(messages, prompt, clientRequestId, uploadedAttachments);
      setMessages(optimistic.messages);
      optimisticAppended = true;
      const activeSessionId = sessionId || (await createNewSession(promptWithAttachments, clientRequestId));
      if (!activeSessionId) throw new Error("Iris Core session is unavailable.");
      const result = await sendMutation.mutateAsync({
        sessionId: activeSessionId,
        payload: {
          text: prompt,
          attachments: uploadedAttachments.map((attachment) => ({ id: attachment.id })),
          model: displayedModelSelection,
          clientMessageId: clientRequestId,
          metadata: mobileSendMetadata({
            clientRequestId,
            source: "iris-mobile",
            projectId: selectedProjectId,
            profile: runtimeProfile,
            selectedModel: displayedModelSelection,
            currentModel: currentModelSelection,
          }),
        },
      });
      setMessages((current) => replaceOptimisticSend(current, result, clientRequestId));
      attachmentDrafts.clearAttachments();
      return true;
    } catch (error) {
      setRequestActive(false);
      if (activeRequestIdRef.current === clientRequestId) activeRequestIdRef.current = "";
      if (optimisticAppended || !attachmentDrafts.attachments.length) {
        setMessages((current) => [
          ...current,
          {
            id: `${clientRequestId}-send-error`,
            role: "assistant",
            content: error instanceof Error ? error.message : "Iris Core did not accept the message.",
            clientRequestId,
            streaming: false,
          },
        ]);
      }
      return false;
    }
  }

  async function createNewSession(prompt: string, clientRequestId: string) {
    if (!selectedAgent) return "";
    const result = await createSession.mutateAsync({
      agentId: selectedAgent.id,
      title: sessionTitleFromPrompt(prompt),
      projectId: selectedProjectId,
      metadata: {
        source: "iris-mobile",
        clientRequestId,
        ...(displayedModelSelection?.model ? { model: displayedModelSelection.model } : {}),
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
      },
    });
    setCreatedSessionId(result.session.id);
    return result.session.id;
  }

  async function cancelActiveRequest() {
    if (!client || !sessionId) {
      setRequestActive(false);
      return;
    }
    await cancelMessage(client, sessionId);
    setRequestActive(false);
    activeRequestIdRef.current = "";
  }

  function selectAgent(id: string) {
    if (!requestActive) setSelectedAgentId(id);
  }

  function selectProject(id: string) {
    if (requestActive) return;
    const nextProjectId = id === NO_PROJECT_ID ? null : id;
    setSelectedProjectId(nextProjectId);
    const nextProject = projects.find((project) => project.id === nextProjectId) || null;
    if (nextProject?.defaultAgentId) setSelectedAgentId(nextProject.defaultAgentId);
  }

  function selectModel(id: string) {
    const [provider, model] = id.split("\n");
    if (!model) return;
    const providerRow = modelCatalogQuery.data?.providers.find((item) => item.slug === provider);
    setModelSelection({ provider, providerName: providerRow?.name, model });
  }

  function clearScrollSettleTimers() {
    for (const timer of scrollSettleTimersRef.current) clearTimeout(timer);
    scrollSettleTimersRef.current = [];
  }

  function scrollToLatest(animated = true, settle: "none" | "stream" | "button" = "none") {
    listRef.current?.scrollToEnd({ animated });
    if (settle === "none") return;
    clearScrollSettleTimers();
    const delays = settle === "button" ? TRANSCRIPT_BUTTON_SETTLE_DELAYS_MS : TRANSCRIPT_STREAM_SETTLE_DELAYS_MS;
    scrollSettleTimersRef.current = delays.map((delay) =>
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: false });
      }, delay),
    );
  }

  function handleTranscriptScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const nextIsAtBottom = isTranscriptAtBottom({
      contentHeight: contentSize.height,
      layoutHeight: layoutMeasurement.height,
      offsetY: contentOffset.y,
    });
    if (nextIsAtBottom === isAtBottomRef.current) return;
    isAtBottomRef.current = nextIsAtBottom;
    setIsAtBottom(nextIsAtBottom);
  }

  const agentValue = isExistingSession
    ? detailQuery.data?.session.runtimeProfile || "default"
    : selectedAgent?.runtimeProfile || selectedAgent?.displayName || "Default";
  const projectValue = isExistingSession
    ? projectLabelFromSession(detailQuery.data?.session.metadata)
    : selectedProject?.name || "No project";

  const composerControls = (
    <>
      <ComposerOptionMenu
        systemImage="sparkles"
        fallbackIcon={<Bot color={theme.colors.textMuted} size={20} />}
        title="Agent"
        value={agentValue}
        items={agentItems}
        showValue={false}
        showChevron={false}
        disabled={isExistingSession || !client || agents.length < 2 || requestActive || pickersLocked}
        onSelect={selectAgent}
      />
      <ComposerOptionMenu
        systemImage="folder"
        fallbackIcon={<Folder color={theme.colors.textMuted} size={20} />}
        title="Project"
        value={projectValue}
        items={projectItems}
        showValue={false}
        showChevron={false}
        disabled={isExistingSession || !client || requestActive || pickersLocked}
        onSelect={selectProject}
      />
    </>
  );

  const composerTrailingControls = (
    <ComposerOptionMenu
      systemImage="bolt"
      fallbackIcon={<Zap color={theme.colors.textMuted} size={20} />}
      title="Model"
      value={displayedModelSelection?.model || "Default"}
      items={modelItems}
      groups={modelGroups}
      emptyLabel="No model catalog available."
      showIcon={false}
      showChevron={false}
      disabled={!client || modelItems.length === 0 || requestActive}
      onSelect={selectModel}
    />
  );

  const listHeader = (
    <View style={styles.listStatus}>
      {!client ? (
        <Text style={styles.empty}>{isExistingSession ? "Reconnect before chatting." : "Reconnect before starting a chat."}</Text>
      ) : null}
      {isExistingSession && detailQuery.isLoading ? <ActivityIndicator color={theme.colors.textMuted} /> : null}
      {isExistingSession && detailQuery.error ? <Text style={styles.error}>{detailQuery.error.message}</Text> : null}
      {!isExistingSession && (agentsQuery.isLoading || projectsQuery.isLoading) ? (
        <ActivityIndicator color={theme.colors.textMuted} />
      ) : null}
      {!isExistingSession && agentsQuery.error ? <Text style={styles.error}>{agentsQuery.error.message}</Text> : null}
      {!isExistingSession && projectsQuery.error ? <Text style={styles.error}>{projectsQuery.error.message}</Text> : null}
      {showEmptyPanel ? (
        <View style={styles.emptyPanel}>
          <Text style={styles.emptyTitle}>What should we work on?</Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <MobileSidebarDrawer
      open={sidebarOpen}
      onClose={() => setSidebarOpen(false)}
      onOpen={() => setSidebarOpen(true)}
      selectedSessionId={sessionId}
    >
      <View style={styles.root}>
        <FlatList
          ref={listRef}
          data={messages}
          style={styles.list}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <MessageBubble message={item} client={client} />}
          onScroll={handleTranscriptScroll}
          scrollEventThrottle={16}
          onContentSizeChange={() => {
            if (isAtBottomRef.current) scrollToLatest(false, requestActive ? "stream" : "none");
          }}
          onLayout={() => {
            if (isAtBottomRef.current) scrollToLatest(false, "stream");
          }}
          contentContainerStyle={[
            styles.messages,
            showEmptyPanel ? styles.emptyMessages : null,
            { paddingTop: insets.top + HEADER_BAR_HEIGHT + theme.spacing[3] },
          ]}
          ListHeaderComponent={listHeader}
          // Bottom breathing room lives in a footer, not contentContainerStyle.paddingBottom,
          // because FlatList.scrollToEnd counts the footer length but ignores container padding —
          // padding here leaves an unreachable gap below the last message after a jump-to-bottom.
          ListFooterComponent={<View style={styles.messagesFooter} />}
        />
        <View pointerEvents="box-none" style={[styles.header, { height: insets.top + HEADER_BAR_HEIGHT }]}>
          <View pointerEvents="box-none" style={[styles.headerRow, { paddingTop: insets.top }]}>
            <SidebarButton open={sidebarOpen} onPress={() => setSidebarOpen((current) => !current)} />
          </View>
        </View>
        {!isAtBottom ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jump to latest message"
            onPress={() => {
              isAtBottomRef.current = true;
              setIsAtBottom(true);
              scrollToLatest(true, "button");
            }}
            style={({ pressed }) => [
              styles.scrollBottomButton,
              { bottom: Math.max(theme.spacing[4], composerHeight + theme.spacing[2]) },
              pressed ? styles.pressed : null,
            ]}
          >
            <ArrowDown color={theme.colors.textSecondary} size={18} />
          </Pressable>
        ) : null}
        <View onLayout={(event) => setComposerHeight(event.nativeEvent.layout.height)}>
          <ChatComposer
            disabled={!client || sending || (!isExistingSession && !selectedAgent)}
            requestActive={requestActive}
            controls={composerControls}
            trailingControls={composerTrailingControls}
            slashCommands={slashCommandsQuery.data?.commands || []}
            slashCommandsLoading={slashCommandsQuery.isFetching}
            slashCommandsError={slashCommandsQuery.error instanceof Error ? slashCommandsQuery.error.message : null}
            attachments={attachmentDrafts.attachments}
            onAddAttachment={attachmentDrafts.addPickedFiles}
            onPickPhoto={attachmentDrafts.addPhotosFromLibrary}
            onTakePhoto={attachmentDrafts.takePhoto}
            onRemoveAttachment={attachmentDrafts.removeAttachment}
            onVoiceRecording={attachmentDrafts.addVoiceRecording}
            placeholder="Ask anything"
            onCancel={() => void cancelActiveRequest()}
            onSend={(value) => send(value)}
          />
        </View>
      </View>
    </MobileSidebarDrawer>
  );
}

function selectedAgentForState(
  agents: IrisCoreAgent[],
  selectedAgentId: string,
  selectedProject: IrisProject | null,
) {
  return (
    agents.find((agent) => agent.id === selectedAgentId) ||
    (selectedProject ? agents.find((agent) => agent.id === selectedProject.defaultAgentId) : null) ||
    agents.find((agent) => agent.isDefault) ||
    agents[0] ||
    null
  );
}

function agentOptions(agents: IrisCoreAgent[], selectedAgentId: string): OptionSheetItem[] {
  return agents.map((agent) => ({
    id: agent.id,
    label: agent.runtimeProfile || agent.displayName,
    detail: agent.displayName,
    selected: agent.id === selectedAgentId,
  }));
}

function projectOptions(projects: IrisProject[], selectedProjectId: string | null): OptionSheetItem[] {
  return [
    {
      id: NO_PROJECT_ID,
      label: "No project",
      detail: "Start an unprojected session.",
      selected: !selectedProjectId,
    },
    ...projects.map((project) => ({
      id: project.id,
      label: project.name,
      detail: project.slug,
      selected: project.id === selectedProjectId,
    })),
  ];
}

function modelSelectionFromSession(metadata: Record<string, unknown> | undefined): IrisCoreModelSelection | null {
  const model = typeof metadata?.model === "string" ? metadata.model : "";
  return model ? { provider: "", model } : null;
}

function projectLabelFromSession(metadata: Record<string, unknown> | undefined) {
  return typeof metadata?.projectId === "string" && metadata.projectId ? "Project" : "No project";
}

function modelOptions(
  providers: { slug: string; name: string; models: string[] }[],
  selection: IrisCoreModelSelection | null,
): OptionSheetItem[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      id: `${provider.slug}\n${model}`,
      label: model,
      detail: provider.name,
      selected: selection?.provider === provider.slug && selection.model === model,
    })),
  );
}

function modelGroupOptions(
  providers: { slug: string; name: string; models: string[] }[],
  selection: IrisCoreModelSelection | null,
): ComposerOptionGroup[] {
  return providers.map((provider) => ({
    id: provider.slug,
    title: provider.name,
    items: provider.models.map((model) => ({
      id: `${provider.slug}\n${model}`,
      label: model,
      selected: selection?.provider === provider.slug && selection.model === model,
    })),
  }));
}

function shouldMarkActiveSessionRead(eventType: string, role: string) {
  return role === "assistant" && eventType === "message.assistant.completed";
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.colors.screen,
    },
    list: {
      flex: 1,
    },
    messages: {
      paddingHorizontal: theme.spacing[4],
      gap: theme.spacing[3],
    },
    messagesFooter: {
      height: theme.spacing[8],
    },
    emptyMessages: {
      flexGrow: 1,
      justifyContent: "center",
    },
    header: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      zIndex: 1,
    },
    headerRow: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: theme.spacing[4],
      paddingBottom: theme.spacing[2],
    },
    listStatus: {
      gap: theme.spacing[2],
      paddingBottom: theme.spacing[3],
    },
    emptyPanel: {
      alignItems: "center",
    },
    emptyTitle: {
      color: theme.colors.text,
      fontSize: 22,
      fontWeight: "700",
      textAlign: "center",
    },
    empty: {
      color: theme.colors.textMuted,
      fontSize: 15,
      lineHeight: 21,
    },
    error: {
      color: theme.colors.danger,
      fontSize: 14,
      lineHeight: 20,
    },
    scrollBottomButton: {
      position: "absolute",
      left: "50%",
      zIndex: 3,
      width: 38,
      height: 38,
      marginLeft: -19,
      borderRadius: 19,
      borderWidth: 1,
      borderColor: theme.colors.borderStrong,
      backgroundColor: theme.colors.surfaceElevated,
      alignItems: "center",
      justifyContent: "center",
    },
    pressed: {
      opacity: 0.72,
    },
  });
}
