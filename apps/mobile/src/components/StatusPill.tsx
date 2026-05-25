import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/useTheme";
import type { MobileConnectionState } from "../connection/useIrisConnection";

export function StatusPill({ state }: { state: MobileConnectionState }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const tone = state.status === "connected" ? "ready" : state.status === "blocked" ? "blocked" : "idle";
  const label = statusLabel(state);

  return (
    <View style={[styles.pill, styles[tone]]}>
      <View style={[styles.dot, styles[`${tone}Dot`]]} />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

function statusLabel(state: MobileConnectionState) {
  switch (state.status) {
    case "unpaired":
      return "Not paired";
    case "connecting":
      return `Connecting to ${state.profile.hostLabel}`;
    case "connected":
      return `Connected to ${state.profile.hostLabel}`;
    case "blocked":
      return state.reason === "core-unreachable" ? "Host unreachable" : "Connection blocked";
    case "disconnected":
      return state.error || `Disconnected from ${state.profile.hostLabel}`;
  }
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    pill: {
      minHeight: 32,
      alignSelf: "flex-start",
      borderRadius: theme.radius.md,
      borderWidth: 1,
      paddingHorizontal: theme.spacing[3],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    ready: {
      backgroundColor: theme.colors.statusReadyFill,
      borderColor: theme.colors.statusReadyBorder,
    },
    blocked: {
      backgroundColor: theme.colors.statusOfflineFill,
      borderColor: theme.colors.statusOfflineBorder,
    },
    idle: {
      backgroundColor: theme.colors.secondary,
      borderColor: theme.colors.border,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    readyDot: {
      backgroundColor: theme.colors.success,
    },
    blockedDot: {
      backgroundColor: theme.colors.danger,
    },
    idleDot: {
      backgroundColor: theme.colors.textMuted,
    },
    label: {
      color: theme.colors.text,
      fontSize: 13,
      fontWeight: "600",
    },
  });
}
