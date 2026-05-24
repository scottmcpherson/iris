import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { AppScreen } from "../components/AppScreen";
import { Button } from "../components/Button";
import { TextField } from "../components/TextField";
import { parsePairingPayload, profileFromPairingPayload, type IrisMobilePairingPayloadV1 } from "../connection/pairingPayload";
import { useIrisConnection } from "../connection/useIrisConnection";
import { useTheme } from "../theme/useTheme";

export function PairScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const { pair, readHostKey, state } = useIrisConnection();
  const [permission, requestPermission] = useCameraPermissions();
  const [payload, setPayload] = useState<IrisMobilePairingPayloadV1 | null>(null);
  const [rawPayload, setRawPayload] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hostKeyFingerprint, setHostKeyFingerprint] = useState("");
  const [error, setError] = useState("");
  const [scanned, setScanned] = useState(false);
  const [verifying, setVerifying] = useState(false);

  function acceptRawPayload(value: string) {
    const result = parsePairingPayload(value);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPayload(result.payload);
    setSshHost(result.payload.ssh.host);
    setUsername(result.payload.ssh.userHint || "");
    setHostKeyFingerprint("");
    setError("");
  }

  function updateSshHost(value: string) {
    setSshHost(value);
    setHostKeyFingerprint("");
  }

  function updateUsername(value: string) {
    setUsername(value);
    setHostKeyFingerprint("");
  }

  async function verifyHostKey() {
    if (!payload) return;
    const profile = profileFromPairingPayload(payload, username, sshHost);
    if (!profile.username) {
      setError("Enter the SSH username before verifying the host key.");
      return;
    }
    setVerifying(true);
    setError("");
    try {
      setHostKeyFingerprint(await readHostKey(profile));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not read the SSH host key.");
    } finally {
      setVerifying(false);
    }
  }

  async function saveAndConnect() {
    if (!payload) return;
    if (!password) {
      setError("Enter the SSH password before connecting.");
      return;
    }
    if (!hostKeyFingerprint) {
      setError("Verify and trust the SSH host key before connecting.");
      return;
    }
    await pair(
      { ...profileFromPairingPayload(payload, username, sshHost), hostKeyFingerprint },
      { kind: "password", password },
    );
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
          <Text style={styles.body}>SSH is required. The phone must be able to reach this desktop host.</Text>
          <TextField label="SSH host" value={sshHost} onChangeText={updateSshHost} />
          <TextField label="Username" value={username} onChangeText={updateUsername} />
          <TextField label="Password" value={password} onChangeText={setPassword} secureTextEntry />
          {hostKeyFingerprint ? (
            <View style={styles.fingerprintPanel}>
              <Text style={styles.fingerprintLabel}>SSH host key</Text>
              <Text selectable style={styles.fingerprintValue}>{hostKeyFingerprint}</Text>
            </View>
          ) : null}
          {hostKeyFingerprint ? (
            <Button
              label={state.status === "connecting" ? "Connecting" : "Trust Host and Connect"}
              disabled={state.status === "connecting"}
              onPress={() => void saveAndConnect()}
            />
          ) : (
            <Button
              label={verifying ? "Verifying" : "Verify Host Key"}
              disabled={verifying}
              onPress={() => void verifyHostKey()}
            />
          )}
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
