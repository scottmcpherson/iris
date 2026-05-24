import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { useTheme } from "../theme/useTheme";

type TextFieldProps = TextInputProps & {
  label: string;
  help?: string;
};

export function TextField({ label, help, style, ...props }: TextFieldProps) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={theme.colors.textMuted}
        style={[styles.input, style]}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
      />
      {help ? <Text style={styles.help}>{help}</Text> : null}
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    field: {
      gap: 7,
    },
    label: {
      color: theme.colors.text,
      fontSize: 13,
      fontWeight: "700",
    },
    input: {
      minHeight: 44,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.input,
      color: theme.colors.text,
      paddingHorizontal: theme.spacing[3],
      fontSize: 16,
    },
    help: {
      color: theme.colors.textMuted,
      fontSize: 12,
      lineHeight: 17,
    },
  });
}
