import { router, useLocalSearchParams, type Href } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, BackHandler, Image, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View, type KeyboardEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Menu, Search, Settings, SquarePen, X } from "lucide-react-native";
import { GlassButton } from "./GlassButton";
import { GlassSurface } from "./GlassSurface";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  projectSessionsQueryOptions,
  useDeleteSessionMutation,
  useProjectsQuery,
  useRenameSessionMutation,
  useSessionsQuery,
} from "@iris/iris-query";
import { type IrisCoreSession, type IrisProject } from "@iris/core-client";
import { markMobileSessionRead, mobileSessionShowsUnread } from "../chat/sessionReadState";
import {
  mobileSidebarConnectionAccessibilityLabel,
  mobileSidebarConnectionStatusLabel,
} from "../connection/mobileConnectionStatus";
import { useIrisConnection } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";
import { useMobileSidebarActions } from "./MobileSidebarContext";
import {
  buildMobileSidebarModel,
  loadMobileSidebarCollapsedSections,
  loadMobileSidebarCollapsedProjects,
  loadMobileSidebarPinnedSessions,
  mobileSidebarTimeLabel,
  projectSessionPinKey,
  runtimeProfileForSession,
  saveMobileSidebarCollapsedSections,
  saveMobileSidebarCollapsedProjects,
  saveMobileSidebarPinnedSessions,
  unprojectedSessionPinKey,
  type MobileSidebarSectionId,
} from "./mobileSidebarModel";
import { MobileSettingsModal } from "./MobileSettingsModal";
import { NativeSessionContextMenu } from "./NativeSessionRow";
import { SessionActionMenu, SessionRenameDialog, type SessionMenuAnchor } from "./SessionActionMenu";

const SESSION_ROW_HEIGHT = 38;
const PROJECT_ACTION_SIZE = 38;
const PROJECT_ACTION_ICON_SIZE = 17;
const SIDEBAR_RIGHT_RAIL_INSET = (PROJECT_ACTION_SIZE - PROJECT_ACTION_ICON_SIZE) / 2;
const DRAWER_OPEN_DURATION_MS = 320;
const DRAWER_CLOSE_DURATION_MS = 180;
const SIDEBAR_SELECTION_NAVIGATION_DELAY_MS = DRAWER_CLOSE_DURATION_MS;
// Height (below the safe-area top) of the page header row kept clear of the close
// overlay so the nav toggle stays directly pressable while the sidebar is open.
const PAGE_HEADER_TAP_INSET = 60;
// iOS gets the real SwiftUI `.contextMenu`, but the visible row remains React
// Native-owned so the sidebar scroll layout stays stable.
const useNativeContextMenu = Platform.OS === "ios";
const irisSidebarIcon = require("../../../desktop/src/assets/iris-sidebar-icon-borderless.png");

type MobileSidebarProps = {
  open: boolean;
  onClose: () => void;
};

type MobileSidebarDrawerProps = {
  open: boolean;
  onClose: () => void;
  onOpen?: () => void;
  selectedSessionId?: string;
  children: ReactNode;
};

type SessionMenuTarget = {
  session: IrisCoreSession;
  pinned: boolean;
  pinKey: string;
  anchor: SessionMenuAnchor;
};

export function SidebarButton({ open = false, onPress }: { open?: boolean; onPress: () => void }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const accessibilityLabel = open ? "Close sidebar" : "Open sidebar";
  const glass = isLiquidGlassAvailable();

  return (
    <GlassButton
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={styles.glassButton}
      fallbackStyle={styles.roundButtonFill}
    >
      <Menu color={glass ? theme.colors.text : theme.colors.textMuted} size={24} />
    </GlassButton>
  );
}

