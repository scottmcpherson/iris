import { useEffect, useMemo, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { useSendMessageMutation, useSessionDetailQuery } from "@iris/iris-query";
import {
  appendOptimisticSend,
  coreEventToDeliveryMessage,
  mergeCompletedDelivery,
  mergeErrorDelivery,
  mergeStreamDelivery,
  replaceOptimisticSend,
  streamDeliveryFinalized,
  toChatMessages,
  type ChatMessage,
} from "@iris/chat-core";
import { getEvents, getLatestEventCursor } from "@iris/core-client";
import { AppScreen } from "../components/AppScreen";
import { Button } from "../components/Button";
import { ChatComposer } from "../components/ChatComposer";
import { MessageBubble } from "../components/MessageBubble";
import { useIrisConnection } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";

export function ChatScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const { client, clientKey } = useIrisConnection();
  const detailQuery = useSessionDetailQuery(client, clientKey, sessionId || "");
  const sendMutation = useSendMessageMutation(client, clientKey);
  const historyMessages = useMemo(
    () => toChatMessages(detailQuery.data?.messages || []),
    [detailQuery.data?.messages],
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    setMessages(historyMessages);
  }, [historyMessages]);

  useEffect(() => {
    let cancelled = false;
    if (!client) return undefined;
    getLatestEventCursor(client).then((result) => {
      if (!cancelled && result.ok) setCursor(result.cursor);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (!client || !sessionId) return undefined;
    const timer = setInterval(() => {
      void pollEvents();
    }, 2000);
    return () => clearInterval(timer);

    async function pollEvents() {
      if (!client) return;
      const result = await getEvents(client, { after: cursor, limit: 80 });
      if (!result.ok) return;
      if (result.cursor !== cursor) setCursor(result.cursor);
      for (const event of result.events.filter((item) => item.sessionId === sessionId)) {
        const delivery = coreEventToDeliveryMessage(event);
        if (event.type === "message.error") {
          setMessages((current) => mergeErrorDelivery(current, delivery));
        } else if (event.type.includes("completed")) {
          setMessages((current) => mergeCompletedDelivery(current, delivery));
        } else if (event.type.includes("assistant")) {
          setMessages((current) =>
            mergeStreamDelivery(
              current,
              delivery,
              event.externalMessageId || event.id,
              streamDeliveryFinalized(event.metadata),
            ),
          );
        }
      }
    }
  }, [client, cursor, sessionId]);

  async function send(text: string) {
    if (!client || !sessionId) return;
    const optimistic = appendOptimisticSend(messages, text);
    setMessages(optimistic.messages);
    try {
      const result = await sendMutation.mutateAsync({
        sessionId,
        payload: {
          text,
          clientMessageId: optimistic.clientRequestId,
          metadata: { clientRequestId: optimistic.clientRequestId, source: "iris-mobile" },
        },
      });
      setMessages((current) => replaceOptimisticSend(current, result, optimistic.clientRequestId));
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: `${optimistic.clientRequestId}-send-error`,
          role: "assistant",
          content: error instanceof Error ? error.message : "Iris Core did not accept the message.",
          clientRequestId: optimistic.clientRequestId,
          streaming: false,
        },
      ]);
    }
  }

  return (
    <View style={styles.root}>
      <AppScreen
        title={detailQuery.data?.session.title || "Chat"}
        subtitle={sessionId}
        scroll={false}
        action={<Button label="Sessions" variant="secondary" onPress={() => router.push("/sessions")} />}
      >
        {!client ? <Text style={styles.empty}>Reconnect before chatting.</Text> : null}
        {detailQuery.isLoading ? <ActivityIndicator color={theme.colors.textMuted} /> : null}
        {detailQuery.error ? <Text style={styles.error}>{detailQuery.error.message}</Text> : null}
        <FlatList
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <MessageBubble message={item} />}
          contentContainerStyle={styles.messages}
        />
      </AppScreen>
      <ChatComposer disabled={!client || sendMutation.isPending} onSend={(value) => void send(value)} />
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.colors.screen,
    },
    messages: {
      paddingHorizontal: theme.spacing[4],
      paddingBottom: theme.spacing[8],
      gap: theme.spacing[3],
    },
    empty: {
      color: theme.colors.textMuted,
      fontSize: 15,
      lineHeight: 21,
      padding: theme.spacing[4],
    },
    error: {
      color: theme.colors.danger,
      fontSize: 14,
      lineHeight: 20,
      padding: theme.spacing[4],
    },
  });
}
