import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { X } from "lucide-react-native";
import { createDeviceToken, redeemMobilePairing } from "../connection/mobilePairing";
import {
  parsePairingPayload,
  profileFromPairingPayload,
  type IrisMobilePairingPayloadV1,
  type SavedConnectionProfile,
} from "../connection/pairingPayload";
import { useIrisConnection, type MobileConnectionState } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";
import { Button } from "./Button";
import { TextField } from "./TextField";

type MobileSettingsModalProps = {
  visible: boolean;
  onClose: () => void;
};

export function MobileSettingsModal({ visible, onClose }: MobileSettingsModalProps) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { connect, forget, pair, state } = useIrisConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const [payload, setPayload] = useState<IrisMobilePairingPayloadV1 | null>(null);
  const [rawPayload, setRawPayload] = useState("");
  const [error, setError] = useState("");
  const [scanned, setScanned] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [showNewConnection, setShowNewConnection] = useState(false);
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
            <ConnectionDetailRows profile={profile} />
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
                <Text style={styles.body}>Scan a Tailscale/direct Core pairing code from Iris Desktop.</Text>
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

function ConnectionDetailRows({
  profile,
}: {
  profile: SavedConnectionProfile | null;
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

  return (
    <View style={styles.details}>
      <DetailRow label="Device" value={profile.hostLabel} />
      <DetailRow label="Method" value="Tailscale / Direct Core" />
      <DetailRow label="Core URL" value={profile.coreUrl} monospaced />
      {profile.deviceId ? <DetailRow label="Mobile Device" value={profile.deviceId} monospaced /> : null}
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

function blockedText(reason: "auth-required" | "core-unreachable") {
  if (reason === "core-unreachable") {
    return "Couldn't reach the host. Make sure Tailscale is connected on this phone and the host is online.";
  }
  return "Connection credentials are required before reconnecting.";
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