export function MobileSidebarDrawer({
  open,
  onClose,
  onOpen,
  selectedSessionId,
  children,
}: MobileSidebarDrawerProps) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(360, Math.max(292, width * 0.78));
  const drawerOffset = Math.min(width - 64, panelWidth + theme.spacing[3]);
  const progress = useSharedValue(open ? 1 : 0);
  const dragStart = useSharedValue(1);

  useEffect(() => {
    progress.set(withTiming(open ? 1 : 0, {
      duration: open ? DRAWER_OPEN_DURATION_MS : DRAWER_CLOSE_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    }));
  }, [open, progress]);

  const closeGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .activeOffsetX([-12, 12])
      .onBegin(() => {
        dragStart.value = progress.value;
      })
      .onUpdate((event) => {
        const next = dragStart.value + event.translationX / drawerOffset;
        progress.value = Math.min(1, Math.max(0, next));
      })
      .onEnd((event) => {
        const shouldClose = progress.value < 0.6 || event.velocityX < -500;
        progress.value = withTiming(shouldClose ? 0 : 1, {
          duration: 240,
          easing: Easing.out(Easing.cubic),
        });
        if (shouldClose) runOnJS(onClose)();
      });
    const tap = Gesture.Tap().onEnd(() => {
      runOnJS(onClose)();
    });
    return Gesture.Exclusive(pan, tap);
  }, [dragStart, drawerOffset, onClose, progress]);

  const openGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-15, 15])
        .onBegin(() => {
          dragStart.value = progress.value;
        })
        .onUpdate((event) => {
          const next = dragStart.value + event.translationX / drawerOffset;
          progress.value = Math.min(1, Math.max(0, next));
        })
        .onEnd((event) => {
          const shouldOpen = progress.value > 0.4 || event.velocityX > 500;
          progress.value = withTiming(shouldOpen ? 1 : 0, {
            duration: 240,
            easing: Easing.out(Easing.cubic),
          });
          if (shouldOpen && onOpen) runOnJS(onOpen)();
        }),
    [dragStart, drawerOffset, onOpen, progress],
  );

  useEffect(() => {
    if (!open || Platform.OS === "web") return undefined;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, open]);

  const pageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * drawerOffset }],
  }));

  return (
    <View style={styles.drawerRoot}>
      <MobileSidebar open={open} onClose={onClose} panelWidth={panelWidth} selectedSessionId={selectedSessionId} />
      <Animated.View
        renderToHardwareTextureAndroid
        shouldRasterizeIOS
        style={[styles.pageLayer, pageStyle]}
      >
        {children}
        {open ? (
          <GestureDetector gesture={closeGesture}>
            {/* Leave the page's header row uncovered so the nav toggle receives its own
                press (and plays its press-expand) when tapped to close, rather than the
                tap being swallowed by this full-page close overlay. */}
            <Animated.View
              accessibilityRole="button"
              accessibilityLabel="Close sidebar"
              style={[styles.pageCloseLayer, { top: insets.top + PAGE_HEADER_TAP_INSET }]}
            />
          </GestureDetector>
        ) : onOpen ? (
          <GestureDetector gesture={openGesture}>
            <Animated.View style={styles.pageEdge} />
          </GestureDetector>
        ) : null}
      </Animated.View>
    </View>
  );
}

