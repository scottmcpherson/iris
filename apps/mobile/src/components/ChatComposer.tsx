import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from "react-native";
import { Send } from "lucide-react-native";
import { useTheme } from "../theme/useTheme";
import { Button } from "./Button";

export function ChatComposer({
  disabled,
  onSend,
}: {
  disabled?: boolean;
  onSend: (text: string) => void;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const [text, setText] = useState("");
  const canSend = Boolean(text.trim()) && !disabled;

  function send() {
    const value = text.trim();
    if (!value || disabled) return;
    setText("");
    onSend(value);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.select({ ios: "padding", default: undefined })}>
      <View style={styles.wrap}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message Iris"
          placeholderTextColor={theme.colors.textMuted}
          multiline
          style={styles.input}
        />
        <Button
          label="Send"
          disabled={!canSend}
          onPress={send}
          style={styles.sendButton}
          accessibilityLabel="Send message"
        />
        <Send color={canSend ? theme.colors.buttonPrimary : theme.colors.textMuted} style={styles.sendIcon} />
      </View>
    </KeyboardAvoidingView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    wrap: {
      borderTopWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.background,
      padding: theme.spacing[3],
      flexDirection: "row",
      alignItems: "flex-end",
      gap: theme.spacing[2],
    },
    input: {
      flex: 1,
      minHeight: 44,
      maxHeight: 132,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.input,
      color: theme.colors.text,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: 10,
      fontSize: 16,
    },
    sendButton: {
      minWidth: 74,
    },
    sendIcon: {
      display: "none",
    },
  });
}
