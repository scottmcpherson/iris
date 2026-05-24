import { Pressable, StyleSheet, Text, View } from "react-native";
import type { IrisProject } from "@iris/core-client";
import { useTheme } from "../theme/useTheme";

export function ProjectRow({ project, onPress }: { project: IrisProject; onPress: () => void }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}>
      <View style={styles.textBlock}>
        <Text style={styles.title}>{project.name}</Text>
        <Text style={styles.meta}>{formatUpdated(project.updatedAt)}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function formatUpdated(value: number) {
  if (!value) return "No activity yet";
  return `Updated ${new Date(value * 1000).toLocaleDateString()}`;
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    row: {
      minHeight: 72,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      padding: theme.spacing[4],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[3],
    },
    pressed: {
      opacity: 0.76,
    },
    textBlock: {
      flex: 1,
      minWidth: 0,
      gap: 5,
    },
    title: {
      color: theme.colors.text,
      fontSize: 16,
      fontWeight: "700",
    },
    meta: {
      color: theme.colors.textMuted,
      fontSize: 13,
    },
    chevron: {
      color: theme.colors.textMuted,
      fontSize: 28,
    },
  });
}
