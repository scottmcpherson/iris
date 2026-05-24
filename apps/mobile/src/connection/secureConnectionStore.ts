import * as SecureStore from "expo-secure-store";
import type { SavedConnectionProfile } from "./pairingPayload";
import type { SshAuthMethod } from "./sshTunnel";

const connectionProfileKey = "iris.mobile.connectionProfile.v1";
const connectionAuthKey = "iris.mobile.connectionAuth.v1";

export async function loadSavedConnectionProfile() {
  const raw = await SecureStore.getItemAsync(connectionProfileKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SavedConnectionProfile;
  } catch {
    await SecureStore.deleteItemAsync(connectionProfileKey);
    return null;
  }
}

export async function saveConnectionProfile(profile: SavedConnectionProfile) {
  await SecureStore.setItemAsync(
    connectionProfileKey,
    JSON.stringify({ ...profile, updatedAt: Math.floor(Date.now() / 1000) }),
  );
}

export async function loadSavedConnectionAuth() {
  const raw = await SecureStore.getItemAsync(connectionAuthKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SshAuthMethod;
  } catch {
    await SecureStore.deleteItemAsync(connectionAuthKey);
    return null;
  }
}

export async function saveConnectionAuth(auth: SshAuthMethod) {
  await SecureStore.setItemAsync(connectionAuthKey, JSON.stringify(auth));
}

export async function clearConnectionProfile() {
  await SecureStore.deleteItemAsync(connectionProfileKey);
  await SecureStore.deleteItemAsync(connectionAuthKey);
}
