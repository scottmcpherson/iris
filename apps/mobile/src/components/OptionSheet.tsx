import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTheme } from "../theme/useTheme";
import { GlassSurface } from "./GlassSurface";

export type OptionSheetItem = {
  id: string;
  label: string;
  detail?: string;
  selected?: boolean;
};

type OptionSheetProps = {
  visible: boolean;
  title: string;
  items: OptionSheetItem[];
  emptyLabel?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
};

export function OptionSheet({
  visible,
  title,
  items,
  emptyLabel = "No options available.",
  onSelect,
  onClose,
}: OptionSheetProps) {
  const theme = useTheme();
  const styles = createStyles(theme);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close options" style={styles.backdrop} onPress={onClose} />
      <GlassSurface style={styles.sheet} fallbackStyle={styles.sheetFill}>
        <View style={styles.handle} />
        <Text style={styles.title}>{title}</Text>
        <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
          {items.length === 0 ? <Text style={styles.empty}>{emptyLabel}</Text> : null}
          {items.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityState={{ selected: item.selected }}
              onPress={() => {
                onSelect(item.id);
                onClose();
              }}
              style={({ pressed }) => [styles.row, item.selected ? styles.selectedRow : null, pressed ? styles.pressed : null]}
            >
              <View style={styles.rowText}>
                <Text style={styles.label} numberOfLines={1}>{item.label}</Text>
                {item.detail ? <Text style={styles.detail} numberOfLines={2}>{item.detail}</Text> : null}
              </View>
              {item.selected ? <Check color={theme.colors.text} size={18} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      </GlassSurface>
    </Modal>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: theme.colors.muted,
    },
    sheet: {
      maxHeight: "72%",
      borderTopLeftRadius: theme.radius.xl,
      borderTopRightRadius: theme.radius.xl,
      overflow: "hidden",
      paddingTop: theme.spacing[2],
      paddingHorizontal: theme.spacing[4],
      paddingBottom: theme.spacing[6],
      gap: theme.spacing[3],
    },
    sheetFill: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
    },
    handle: {
      alignSelf: "center",
      width: 44,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.colors.borderStrong,
    },
    title: {
      color: theme.colors.text,
      fontSize: 18,
      fontWeight: "700",
    },
    list: {
      maxHeight: 420,
    },
    listInner: {
      gap: theme.spacing[2],
      paddingBottom: theme.spacing[2],
    },
    row: {
      minHeight: 58,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surfaceRaised,
      padding: theme.spacing[3],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[3],
    },
    selectedRow: {
      borderColor: theme.colors.borderStrong,
      backgroundColor: theme.colors.accent,
    },
    pressed: {
      opacity: 0.76,
    },
    rowText: {
      flex: 1,
      minWidth: 0,
      gap: 4,
    },
    label: {
      color: theme.colors.text,
      fontSize: 15,
      fontWeight: "700",
    },
    detail: {
      color: theme.colors.textMuted,
      fontSize: 12,
      lineHeight: 16,
    },
    empty: {
      color: theme.colors.textMuted,
      fontSize: 14,
      lineHeight: 20,
    },
  });
}
