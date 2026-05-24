import { StyleSheet, Text, View } from "react-native";
import type { ChatMessage } from "@iris/chat-core";
import { useTheme } from "../theme/useTheme";

export function MessageBubble({ message }: { message: ChatMessage }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const isUser = message.role === "user";
  return (
    <View style={[styles.wrap, isUser ? styles.userWrap : styles.assistantWrap]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        <Text style={[styles.text, isUser ? styles.userText : null]}>
          {message.content || (message.streaming ? "Thinking..." : "")}
        </Text>
      </View>
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    wrap: {
      flexDirection: "row",
    },
    userWrap: {
      justifyContent: "flex-end",
    },
    assistantWrap: {
      justifyContent: "flex-start",
    },
    bubble: {
      maxWidth: "86%",
      borderRadius: theme.radius.lg,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[3],
      borderWidth: 1,
    },
    userBubble: {
      backgroundColor: theme.colors.buttonPrimary,
      borderColor: theme.colors.buttonPrimary,
    },
    assistantBubble: {
      backgroundColor: theme.colors.surfaceRaised,
      borderColor: theme.colors.border,
    },
    text: {
      color: theme.colors.text,
      fontSize: 16,
      lineHeight: 22,
    },
    userText: {
      color: theme.colors.buttonPrimaryText,
    },
  });
}
