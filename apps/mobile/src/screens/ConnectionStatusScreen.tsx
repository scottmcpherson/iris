import { StyleSheet, Text, View } from "react-native";
import { AppScreen } from "../components/AppScreen";
import { Button } from "../components/Button";
import { isDirectCoreConnectionProfile, type SavedConnectionProfile } from "../connection/pairingPayload";
import { useIrisConnection } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";

export function ConnectionStatusScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { state, connect, forget } = useIrisConnection();
  const profile = "profile" in state ? state.profile : null;

  return (
    <AppScreen title="Connection" subtitle={profile?.hostLabel || "Pair Iris mobile with a desktop host."}>
      <View style={styles.panel}>
        <Text style={styles.title}>{profile ? profile.hostLabel : "No paired host"}</Text>
        <Text style={styles.body}>
          {profile
            ? profileSummary(profile)
            : "Scan a desktop pairing QR code to save a direct Core connection profile."}
        </Text>
        {state.status === "blocked" ? <Text style={styles.warning}>{blockedText(state.reason)}</Text> : null}
        {state.status === "disconnected" && state.error ? <Text style={styles.warning}>{state.error}</Text> : null}
        <View style={styles.actions}>
          {profile ? <Button label="Reconnect" onPress={() => void connect(profile)} /> : null}
          {profile ? <Button label="Forget" variant="danger" onPress={() => void forget()} /> : null}
        </View>
      </View>
    </AppScreen>
  );
}

function blockedText(reason: "host-key-changed" | "host-key-unverified" | "auth-required" | "ssh-unavailable") {
  if (reason === "ssh-unavailable") {
    return "The native SSH bridge is not available in this build. Rebuild the Expo development app.";
  }
  if (reason === "host-key-changed") {
    return "The SSH host key changed. Verify the desktop host before reconnecting.";
  }
  if (reason === "host-key-unverified") {
    return "The SSH host key must be verified before connecting.";
  }
  return "Connection credentials are required before reconnecting.";
}

function profileSummary(profile: SavedConnectionProfile) {
  if (isDirectCoreConnectionProfile(profile)) {
    return profile.coreUrl;
  }
  return `${profile.username || "User"}@${profile.sshHost}:${profile.sshPort} -> ${profile.remoteCoreHost}:${profile.remoteCorePort}`;
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    panel: {
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      padding: theme.spacing[4],
      gap: theme.spacing[3],
    },
    title: {
      color: theme.colors.text,
      fontSize: 18,
      fontWeight: "700",
    },
    body: {
      color: theme.colors.textSubtle,
      fontSize: 14,
      lineHeight: 20,
    },
    warning: {
      color: theme.colors.warning,
      fontSize: 13,
      lineHeight: 19,
    },
    actions: {
      flexDirection: "row",
      gap: theme.spacing[2],
    },
  });
}
