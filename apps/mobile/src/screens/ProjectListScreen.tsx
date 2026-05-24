import { router } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useProjectsQuery } from "@iris/iris-query";
import { AppScreen } from "../components/AppScreen";
import { Button } from "../components/Button";
import { ProjectRow } from "../components/ProjectRow";
import { useIrisConnection } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";

export function ProjectListScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { client, clientKey, state } = useIrisConnection();
  const projectsQuery = useProjectsQuery(client, clientKey);
  const projects = projectsQuery.data?.projects || [];

  return (
    <AppScreen
      title="Projects"
      subtitle={state.status === "connected" ? state.profile.hostLabel : "Connect to Iris Desktop to load projects."}
      action={<Button label="New" disabled={!client} onPress={() => router.push("/projects/new")} />}
    >
      {!client ? <DisconnectedState /> : null}
      {projectsQuery.isLoading ? <ActivityIndicator color={theme.colors.textMuted} /> : null}
      {projectsQuery.error ? <Text style={styles.error}>{projectsQuery.error.message}</Text> : null}
      {client && !projectsQuery.isLoading && projects.length === 0 ? <Text style={styles.empty}>No projects yet</Text> : null}
      <View style={styles.list}>
        {projects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            onPress={() => router.push({ pathname: "/projects/[projectId]", params: { projectId: project.id } })}
          />
        ))}
      </View>
    </AppScreen>
  );
}

function DisconnectedState() {
  const theme = useTheme();
  const styles = createStyles(theme);
  return <Text style={styles.empty}>Iris mobile only connects through SSH. Pair or reconnect before loading projects.</Text>;
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
