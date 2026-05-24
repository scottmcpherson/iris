import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { AppScreen } from "../components/AppScreen";
import { Button } from "../components/Button";
import { TextField } from "../components/TextField";
import { parsePairingPayload, profileFromPairingPayload, type IrisMobilePairingPayloadV1 } from "../connection/pairingPayload";
import { createDeviceToken, redeemMobilePairing } from "../connection/mobilePairing";
import { useIrisConnection } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";

export function PairScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { pair, state } = useIrisConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const [payload, setPayload] = useState<IrisMobilePairingPayloadV1 | null>(null);
  const [rawPayload, setRawPayload] = useState("");
  const [error, setError] = useState("");
  const [scanned, setScanned] = useState(false);
  const [pairing, setPairing] = useState(false);

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
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not pair with Iris Core.");
    } finally {
      setPairing(false);
    }
  }

  return (
    <AppScreen title="Pair Device" subtitle="Scan the QR code from Iris Desktop settings.">
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
            <Text style={styles.body}>Camera permission is required to scan pairing QR codes.</Text>
            <Button label="Allow Camera" onPress={() => void requestPermission()} />
          </View>
        )}
      </View>

      {payload ? (
        <View style={styles.panel}>
          <Text style={styles.title}>{payload.hostLabel}</Text>
          <Text style={styles.body}>Iris Mobile will connect directly to this Core over Tailscale.</Text>
          <View style={styles.fingerprintPanel}>
            <Text style={styles.fingerprintLabel}>Core URL</Text>
            <Text selectable style={styles.fingerprintValue}>{payload.core.url}</Text>
          </View>
          <Button
            label={pairing || state.status === "connecting" ? "Pairing" : "Pair and Connect"}
            disabled={pairing || state.status === "connecting"}
            onPress={() => void pairAndConnect()}
          />
        </View>
      ) : null}

      <View style={styles.panel}>
        <Text style={styles.title}>Troubleshooting</Text>
        <Text style={styles.body}>If scanning is unavailable, paste the QR payload JSON from desktop diagnostics.</Text>
        <TextField
          label="Pairing payload"
          value={rawPayload}
          onChangeText={setRawPayload}
          multiline
          style={styles.payloadInput}
        />
        <Button label="Validate Payload" variant="secondary" onPress={() => acceptRawPayload(rawPayload)} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {scanned ? <Button label="Scan Again" variant="ghost" onPress={() => setScanned(false)} /> : null}
      </View>
    </AppScreen>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    scannerPanel: {
      overflow: "hidden",
      height: 280,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
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
    error: {
      color: theme.colors.danger,
      fontSize: 13,
      lineHeight: 18,
    },
    fingerprintPanel: {
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
      backgroundColor: theme.colors.input,
      padding: theme.spacing[3],
      gap: theme.spacing[1],
    },
    fingerprintLabel: {
      color: theme.colors.textSubtle,
      fontSize: 12,
      fontWeight: "700",
    },
    fingerprintValue: {
      color: theme.colors.text,
      fontFamily: theme.typography.fontFamily.mono,
      fontSize: 12,
      lineHeight: 17,
    },
    payloadInput: {
      minHeight: 120,
      textAlignVertical: "top",
    },
  });
}
