import { router, useLocalSearchParams, type Href } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Menu, Plus } from "lucide-react-native";
import Animated, {
  Easing,
  interpolate,
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
import { useIrisConnection } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";
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
import { NativeSessionRow } from "./NativeSessionRow";
import { SessionActionMenu, SessionRenameDialog, type SessionMenuAnchor } from "./SessionActionMenu";

const useNativeContextMenu = Platform.OS === "ios";

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

let mobileSidebarLastScrollY = 0;

export function SidebarButton({ open = false, onPress }: { open?: boolean; onPress: () => void }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const accessibilityLabel = open ? "Close sidebar" : "Open sidebar";

  if (isLiquidGlassAvailable()) {
    return (
      <GlassView isInteractive glassEffectStyle="regular" colorScheme="dark" style={styles.glassButton}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ expanded: open }}
          onPress={onPress}
          style={styles.glassButtonPressable}
        >
          <Menu color={theme.colors.text} size={24} />
        </Pressable>
      </GlassView>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={({ pressed }) => [styles.roundButton, pressed ? styles.pressed : null]}
    >
      <Menu color={theme.colors.textMuted} size={24} />
    </Pressable>
  );
}

export function MobileSidebarDrawer({ open, onClose, onOpen, selectedSessionId, children }: MobileSidebarDrawerProps) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(360, Math.max(292, width * 0.78));
  const drawerOffset = Math.min(width - 64, panelWidth + theme.spacing[3]);
  const progress = useSharedValue(open ? 1 : 0);
  const dragStart = useSharedValue(1);

  useEffect(() => {
    progress.set(withTiming(open ? 1 : 0, {
      duration: 320,
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
    borderTopLeftRadius: interpolate(progress.value, [0, 1], [0, 28]),
    borderBottomLeftRadius: interpolate(progress.value, [0, 1], [0, 28]),
    transform: [{ translateX: progress.value * drawerOffset }],
  }));

  return (
    <View style={styles.drawerRoot}>
      <MobileSidebar open={open} onClose={onClose} panelWidth={panelWidth} selectedSessionId={selectedSessionId} />
      <Animated.View style={[styles.pageLayer, pageStyle]}>
        {children}
        {open ? (
          <GestureDetector gesture={closeGesture}>
            <Animated.View
              accessibilityRole="button"
              accessibilityLabel="Close sidebar"
              style={styles.pageCloseLayer}
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
  const { client, clientKey, state } = useIrisConnection();
  const queryClient = useQueryClient();
  const scrollRef = useRef<ScrollView>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState(
    () => loadMobileSidebarCollapsedSections(),
  );
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(
    () => loadMobileSidebarCollapsedProjects(),
  );
  const { sessionId: routeSessionId } = useLocalSearchParams<{ sessionId?: string }>();
  const selectedSessionId = activeSessionId || (typeof routeSessionId === "string" ? routeSessionId : "");
  const profile = "profile" in state ? state.profile : null;
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
  const sidebarModel = buildMobileSidebarModel({
    pinnedSessions,
    projects,
    sessions,
    sessionsByProject,
  });
  const projectSessionsLoading = projectSessionQueries.some((query) => query.isLoading || query.isFetching);
  const projectSessionError = projectSessionQueries.find((query) => query.error)?.error;

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      if (mobileSidebarLastScrollY > 0) {
        scrollRef.current?.scrollTo({ y: mobileSidebarLastScrollY, animated: false });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function navigate(path: Href) {
    onClose();
    router.push(path);
  }

  function openSession(session: IrisCoreSession) {
    markSessionRead(session);
    onClose();
    router.push({ pathname: "/sessions/[sessionId]", params: { sessionId: session.id } });
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

  // Direct handlers used by the native iOS context menu (no anchored glass overlay).
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
        <Text style={styles.brand}>Iris</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open settings"
          onPress={() => setSettingsVisible(true)}
          style={({ pressed }) => [styles.avatarButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.avatarText}>{avatarInitials(profile?.hostLabel)}</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.sidebarScroll}
        contentContainerStyle={styles.sidebarScrollInner}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (open && mobileSidebarLastScrollY > 0) {
            scrollRef.current?.scrollTo({ y: mobileSidebarLastScrollY, animated: false });
          }
        }}
        onScroll={(event) => {
          mobileSidebarLastScrollY = Math.max(0, event.nativeEvent.contentOffset.y);
        }}
      >
        {!client ? <Text style={styles.empty}>Reconnect to load the sidebar.</Text> : null}
        {sessionsQuery.isLoading || projectsQuery.isLoading ? <Text style={styles.empty}>Loading sidebar...</Text> : null}
        {sessionsQuery.error ? <Text style={styles.error}>{sessionsQuery.error.message}</Text> : null}
        {projectsQuery.error ? <Text style={styles.error}>{projectsQuery.error.message}</Text> : null}
        {projectSessionError instanceof Error ? <Text style={styles.error}>{projectSessionError.message}</Text> : null}

        {sidebarModel.pinnedSessions.length ? (
          <SidebarSection
            collapsed={collapsedSections.pinned}
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

        <SidebarSection
          collapsed={collapsedSections.projects}
          sectionId="projects"
          title="Projects"
          onToggle={() => toggleSectionCollapsed("projects")}
        >
          {projects.length ? (
            sidebarModel.projectNodes.map((node, index) => (
              <View key={node.project.id} style={styles.projectNode}>
                <SidebarProjectRow
                  collapsed={Boolean(collapsedProjects[node.project.id])}
                  project={node.project}
                  onPress={() => toggleProjectCollapsed(node.project.id)}
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
          ) : (
            <Text style={styles.empty}>No projects yet.</Text>
          )}
          {projects.length > 0 && projectSessionsLoading ? <Text style={styles.empty}>Loading project sessions...</Text> : null}
        </SidebarSection>

        <SidebarSection
          collapsed={collapsedSections.chats}
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
          ) : (
            <Text style={styles.empty}>No unprojected sessions yet.</Text>
          )}
        </SidebarSection>
      </ScrollView>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Start new chat"
        disabled={!client}
        onPress={() => navigate("/sessions/new")}
        style={({ pressed }) => [
          styles.newChatButton,
          { bottom: Math.max(theme.spacing[4], insets.bottom + theme.spacing[2]) },
          !client ? styles.disabled : null,
          pressed && client ? styles.pressed : null,
        ]}
      >
        <Plus color={theme.colors.buttonPrimaryText} size={24} />
      </Pressable>
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

function avatarInitials(label?: string) {
  const words = (label || "Iris")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (!words.length) return "I";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
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
  onPress,
  project,
}: {
  collapsed: boolean;
  onPress: () => void;
  project: IrisProject;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const ProjectIcon = collapsed ? Folder : FolderOpen;
  const ChevronIcon = collapsed ? ChevronRight : ChevronDown;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${project.name}`}
      accessibilityState={{ expanded: !collapsed }}
      onPress={onPress}
      style={({ pressed }) => [styles.projectRow, pressed ? styles.pressed : null]}
    >
      <ProjectIcon color={theme.colors.textMuted} size={18} />
      <Text style={styles.projectTitle} numberOfLines={1}>{project.name}</Text>
      <ChevronIcon color={theme.colors.textMuted} size={16} />
    </Pressable>
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

  if (useNativeContextMenu) {
    return (
      <NativeSessionRow
        session={session}
        selected={selected}
        nested={nested}
        pinned={pinned}
        onPress={onPress}
        onPin={onPin}
        onRename={onRename}
        onDelete={onDelete}
      />
    );
  }

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
      onLongPress={onLongPress ? handleLongPress : undefined}
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
    </Pressable>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const pageShadow = Platform.select({
    web: {
      boxShadow: `-10px 0 24px ${theme.colors.background}`,
    },
    default: {
      shadowColor: theme.colors.background,
      shadowOffset: { width: -10, height: 0 },
      shadowOpacity: 0.42,
      shadowRadius: 24,
      elevation: 18,
    },
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
      overflow: "hidden",
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
      paddingHorizontal: theme.spacing[5],
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
      justifyContent: "space-between",
      gap: theme.spacing[3],
    },
    brand: {
      color: theme.colors.text,
      fontSize: 32,
      fontWeight: "700",
    },
    roundButton: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: "center",
      justifyContent: "center",
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
    glassButtonPressable: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarButton: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: theme.colors.borderStrong,
      backgroundColor: theme.colors.surfaceRaised,
    },
    avatarText: {
      color: theme.colors.text,
      fontSize: 16,
      fontWeight: "800",
      lineHeight: 20,
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
      paddingLeft: theme.spacing[2],
      paddingRight: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    projectTitle: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.text,
      fontSize: 16,
      fontWeight: "600",
    },
    sessionRow: {
      minHeight: 34,
      borderRadius: theme.radius.md,
      paddingLeft: theme.spacing[2],
      paddingRight: 0,
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
    newChatButton: {
      position: "absolute",
      right: theme.spacing[5],
      bottom: theme.spacing[4],
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.buttonPrimary,
      borderWidth: 1,
      borderColor: theme.colors.borderStrong,
    },
    pressed: {
      opacity: 0.76,
    },
    disabled: {
      opacity: 0.46,
    },
  });
}
