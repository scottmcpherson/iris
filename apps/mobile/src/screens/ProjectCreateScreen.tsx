import { useState } from "react";
import { router } from "expo-router";
import { StyleSheet, Text } from "react-native";
import { useCreateProjectMutation } from "@iris/iris-query";
import { AppScreen } from "../components/AppScreen";
import { Button } from "../components/Button";
import { TextField } from "../components/TextField";
import { useIrisConnection } from "../connection/useIrisConnection";
import { resolveDefaultAgentId } from "../lib/defaultAgent";
import { useTheme } from "../theme/useTheme";

export function ProjectCreateScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { client, clientKey } = useIrisConnection();
  const mutation = useCreateProjectMutation(client, clientKey);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function create() {
    if (!client || !name.trim()) return;
    setError("");
    try {
      const defaultAgentId = await resolveDefaultAgentId(client);
      const result = await mutation.mutateAsync({ name: name.trim(), defaultAgentId });
      router.replace({ pathname: "/projects/[projectId]", params: { projectId: result.project.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project.");
    }
  }

  return (
    <AppScreen title="New Project" subtitle="Create a Core-backed Iris project.">
      <TextField label="Project name" value={name} onChangeText={setName} autoFocus />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label="Create Project" disabled={!client || !name.trim() || mutation.isPending} onPress={() => void create()} />
    </AppScreen>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    error: {
      color: theme.colors.danger,
      fontSize: 14,
      lineHeight: 20,
    },
  });
}
