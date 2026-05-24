import { router, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useCreateSessionMutation, useProjectSessionsQuery } from "@iris/iris-query";
import { AppScreen } from "../components/AppScreen";
import { Button } from "../components/Button";
import { SessionRow } from "../components/SessionRow";
import { useIrisConnection } from "../connection/useIrisConnection";
import { resolveDefaultAgentId } from "../lib/defaultAgent";
import { useTheme } from "../theme/useTheme";

export function ProjectDetailScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const { client, clientKey } = useIrisConnection();
  const sessionsQuery = useProjectSessionsQuery(client, clientKey, projectId || "");
  const createSession = useCreateSessionMutation(client, clientKey);
  const sessions = sessionsQuery.data?.sessions || [];

  async function startSession() {
    if (!client || !projectId) return;
    const agentId = await resolveDefaultAgentId(client);
    const result = await createSession.mutateAsync({
      agentId,
      title: "New mobile session",
      projectId,
      metadata: { source: "iris-mobile" },
    });
    router.push({ pathname: "/sessions/[sessionId]", params: { sessionId: result.session.id } });
  }

  return (
    <AppScreen
      title="Project Sessions"
      subtitle={projectId}
      action={<Button label="New Chat" disabled={!client || createSession.isPending} onPress={() => void startSession()} />}
    >
      {!client ? <Text style={styles.empty}>Reconnect to load project sessions.</Text> : null}
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
