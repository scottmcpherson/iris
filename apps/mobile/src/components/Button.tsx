import { Pressable, StyleSheet, Text, type PressableProps } from "react-native";
import { useTheme } from "../theme/useTheme";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

type ButtonProps = PressableProps & {
  label: string;
  variant?: ButtonVariant;
};

export function Button({ label, variant = "primary", disabled, style, ...props }: ButtonProps) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={(state) => [
        styles.button,
        styles[variant],
        disabled ? styles.disabled : null,
        state.pressed && !disabled ? styles.pressed : null,
        typeof style === "function" ? style(state) : style,
      ]}
      {...props}
    >
      <Text style={[styles.label, variant === "primary" ? styles.primaryLabel : null]}>{label}</Text>
    </Pressable>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    button: {
      minHeight: 44,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing[4],
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    primary: {
      backgroundColor: theme.colors.buttonPrimary,
      borderColor: theme.colors.buttonPrimary,
    },
    secondary: {
      backgroundColor: theme.colors.secondary,
    },
    danger: {
      backgroundColor: theme.colors.statusOfflineFill,
      borderColor: theme.colors.statusOfflineBorder,
    },
    ghost: {
      backgroundColor: theme.colors.background,
      borderColor: theme.colors.borderSubtle,
    },
    pressed: {
      opacity: 0.74,
    },
    disabled: {
      opacity: 0.46,
    },
    label: {
      color: theme.colors.text,
      fontSize: 15,
      fontWeight: "700",
    },
    primaryLabel: {
      color: theme.colors.buttonPrimaryText,
    },
  });
}
