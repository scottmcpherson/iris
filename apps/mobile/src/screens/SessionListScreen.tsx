import { router } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useSessionsQuery } from "@iris/iris-query";
import { AppScreen } from "../components/AppScreen";
import { SessionRow } from "../components/SessionRow";
import { useIrisConnection } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";

export function SessionListScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { client, clientKey } = useIrisConnection();
  const sessionsQuery = useSessionsQuery(client, clientKey, "default");
  const sessions = sessionsQuery.data?.sessions || [];

  return (
    <AppScreen title="Sessions" subtitle="Recent Iris conversations.">
      {!client ? <Text style={styles.empty}>Reconnect to load sessions.</Text> : null}
      {sessionsQuery.isLoading ? <ActivityIndicator color={theme.colors.textMuted} /> : null}
      {sessionsQuery.error ? <Text style={styles.error}>{sessionsQuery.error.message}</Text> : null}
      {client && !sessionsQuery.isLoading && sessions.length === 0 ? <Text style={styles.empty}>No sessions yet</Text> : null}
      <View style={styles.list}>
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            onPress={() => router.push({ pathname: "/sessions/[sessionId]", params: { sessionId: session.id } })}
          />
        ))}
      </View>
    </AppScreen>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    list: {
      gap: theme.spacing[3],
    },
    empty: {
      color: theme.colors.textMuted,
      fontSize: 15,
      lineHeight: 21,
    },
    error: {
      color: theme.colors.danger,
      fontSize: 14,
      lineHeight: 20,
    },
  });
}
