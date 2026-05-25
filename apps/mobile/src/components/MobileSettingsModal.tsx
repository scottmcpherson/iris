import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { X } from "lucide-react-native";
import { createDeviceToken, redeemMobilePairing } from "../connection/mobilePairing";
import {
  isDirectCoreConnectionProfile,
  parsePairingPayload,
  profileFromPairingPayload,
  type IrisMobilePairingPayloadV1,
  type SavedConnectionProfile,
  type SshConnectionProfile,
} from "../connection/pairingPayload";
import { useIrisConnection, type MobileConnectionState } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";
import { Button } from "./Button";
import { TextField } from "./TextField";

type MobileSettingsModalProps = {
  visible: boolean;
  onClose: () => void;
};

type NewConnectionMode = "tailscale" | "ssh";
type SshAuthMode = "password" | "key";

export function MobileSettingsModal({ visible, onClose }: MobileSettingsModalProps) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { connect, forget, pair, readHostKey, state } = useIrisConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const [payload, setPayload] = useState<IrisMobilePairingPayloadV1 | null>(null);
  const [rawPayload, setRawPayload] = useState("");
  const [error, setError] = useState("");
  const [scanned, setScanned] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [showNewConnection, setShowNewConnection] = useState(false);
  const [connectionMode, setConnectionMode] = useState<NewConnectionMode>("tailscale");
  const [sshLabel, setSshLabel] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUsername, setSshUsername] = useState("");
  const [sshCorePort, setSshCorePort] = useState("8765");
  const [sshAuthMode, setSshAuthMode] = useState<SshAuthMode>("password");
  const [sshPassword, setSshPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");
  const profile = "profile" in state ? state.profile : null;
  const showPairingFlow = showNewConnection || !profile;

  useEffect(() => {
    if (!visible) {
      resetNewConnectionForm();
    }
  }, [visible]);

  function resetNewConnectionForm() {
    setPayload(null);
    setRawPayload("");
    setError("");
    setScanned(false);
    setPairing(false);
    setShowNewConnection(false);
    setConnectionMode("tailscale");
    setSshLabel("");
    setSshHost("");
    setSshPort("22");
    setSshUsername("");
    setSshCorePort("8765");
    setSshAuthMode("password");
    setSshPassword("");
    setSshPrivateKey("");
    setSshPassphrase("");
  }

  function acceptRawPayload(value: string) {
    const result = parsePairingPayload(value);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPayload(result.payload);
    setError("");
  }

  async function pairAndConnect() {
    if (!payload) return;
    const token = createDeviceToken();
    setPairing(true);
    setError("");
    try {
      const result = await redeemMobilePairing(payload, token, Device.deviceName || "Iris Mobile");
      await pair(profileFromPairingPayload(payload, result.deviceId), { kind: "core-token", token });
      resetNewConnectionForm();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not pair with Iris Core.");
    } finally {
      setPairing(false);
    }
  }

  async function connectSshProfile() {
    const draft = buildSshProfile({
      corePort: sshCorePort,
      host: sshHost,
      label: sshLabel,
      port: sshPort,
      username: sshUsername,
    });
    if (!draft.ok) {
      setError(draft.error);
      return;
    }

    const auth =
      sshAuthMode === "password"
        ? { kind: "password" as const, password: sshPassword }
        : { kind: "key" as const, privateKey: sshPrivateKey, passphrase: sshPassphrase.trim() || undefined };
    if (sshAuthMode === "password" && !sshPassword) {
      setError("Enter the SSH password for this device.");
      return;
    }
    if (sshAuthMode === "key" && !sshPrivateKey.trim()) {
      setError("Paste the private key for this SSH connection.");
      return;
    }

    setPairing(true);
    setError("");
    try {
      const hostKeyFingerprint = await readHostKey(draft.profile);
      await pair({ ...draft.profile, hostKeyFingerprint }, auth);
      resetNewConnectionForm();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create the SSH connection.");
    } finally {
      setPairing(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaProvider>
        <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>Settings</Text>
            <Text style={styles.subtitle}>Connection and device pairing</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close settings"
            onPress={onClose}
            style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
          >
            <X color={theme.colors.textMuted} size={22} />
          </Pressable>
        </View>

        <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <Text style={[styles.panelTitle, styles.panelHeaderTitle]}>Current Connection</Text>
              <View style={styles.statusPill}>
                <View style={[styles.statusDot, connectionHealthy(state) ? styles.statusDotReady : styles.statusDotOffline]} />
                <Text style={styles.statusText}>{connectionStatusLabel(state)}</Text>
              </View>
            </View>
            <ConnectionDetailRows profile={profile} state={state} />
            {state.status === "blocked" ? <Text style={styles.warning}>{blockedText(state.reason)}</Text> : null}
            {state.status === "disconnected" && state.error ? <Text style={styles.warning}>{state.error}</Text> : null}
            <View style={styles.actions}>
              {profile ? <Button label="Reconnect" variant="secondary" onPress={() => void connect(profile)} /> : null}
              {profile ? <Button label="Forget" variant="danger" onPress={() => void forget()} /> : null}
            </View>
          </View>

          <View style={styles.panel}>
            <View style={styles.panelHeader}>
              <View style={styles.panelHeaderText}>
                <Text style={styles.panelTitle}>Connect to a Different Device</Text>
                <Text style={styles.body}>Use a Tailscale/direct Core pairing code or create an SSH tunnel.</Text>
              </View>
              {profile ? (
                <Button
                  label={showPairingFlow ? "Hide" : "New"}
                  variant="secondary"
                  onPress={() => setShowNewConnection((current) => !current)}
                  style={styles.panelHeaderAction}
                />
              ) : null}
            </View>

            {showPairingFlow ? (
              <View style={styles.pairingStack}>
                <View style={styles.modeTabs}>
                  <ConnectionModeButton
                    active={connectionMode === "tailscale"}
                    label="Tailscale"
                    onPress={() => {
                      setConnectionMode("tailscale");
                      setError("");
                    }}
                  />
                  <ConnectionModeButton
                    active={connectionMode === "ssh"}
                    label="SSH"
                    onPress={() => {
                      setConnectionMode("ssh");
                      setError("");
                    }}
                  />
                </View>

                {connectionMode === "tailscale" ? (
                  <>
                    <View style={styles.scannerPanel}>
                      {permission?.granted ? (
                        <CameraView
                          style={styles.camera}
                          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                          onBarcodeScanned={scanned ? undefined : ({ data }) => {
                            setScanned(true);
                            setRawPayload(data);
                            acceptRawPayload(data);
                          }}
                        />
                      ) : (
                        <View style={styles.permissionPanel}>
                          <Text style={styles.body}>Camera access is needed to scan Iris Desktop pairing QR codes.</Text>
                          <Button label="Allow Camera" onPress={() => void requestPermission()} />
                        </View>
                      )}
                    </View>

                    {payload ? (
                      <View style={styles.connectionPreview}>
                        <Text style={styles.previewTitle}>{payload.hostLabel}</Text>
                        <Text style={styles.body}>This will replace the current saved connection.</Text>
                        <Text selectable style={styles.monoText}>{payload.core.url}</Text>
                        <Button
                          label={pairing || state.status === "connecting" ? "Pairing" : "Pair and Connect"}
                          disabled={pairing || state.status === "connecting"}
                          onPress={() => void pairAndConnect()}
                        />
                      </View>
                    ) : null}

                    <TextField
                      label="Pairing payload"
                      value={rawPayload}
                      onChangeText={setRawPayload}
                      multiline
                      style={styles.payloadInput}
                      help="Paste the JSON payload from Iris Desktop if scanning is unavailable."
                    />
                    <View style={styles.actions}>
                      <Button label="Validate Payload" variant="secondary" onPress={() => acceptRawPayload(rawPayload)} />
                      {scanned ? <Button label="Scan Again" variant="ghost" onPress={() => setScanned(false)} /> : null}
                    </View>
                  </>
                ) : (
                  <View style={styles.sshForm}>
                    <TextField label="Device name" value={sshLabel} onChangeText={setSshLabel} placeholder="Mac mini" />
                    <TextField label="SSH host" value={sshHost} onChangeText={setSshHost} placeholder="mac-mini.local" />
                    <View style={styles.fieldRow}>
                      <View style={styles.fieldGrow}>
                        <TextField label="Username" value={sshUsername} onChangeText={setSshUsername} placeholder="scott" />
                      </View>
                      <View style={styles.fieldSmall}>
                        <TextField label="SSH port" value={sshPort} onChangeText={setSshPort} keyboardType="number-pad" />
                      </View>
                    </View>
                    <TextField label="Core port" value={sshCorePort} onChangeText={setSshCorePort} keyboardType="number-pad" />
                    <View style={styles.authTabs}>
                      <ConnectionModeButton
                        active={sshAuthMode === "password"}
                        label="Password"
                        onPress={() => {
                          setSshAuthMode("password");
                          setError("");
                        }}
                      />
                      <ConnectionModeButton
                        active={sshAuthMode === "key"}
                        label="Private key"
                        onPress={() => {
                          setSshAuthMode("key");
                          setError("");
                        }}
                      />
                    </View>
                    {sshAuthMode === "password" ? (
                      <TextField label="Password" value={sshPassword} onChangeText={setSshPassword} secureTextEntry />
                    ) : (
                      <>
                        <TextField
                          label="Private key"
                          value={sshPrivateKey}
                          onChangeText={setSshPrivateKey}
                          multiline
                          style={styles.payloadInput}
                        />
                        <TextField label="Passphrase" value={sshPassphrase} onChangeText={setSshPassphrase} secureTextEntry />
                      </>
                    )}
                    <Text style={styles.body}>Iris verifies the SSH host key before saving the new device.</Text>
                    <Button
                      label={pairing || state.status === "connecting" ? "Connecting" : "Verify and Connect"}
                      disabled={pairing || state.status === "connecting"}
                      onPress={() => void connectSshProfile()}
                    />
                  </View>
                )}
                {error ? <Text style={styles.error}>{error}</Text> : null}
              </View>
            ) : null}
          </View>
        </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function ConnectionModeButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.modeButton,
        active ? styles.modeButtonActive : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.modeButtonText, active ? styles.modeButtonTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

function ConnectionDetailRows({
  profile,
  state,
}: {
  profile: SavedConnectionProfile | null;
  state: MobileConnectionState;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  if (!profile) {
    return (
      <View style={styles.details}>
        <DetailRow label="Device" value="No saved device" />
        <DetailRow label="Method" value="Not connected" />
      </View>
    );
  }

  if (isDirectCoreConnectionProfile(profile)) {
    return (
      <View style={styles.details}>
        <DetailRow label="Device" value={profile.hostLabel} />
        <DetailRow label="Method" value="Tailscale / Direct Core" />
        <DetailRow label="Core URL" value={profile.coreUrl} monospaced />
        {profile.deviceId ? <DetailRow label="Mobile Device" value={profile.deviceId} monospaced /> : null}
      </View>
    );
  }

  return (
    <View style={styles.details}>
      <DetailRow label="Device" value={profile.hostLabel} />
      <DetailRow label="Method" value="SSH tunnel" />
      <DetailRow label="SSH Host" value={`${profile.username}@${profile.sshHost}:${profile.sshPort}`} monospaced />
      <DetailRow label="Core Target" value={`${profile.remoteCoreHost}:${profile.remoteCorePort}`} monospaced />
      {state.status === "connected" ? <DetailRow label="Local URL" value={state.localCoreUrl} monospaced /> : null}
    </View>
  );
}

function DetailRow({ label, monospaced, value }: { label: string; monospaced?: boolean; value: string }) {
  const theme = useTheme();
  const styles = createStyles(theme);
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text selectable style={[styles.detailValue, monospaced ? styles.monoText : null]}>{value}</Text>
    </View>
  );
}

function connectionHealthy(state: MobileConnectionState) {
  return state.status === "connected";
}

function connectionStatusLabel(state: MobileConnectionState) {
  if (state.status === "connected") return "Connected";
  if (state.status === "connecting") return "Connecting";
  if (state.status === "blocked") return "Needs attention";
  if (state.status === "disconnected") return "Disconnected";
  return "Not paired";
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

function buildSshProfile({
  corePort,
  host,
  label,
  port,
  username,
}: {
  corePort: string;
  host: string;
  label: string;
  port: string;
  username: string;
}): { ok: true; profile: SshConnectionProfile } | { ok: false; error: string } {
  const sshHost = host.trim();
  const sshUsername = username.trim();
  if (!sshHost) return { ok: false, error: "Enter the SSH host for this device." };
  if (!sshUsername) return { ok: false, error: "Enter the SSH username." };
  const sshPort = parsePort(port, "SSH port");
  if (!sshPort.ok) return sshPort;
  const remoteCorePort = parsePort(corePort, "Core port");
  if (!remoteCorePort.ok) return remoteCorePort;

  const now = Math.floor(Date.now() / 1000);
  const hostLabel = label.trim() || sshHost;
  const hostId = `ssh:${sshUsername}@${sshHost}:${sshPort.port}`;
  return {
    ok: true,
    profile: {
      id: `${hostId}:core:${remoteCorePort.port}`,
      hostId,
      hostLabel,
      transport: "ssh",
      sshHost,
      sshPort: sshPort.port,
      username: sshUsername,
      remoteCoreHost: "127.0.0.1",
      remoteCorePort: remoteCorePort.port,
      apiBasePath: "/v1",
      createdAt: now,
      updatedAt: now,
    },
  };
}

function parsePort(value: string, label: string): { ok: true; port: number } | { ok: false; error: string } {
  const trimmed = value.trim();
  const port = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== trimmed) {
    return { ok: false, error: `${label} must be a number from 1 to 65535.` };
  }
  return { ok: true, port };
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.colors.screen,
    },
    header: {
      minHeight: 76,
      paddingHorizontal: theme.spacing[4],
      paddingTop: theme.spacing[2],
      paddingBottom: theme.spacing[3],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[3],
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderSubtle,
    },
    headerText: {
      flex: 1,
      minWidth: 0,
      gap: 4,
    },
    title: {
      color: theme.colors.text,
      fontSize: 28,
      fontWeight: "700",
    },
    subtitle: {
      color: theme.colors.textMuted,
      fontSize: 14,
    },
    iconButton: {
      width: 48,
      height: 48,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.secondary,
      alignItems: "center",
      justifyContent: "center",
    },
    content: {
      flex: 1,
    },
    contentInner: {
      padding: theme.spacing[4],
      paddingBottom: theme.spacing[8],
      gap: theme.spacing[4],
    },
    panel: {
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      padding: theme.spacing[4],
      gap: theme.spacing[4],
    },
    panelHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: theme.spacing[3],
    },
    panelHeaderText: {
      flex: 1,
      minWidth: 0,
      gap: 4,
    },
    panelHeaderTitle: {
      flex: 1,
      minWidth: 0,
    },
    panelHeaderAction: {
      flexShrink: 0,
    },
    fieldRow: {
      flexDirection: "row",
      gap: theme.spacing[3],
    },
    fieldGrow: {
      flex: 1,
      minWidth: 0,
    },
    fieldSmall: {
      width: 104,
    },
    panelTitle: {
      color: theme.colors.text,
      fontSize: 18,
      fontWeight: "700",
    },
    body: {
      color: theme.colors.textSubtle,
      fontSize: 14,
      lineHeight: 20,
    },
    statusPill: {
      minHeight: 34,
      borderRadius: 17,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.secondary,
      paddingHorizontal: theme.spacing[3],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    statusDotReady: {
      backgroundColor: theme.colors.success,
    },
    statusDotOffline: {
      backgroundColor: theme.colors.warning,
    },
    statusText: {
      color: theme.colors.text,
      fontSize: 13,
      fontWeight: "700",
    },
    details: {
      gap: theme.spacing[2],
    },
    detailRow: {
      gap: 5,
    },
    detailLabel: {
      color: theme.colors.textMuted,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0,
    },
    detailValue: {
      color: theme.colors.text,
      fontSize: 15,
      lineHeight: 21,
    },
    monoText: {
      color: theme.colors.text,
      fontFamily: theme.typography.fontFamily.mono,
      fontSize: 12,
      lineHeight: 18,
    },
    warning: {
      color: theme.colors.warning,
      fontSize: 13,
      lineHeight: 19,
    },
    error: {
      color: theme.colors.danger,
      fontSize: 13,
      lineHeight: 18,
    },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing[2],
    },
    pairingStack: {
      gap: theme.spacing[3],
    },
    modeTabs: {
      minHeight: 44,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.input,
      flexDirection: "row",
      padding: 3,
      gap: 3,
    },
    authTabs: {
      minHeight: 42,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.input,
      flexDirection: "row",
      padding: 3,
      gap: 3,
    },
    modeButton: {
      flex: 1,
      minHeight: 36,
      borderRadius: theme.radius.sm,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing[2],
    },
    modeButtonActive: {
      backgroundColor: theme.colors.surfaceRaised,
    },
    modeButtonText: {
      color: theme.colors.textMuted,
      fontSize: 14,
      fontWeight: "700",
    },
    modeButtonTextActive: {
      color: theme.colors.text,
    },
    scannerPanel: {
      overflow: "hidden",
      height: 240,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surfaceRaised,
    },
    camera: {
      flex: 1,
    },
    permissionPanel: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: theme.spacing[4],
      gap: theme.spacing[3],
    },
    connectionPreview: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
      backgroundColor: theme.colors.input,
      padding: theme.spacing[3],
      gap: theme.spacing[2],
    },
    sshForm: {
      gap: theme.spacing[3],
    },
    previewTitle: {
      color: theme.colors.text,
      fontSize: 16,
      fontWeight: "700",
    },
    payloadInput: {
      minHeight: 112,
      textAlignVertical: "top",
    },
    pressed: {
      opacity: 0.76,
    },
  });
}
