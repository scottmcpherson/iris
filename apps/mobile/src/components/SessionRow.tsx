import { Pressable, StyleSheet, Text, View } from "react-native";
import type { IrisCoreSession } from "@iris/core-client";
import { useTheme } from "../theme/useTheme";

export function SessionRow({ session, onPress }: { session: IrisCoreSession; onPress: () => void }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const unread = session.readState?.state === "unread";
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
      <View style={styles.textBlock}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>{session.title || "Untitled session"}</Text>
          {unread ? <View style={styles.unreadDot} /> : null}
        </View>
        <Text style={styles.summary} numberOfLines={2}>{session.summary || "No summary yet"}</Text>
        <Text style={styles.meta}>{formatUpdated(session.updatedAt || session.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

function formatUpdated(value: number) {
  if (!value) return "No activity yet";
  return new Date(value * 1000).toLocaleString();
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    row: {
      minHeight: 86,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      padding: theme.spacing[4],
    },
    pressed: {
      opacity: 0.76,
    },
    textBlock: {
      gap: 6,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    title: {
      flex: 1,
      color: theme.colors.text,
      fontSize: 16,
      fontWeight: "700",
    },
    unreadDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.colors.accentCoolBright,
    },
    summary: {
      color: theme.colors.textSubtle,
      fontSize: 13,
      lineHeight: 18,
    },
    meta: {
      color: theme.colors.textMuted,
      fontSize: 12,
    },
  });
}
