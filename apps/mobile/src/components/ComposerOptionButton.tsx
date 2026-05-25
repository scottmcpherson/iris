import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { useTheme } from "../theme/useTheme";

type ComposerOptionButtonProps = {
  icon: ReactNode;
  label: string;
  value: string;
  disabled?: boolean;
  variant?: "card" | "toolbar" | "chip";
  showValue?: boolean;
  showChevron?: boolean;
  onPress: () => void;
};

export function ComposerOptionButton({
  icon,
  label,
  value,
  disabled,
  variant = "card",
  showValue = true,
  showChevron = true,
  onPress,
}: ComposerOptionButtonProps) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const containerStyle = variant === "chip" ? styles.chipButton : variant === "toolbar" ? styles.toolbarButton : styles.button;
  const valueStyle = variant === "chip" ? styles.chipValue : variant === "toolbar" ? styles.toolbarValue : styles.value;
  const chevronSize = variant === "chip" ? 14 : variant === "toolbar" ? 18 : 15;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        containerStyle,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      {icon}
      {showValue ? (
        <View style={styles.textBlock}>
          {variant === "card" ? <Text style={styles.label} numberOfLines={1}>{label}</Text> : null}
          <Text style={valueStyle} numberOfLines={1}>{value}</Text>
        </View>
      ) : null}
      {showChevron ? <ChevronDown color={theme.colors.textMuted} size={chevronSize} /> : null}
    </Pressable>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    button: {
      minHeight: 44,
      maxWidth: 230,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    toolbarButton: {
      minHeight: 38,
      maxWidth: 180,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[1],
    },
    chipButton: {
      height: 38,
      maxWidth: 200,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
      backgroundColor: theme.colors.surfaceRaised,
      paddingHorizontal: theme.spacing[3],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    disabled: {
      opacity: 0.46,
    },
    pressed: {
      opacity: 0.76,
    },
    textBlock: {
      minWidth: 0,
      flexShrink: 1,
      gap: 2,
    },
    label: {
      color: theme.colors.textMuted,
      fontSize: 11,
      fontWeight: "700",
    },
    value: {
      color: theme.colors.text,
      fontSize: 13,
      fontWeight: "700",
    },
    toolbarValue: {
      color: theme.colors.textMuted,
      fontSize: 18,
      fontWeight: "500",
    },
    chipValue: {
      color: theme.colors.textSecondary,
      fontSize: 14,
      fontWeight: "600",
    },
  });
}