function MobileSidebar({
  open,
  onClose,
  panelWidth,
  selectedSessionId: activeSessionId,
}: MobileSidebarProps & {
  panelWidth: number;
  selectedSessionId?: string;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const keyboardOffset = useSharedValue(0);
  const keyboardStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -keyboardOffset.value }] }));
  const { client, clientKey, state } = useIrisConnection();
  const { startSessionTransition } = useMobileSidebarActions();
  const queryClient = useQueryClient();
  const [settingsVisible, setSettingsVisible] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [bottomBarHeight, setBottomBarHeight] = useState(0);
  const [collapsedSections, setCollapsedSections] = useState(
    () => loadMobileSidebarCollapsedSections(),
  );
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(
    () => loadMobileSidebarCollapsedProjects(),
  );
  const { sessionId: routeSessionId } = useLocalSearchParams<{ sessionId?: string }>();
  const selectedSessionId = activeSessionId || (typeof routeSessionId === "string" ? routeSessionId : "");
  const [pinnedSessions, setPinnedSessions] = useState(() => loadMobileSidebarPinnedSessions());
  const [menuTarget, setMenuTarget] = useState<SessionMenuTarget | null>(null);
  const [menuError, setMenuError] = useState("");
  const [renameTarget, setRenameTarget] = useState<IrisCoreSession | null>(null);
  const [renameError, setRenameError] = useState("");
  const renameMutation = useRenameSessionMutation(client, clientKey);
  const deleteMutation = useDeleteSessionMutation(client, clientKey);
  const sessionsQuery = useSessionsQuery(client, clientKey, "default");
  const projectsQuery = useProjectsQuery(client, clientKey);
  const projects = projectsQuery.data?.projects || [];
  const projectSessionQueries = useQueries({
    queries: projects.map((project) => ({
      ...projectSessionsQueryOptions(client, clientKey, project.id),
      enabled: Boolean(open && client && project.id),
    })),
  });
  const sessions = sessionsQuery.data?.sessions || [];
  const sessionsByProject = projects.reduce<Record<string, IrisCoreSession[]>>((items, project, index) => {
    items[project.id] = projectSessionQueries[index]?.data?.sessions || [];
    return items;
  }, {});
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const searching = normalizedQuery.length > 0;
  const sessionMatchesQuery = (session: IrisCoreSession) =>
    (session.title || "").toLowerCase().includes(normalizedQuery);
  const visibleSessions = searching ? sessions.filter(sessionMatchesQuery) : sessions;
  const visibleSessionsByProject = searching
    ? Object.fromEntries(
        Object.entries(sessionsByProject).map(([id, list]) => [id, list.filter(sessionMatchesQuery)]),
      )
    : sessionsByProject;
  const visibleProjects = searching
    ? projects.filter((project) => (visibleSessionsByProject[project.id]?.length ?? 0) > 0)
    : projects;
  const sidebarModel = buildMobileSidebarModel({
    pinnedSessions,
    projects: visibleProjects,
    sessions: visibleSessions,
    sessionsByProject: visibleSessionsByProject,
  });
  const searchActive = searchFocused || searching;
  const noSearchResults =
    searching &&
    !sidebarModel.pinnedSessions.length &&
    !sidebarModel.projectNodes.length &&
    !sidebarModel.unprojectedSessions.length;
  const projectSessionsLoading = projectSessionQueries.some((query) => query.isLoading || query.isFetching);
  const projectSessionError = projectSessionQueries.find((query) => query.error)?.error;
  const statusDotStyle = state.status === "connected"
    ? styles.statusDotReady
    : state.status === "connecting"
      ? styles.statusDotConnecting
      : state.status === "unpaired"
        ? styles.statusDotIdle
        : styles.statusDotOffline;

  useEffect(() => {
    if (Platform.OS === "web") return undefined;

    function syncToKeyboard(event: KeyboardEvent) {
      // Only lift the bottom bar while the sidebar is open — that keyboard is
      // the sidebar search. When closed, the chat composer's keyboard must not
      // lift the (hidden) bar, or it would lag down when the sidebar opens.
      if (!open) return;
      const keyboardHeight = Math.max(0, windowHeight - event.endCoordinates.screenY);
      keyboardOffset.value = withTiming(Math.max(0, keyboardHeight - insets.bottom), {
        duration: event.duration || 250,
        easing: Easing.out(Easing.cubic),
      });
    }

    function resetKeyboardOffset(event?: KeyboardEvent) {
      keyboardOffset.value = withTiming(0, {
        duration: event?.duration || 220,
        easing: Easing.out(Easing.cubic),
      });
    }

    const showSubscription = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow",
      syncToKeyboard,
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      resetKeyboardOffset,
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [insets.bottom, keyboardOffset, open, windowHeight]);

  function navigate(path: Href) {
    onClose();
    setTimeout(() => router.replace(path), SIDEBAR_SELECTION_NAVIGATION_DELAY_MS);
  }

  function newChatHref(projectId?: string): Href {
    const params = {
      draftId: String(Date.now()),
      ...(projectId ? { projectId } : {}),
    };
    return { pathname: "/sessions/new", params };
  }

  function startProjectChat(projectId: string) {
    setCollapsedProjects((current) => {
      if (!current[projectId]) return current;
      const next = { ...current, [projectId]: false };
      saveMobileSidebarCollapsedProjects(next);
      return next;
    });
    navigate(newChatHref(projectId));
  }

  function clearSearch() {
    setSearchQuery("");
    searchInputRef.current?.blur();
  }

  function openSession(session: IrisCoreSession) {
    if (session.id === selectedSessionId) {
      onClose();
      setTimeout(() => markSessionRead(session), SIDEBAR_SELECTION_NAVIGATION_DELAY_MS);
      return;
    }
    startSessionTransition(session.id);
    onClose();
    setTimeout(() => {
      markSessionRead(session);
      router.replace({ pathname: "/sessions/[sessionId]", params: { sessionId: session.id } });
    }, SIDEBAR_SELECTION_NAVIGATION_DELAY_MS);
  }

  function markSessionRead(session: IrisCoreSession) {
    if (!client || session.readState?.state !== "unread") return;
    markMobileSessionRead({
      client,
      clientKey,
      existingReadState: session.readState,
      metadata: { reason: "mobile-sidebar-selection" },
      queryClient,
      sessionId: session.id,
    });
  }

  function openSessionMenu(target: SessionMenuTarget) {
    setMenuError("");
    setMenuTarget(target);
  }

  function closeSessionMenu() {
    setMenuTarget(null);
    setMenuError("");
  }

  function toggleSessionPinned(pinKey: string) {
    setPinnedSessions((current) => {
      const next = { ...current };
      if (next[pinKey]) {
        delete next[pinKey];
      } else {
        next[pinKey] = true;
      }
      saveMobileSidebarPinnedSessions(next);
      return next;
    });
  }

  function handlePin() {
    if (menuTarget) toggleSessionPinned(menuTarget.pinKey);
    closeSessionMenu();
  }

  function handleRename() {
    if (menuTarget) {
      setRenameTarget(menuTarget.session);
      setRenameError("");
    }
    setMenuTarget(null);
    setMenuError("");
  }

  async function submitRename(title: string) {
    if (!renameTarget) return;
    const clean = title.trim();
    if (!clean) {
      setRenameError("Enter a session name.");
      return;
    }
    setRenameError("");
    try {
      await renameMutation.mutateAsync({ sessionId: renameTarget.id, title: clean });
      setRenameTarget(null);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "Could not rename this session.");
    }
  }

  async function handleDelete() {
    if (!menuTarget) return;
    const target = menuTarget;
    setMenuError("");
    try {
      await deleteMutation.mutateAsync(target.session.id);
      if (target.pinned) {
        setPinnedSessions((current) => {
          if (!current[target.pinKey]) return current;
          const next = { ...current };
          delete next[target.pinKey];
          saveMobileSidebarPinnedSessions(next);
          return next;
        });
      }
      closeSessionMenu();
      if (selectedSessionId === target.session.id) {
        onClose();
        router.replace("/sessions/new");
      }
    } catch (error) {
      setMenuError(error instanceof Error ? error.message : "Could not delete this session.");
    }
  }

  // Direct actions for the native context menu (iOS). The JS modal path uses
  // onLongPress + the menu's own two-step delete instead.
  function startSessionRename(session: IrisCoreSession) {
    setRenameTarget(session);
    setRenameError("");
  }

  function confirmDeleteSession(session: IrisCoreSession, pinKey: string, pinned: boolean) {
    Alert.alert(
      "Delete session?",
      `“${session.title || "Untitled session"}” will be permanently deleted.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void runSessionDelete(session, pinKey, pinned);
          },
        },
      ],
    );
  }

  async function runSessionDelete(session: IrisCoreSession, pinKey: string, pinned: boolean) {
    try {
      await deleteMutation.mutateAsync(session.id);
      if (pinned) {
        setPinnedSessions((current) => {
          if (!current[pinKey]) return current;
          const next = { ...current };
          delete next[pinKey];
          saveMobileSidebarPinnedSessions(next);
          return next;
        });
      }
      if (selectedSessionId === session.id) {
        onClose();
        router.replace("/sessions/new");
      }
    } catch (error) {
      Alert.alert("Delete failed", error instanceof Error ? error.message : "Could not delete this session.");
    }
  }

  function sessionRowActions(session: IrisCoreSession, pinned: boolean, pinKey: string) {
    return {
      pinned,
      onPin: () => toggleSessionPinned(pinKey),
      onRename: () => startSessionRename(session),
      onDelete: () => confirmDeleteSession(session, pinKey, pinned),
      onLongPress: (anchor: SessionMenuAnchor) => openSessionMenu({ session, pinned, pinKey, anchor }),
    };
  }

  function toggleProjectCollapsed(projectId: string) {
    setCollapsedProjects((current) => {
      const next = { ...current, [projectId]: !current[projectId] };
      saveMobileSidebarCollapsedProjects(next);
      return next;
    });
  }

  function toggleSectionCollapsed(section: MobileSidebarSectionId) {
    setCollapsedSections((current) => {
      const next = { ...current, [section]: !current[section] };
      saveMobileSidebarCollapsedSections(next);
      return next;
    });
  }

  return (
    <SafeAreaView
      accessibilityElementsHidden={!open}
      edges={["top", "left", "right"]}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={[styles.panel, !open ? styles.panelClosed : null, { width: panelWidth }]}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open settings. ${mobileSidebarConnectionAccessibilityLabel(state)}`}
          onPress={() => setSettingsVisible(true)}
          style={({ pressed }) => [styles.brandButton, pressed ? styles.pressed : null]}
        >
          <Image source={irisSidebarIcon} resizeMode="cover" style={styles.brandMark} />
          <View style={styles.brandCopy}>
            <Text style={styles.brand} numberOfLines={1}>Iris</Text>
            <View style={styles.brandStatusRow}>
              <View style={[styles.statusDot, statusDotStyle]} />
              <Text style={styles.brandStatusText} numberOfLines={1}>
                {mobileSidebarConnectionStatusLabel(state)}
              </Text>
            </View>
          </View>
        </Pressable>
      </View>

      <ScrollView
        style={styles.sidebarScroll}
        contentContainerStyle={[styles.sidebarScrollInner, { paddingBottom: bottomBarHeight }]}
        showsVerticalScrollIndicator={false}
      >
        {!client ? <Text style={styles.empty}>Reconnect to load the sidebar.</Text> : null}
        {sessionsQuery.isLoading || projectsQuery.isLoading ? <Text style={styles.empty}>Loading sidebar...</Text> : null}
        {sessionsQuery.error ? <Text style={styles.error}>{sessionsQuery.error.message}</Text> : null}
        {projectsQuery.error ? <Text style={styles.error}>{projectsQuery.error.message}</Text> : null}
        {projectSessionError instanceof Error ? <Text style={styles.error}>{projectSessionError.message}</Text> : null}

        {sidebarModel.pinnedSessions.length ? (
          <SidebarSection
            collapsed={searching ? false : collapsedSections.pinned}
            sectionId="pinned"
            title="Pinned"
            onToggle={() => toggleSectionCollapsed("pinned")}
          >
            {sidebarModel.pinnedSessions.map((item) => (
              <SidebarSessionRow
                key={`pinned:${item.pinKey}`}
                session={item.session}
                selected={item.session.id === selectedSessionId}
                onPress={() => openSession(item.session)}
                {...sessionRowActions(item.session, true, item.pinKey)}
              />
            ))}
          </SidebarSection>
        ) : null}

        {!searching || sidebarModel.projectNodes.length ? (
        <SidebarSection
          collapsed={searching ? false : collapsedSections.projects}
          sectionId="projects"
          title="Projects"
          onToggle={() => toggleSectionCollapsed("projects")}
        >
          {sidebarModel.projectNodes.length ? (
            sidebarModel.projectNodes.map((node, index) => (
              <View key={node.project.id} style={styles.projectNode}>
                <SidebarProjectRow
                  collapsed={Boolean(collapsedProjects[node.project.id])}
                  disabled={!client}
                  project={node.project}
                  onNewChat={() => startProjectChat(node.project.id)}
                  onToggle={() => toggleProjectCollapsed(node.project.id)}
                />
                {!collapsedProjects[node.project.id] && node.sessions.length ? (
                  <View style={styles.projectSessions}>
                    {node.sessions.map((session) => (
                      <SidebarSessionRow
                        key={`project:${node.project.id}:${session.id}`}
                        session={session}
                        selected={session.id === selectedSessionId}
                        nested
                        onPress={() => openSession(session)}
                        {...sessionRowActions(session, false, projectSessionPinKey(node.project.id, session.id))}
                      />
                    ))}
                  </View>
                ) : !collapsedProjects[node.project.id] && (projectSessionQueries[index]?.isLoading || projectSessionQueries[index]?.isFetching) ? (
                  <Text style={styles.nestedEmpty}>Loading sessions...</Text>
                ) : null}
              </View>
            ))
          ) : !searching ? (
            <Text style={styles.empty}>No projects yet.</Text>
          ) : null}
          {projects.length > 0 && projectSessionsLoading ? <Text style={styles.empty}>Loading project sessions...</Text> : null}
        </SidebarSection>
        ) : null}

        {!searching || sidebarModel.unprojectedSessions.length ? (
        <SidebarSection
          collapsed={searching ? false : collapsedSections.chats}
          sectionId="chats"
          title="Sessions"
          onToggle={() => toggleSectionCollapsed("chats")}
        >
          {sidebarModel.unprojectedSessions.length ? (
            sidebarModel.unprojectedSessions.map((session) => (
              <SidebarSessionRow
                key={`unprojected:${session.id}`}
                session={session}
                selected={session.id === selectedSessionId}
                onPress={() => openSession(session)}
                {...sessionRowActions(session, false, unprojectedSessionPinKey(runtimeProfileForSession(session), session.id))}
              />
            ))
          ) : !searching ? (
            <Text style={styles.empty}>No unprojected sessions yet.</Text>
          ) : null}
        </SidebarSection>
        ) : null}

        {noSearchResults ? <Text style={styles.empty}>No sessions match “{searchQuery.trim()}”.</Text> : null}
      </ScrollView>

      <Animated.View
        onLayout={(event) => setBottomBarHeight(event.nativeEvent.layout.height)}
        style={[styles.bottomBar, keyboardStyle, { paddingBottom: Math.max(theme.spacing[4], insets.bottom + theme.spacing[2]) }]}
      >
        <GlassSurface style={styles.searchPill} fallbackStyle={styles.searchPillFill}>
          {/* Whole pill is tappable: focus the input even when the tap lands on
              the icon, padding, or the empty rows above/below the text line. */}
          <Pressable style={styles.searchPressable} onPress={() => searchInputRef.current?.focus()}>
            <Search color={theme.colors.textMuted} size={18} />
            <TextInput
              ref={searchInputRef}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search"
              placeholderTextColor={theme.colors.textMuted}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              style={styles.searchInput}
            />
          </Pressable>
        </GlassSurface>
        {searchActive ? (
          <GlassButton
            accessibilityLabel="Clear search"
            onPress={clearSearch}
            style={styles.bottomCircle}
            fallbackStyle={styles.bottomCircleFill}
          >
            <X color={theme.colors.text} size={22} />
          </GlassButton>
        ) : (
          <>
            <GlassButton
              accessibilityLabel="Open settings"
              onPress={() => setSettingsVisible(true)}
              style={styles.bottomCircle}
              fallbackStyle={styles.bottomCircleFill}
            >
              <Settings color={theme.colors.text} size={21} />
            </GlassButton>
            <GlassButton
              accessibilityLabel="Start new chat"
              disabled={!client}
              onPress={() => navigate(newChatHref())}
              style={[styles.bottomCircle, !client ? styles.disabled : null]}
              fallbackStyle={styles.bottomCircleFill}
            >
              <SquarePen color={theme.colors.text} size={20} />
            </GlassButton>
          </>
        )}
      </Animated.View>
      <MobileSettingsModal visible={settingsVisible} onClose={() => setSettingsVisible(false)} />
      <SessionActionMenu
        visible={Boolean(menuTarget)}
        session={menuTarget?.session ?? null}
        pinned={menuTarget?.pinned ?? false}
        anchor={menuTarget?.anchor ?? null}
        busy={deleteMutation.isPending}
        error={menuError}
        onPin={handlePin}
        onRename={handleRename}
        onDelete={handleDelete}
        onClose={closeSessionMenu}
      />
      <SessionRenameDialog
        session={renameTarget}
        busy={renameMutation.isPending}
        error={renameError}
        onSubmit={submitRename}
        onClose={() => {
          setRenameTarget(null);
          setRenameError("");
        }}
      />
    </SafeAreaView>
  );
}

function SidebarSection({
  children,
  collapsed,
  onToggle,
  sectionId,
  title,
}: {
  children: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  sectionId: MobileSidebarSectionId;
  title: string;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const ChevronIcon = collapsed ? ChevronRight : ChevronDown;
  return (
    <View style={styles.section}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${title.toLowerCase()} section`}
        accessibilityState={{ expanded: !collapsed }}
        nativeID={`mobile-sidebar-${sectionId}-section-toggle`}
        onPress={onToggle}
        style={({ pressed }) => [styles.sectionToggle, pressed ? styles.pressed : null]}
      >
        <Text style={styles.sectionLabel}>{title}</Text>
        <ChevronIcon color={theme.colors.textMuted} size={15} />
      </Pressable>
      {!collapsed ? <View style={styles.sectionList}>{children}</View> : null}
    </View>
  );
}

function SidebarProjectRow({
  collapsed,
  disabled,
  onNewChat,
  onToggle,
  project,
}: {
  collapsed: boolean;
  disabled?: boolean;
  onNewChat: () => void;
  onToggle: () => void;
  project: IrisProject;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const ProjectIcon = collapsed ? Folder : FolderOpen;
  const ChevronIcon = collapsed ? ChevronRight : ChevronDown;
  return (
    <View style={styles.projectRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${project.name}`}
        accessibilityState={{ expanded: !collapsed }}
        onPress={onToggle}
        style={({ pressed }) => [styles.projectToggle, pressed ? styles.pressed : null]}
      >
        <ProjectIcon color={theme.colors.textMuted} size={18} />
        <Text style={styles.projectTitle} numberOfLines={1}>{project.name}</Text>
        <ChevronIcon color={theme.colors.textMuted} size={16} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Start new chat in ${project.name}`}
        disabled={disabled}
        onPress={onNewChat}
        style={({ pressed }) => [
          styles.projectAction,
          disabled ? styles.disabled : null,
          pressed ? styles.pressed : null,
        ]}
      >
        <SquarePen color={theme.colors.textMuted} size={17} />
      </Pressable>
    </View>
  );
}

function SidebarSessionRow({
  nested = false,
  onPress,
  onLongPress,
  onPin,
  onRename,
  onDelete,
  pinned = false,
  selected,
  session,
}: {
  nested?: boolean;
  onPress: () => void;
  onLongPress?: (anchor: SessionMenuAnchor) => void;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
  pinned?: boolean;
  selected?: boolean;
  session: IrisCoreSession;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const rowRef = useRef<View>(null);
  const unread = mobileSessionShowsUnread(session, Boolean(selected));

  function handleLongPress() {
    if (!onLongPress) return;
    rowRef.current?.measureInWindow((x, y, width, height) => {
      onLongPress({ x, y, width, height });
    });
  }

  return (
    <Pressable
      ref={rowRef}
      accessibilityRole="button"
      onPress={onPress}
      onLongPress={useNativeContextMenu ? undefined : onLongPress ? handleLongPress : undefined}
      delayLongPress={300}
      style={({ pressed }) => [
        styles.sessionRow,
        nested ? styles.nestedSessionRow : null,
        selected ? styles.selectedRow : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={styles.sessionTitle} numberOfLines={1}>{session.title || "Untitled session"}</Text>
      {unread ? <View style={styles.unreadDot} /> : null}
      <Text style={styles.sessionTime} numberOfLines={1}>
        {mobileSidebarTimeLabel(session.updatedAt || session.createdAt)}
      </Text>
      {useNativeContextMenu ? (
        <NativeSessionContextMenu
          session={session}
          selected={selected}
          pinned={pinned}
          onPress={onPress}
          onPin={onPin}
          onRename={onRename}
          onDelete={onDelete}
        />
      ) : null}
    </Pressable>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const pageShadow = Platform.select({
    web: {
      boxShadow: `-10px 0 24px ${theme.colors.background}`,
    },
    default: {},
  });

  return StyleSheet.create({
    drawerRoot: {
      flex: 1,
      backgroundColor: theme.colors.background,
      overflow: "hidden",
    },
    pageLayer: {
      flex: 1,
      zIndex: 1,
      backgroundColor: theme.colors.screen,
      ...pageShadow,
    },
    pageCloseLayer: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
    pageEdge: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      width: 24,
    },
    panel: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      zIndex: 0,
      backgroundColor: theme.colors.background,
      paddingLeft: theme.spacing[5],
      paddingRight: theme.spacing[2],
      paddingTop: theme.spacing[2],
      paddingBottom: 0,
      gap: theme.spacing[5],
    },
    panelClosed: {
      pointerEvents: "none",
    },
    header: {
      minHeight: 76,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[3],
    },
    roundButtonFill: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.secondary,
    },
    glassButton: {
      width: 52,
      height: 52,
      borderRadius: 26,
      overflow: "hidden",
    },
    brandButton: {
      flex: 1,
      minWidth: 0,
      minHeight: 64,
      borderRadius: theme.radius.xl,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[3],
    },
    brandMark: {
      width: 56,
      height: 56,
      borderRadius: 15,
    },
    brandCopy: {
      flex: 1,
      minWidth: 0,
      gap: 4,
    },
    brand: {
      color: theme.colors.text,
      fontSize: 26,
      lineHeight: 31,
      fontWeight: "700",
    },
    brandStatusRow: {
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    statusDot: {
      width: 11,
      height: 11,
      borderRadius: 6,
    },
    statusDotReady: {
      backgroundColor: theme.colors.success,
    },
    statusDotConnecting: {
      backgroundColor: theme.colors.warning,
    },
    statusDotOffline: {
      backgroundColor: theme.colors.danger,
    },
    statusDotIdle: {
      backgroundColor: theme.colors.textMuted,
    },
    brandStatusText: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.textMuted,
      fontSize: 16,
      lineHeight: 21,
    },
    sidebarScroll: {
      flex: 1,
      minHeight: 120,
    },
    sidebarScrollInner: {
      gap: theme.spacing[5],
      paddingBottom: 0,
    },
    section: {
      gap: theme.spacing[2],
    },
    sectionToggle: {
      minHeight: 28,
      paddingRight: SIDEBAR_RIGHT_RAIL_INSET,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing[2],
    },
    sectionLabel: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.textMuted,
      fontSize: 13,
      fontWeight: "700",
      letterSpacing: 0,
      textTransform: "uppercase",
    },
    sectionList: {
      gap: 2,
    },
    projectNode: {
      gap: 2,
    },
    projectSessions: {
      gap: 2,
    },
    projectRow: {
      minHeight: 38,
      borderRadius: theme.radius.md,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing[1],
    },
    projectToggle: {
      flex: 1,
      minWidth: 0,
      minHeight: 38,
      borderRadius: theme.radius.md,
      paddingLeft: theme.spacing[2],
      paddingRight: theme.spacing[1],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    projectTitle: {
      flexShrink: 1,
      minWidth: 0,
      color: theme.colors.text,
      fontSize: 16,
      fontWeight: "600",
    },
    projectAction: {
      width: PROJECT_ACTION_SIZE,
      height: PROJECT_ACTION_SIZE,
      borderRadius: theme.radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    sessionRow: {
      height: SESSION_ROW_HEIGHT,
      borderRadius: theme.radius.md,
      paddingLeft: theme.spacing[2],
      paddingRight: SIDEBAR_RIGHT_RAIL_INSET,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    nestedSessionRow: {
      marginLeft: theme.spacing[5],
    },
    selectedRow: {
      backgroundColor: theme.colors.accent,
    },
    sessionTitle: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.text,
      fontSize: 15,
      lineHeight: 20,
    },
    unreadDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: theme.colors.accentCoolBright,
    },
    sessionTime: {
      color: theme.colors.textMuted,
      fontSize: 12,
      lineHeight: 18,
      minWidth: 36,
      textAlign: "right",
    },
    nestedEmpty: {
      marginLeft: theme.spacing[5],
      color: theme.colors.textMuted,
      fontSize: 13,
      lineHeight: 18,
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
    bottomBar: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingTop: theme.spacing[3],
    },
    searchPill: {
      flex: 1,
      height: 52,
      borderRadius: 26,
      overflow: "hidden",
    },
    searchPressable: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[4],
    },
    searchPillFill: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.secondary,
    },
    searchInput: {
      flex: 1,
      color: theme.colors.text,
      fontSize: 16,
      paddingVertical: 0,
    },
    bottomCircle: {
      width: 52,
      height: 52,
      borderRadius: 26,
      overflow: "hidden",
    },
    bottomCircleFill: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.secondary,
    },
    pressed: {
      opacity: 0.76,
    },
    disabled: {
      opacity: 0.46,
    },
  });
}
