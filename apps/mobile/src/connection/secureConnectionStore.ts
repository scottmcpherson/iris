import * as SecureStore from "expo-secure-store";
import type { SavedConnectionProfile } from "./pairingPayload";
import type { SshAuthMethod } from "./sshTunnel";

export type CoreTokenAuth = { kind: "core-token"; token: string };
export type ConnectionAuth = SshAuthMethod | CoreTokenAuth;

const connectionProfileKey = "iris.mobile.connectionProfile.v1";
const connectionAuthKey = "iris.mobile.connectionAuth.v1";

export async function loadSavedConnectionProfile() {
  const raw = await getStoredItem(connectionProfileKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SavedConnectionProfile;
  } catch {
    await deleteStoredItem(connectionProfileKey);
    return null;
  }
}

export async function saveConnectionProfile(profile: SavedConnectionProfile) {
  await setStoredItem(
    connectionProfileKey,
    JSON.stringify({ ...profile, updatedAt: Math.floor(Date.now() / 1000) }),
  );
}

export async function loadSavedConnectionAuth() {
  const raw = await getStoredItem(connectionAuthKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ConnectionAuth;
  } catch {
    await deleteStoredItem(connectionAuthKey);
    return null;
  }
}

export async function saveConnectionAuth(auth: ConnectionAuth) {
  await setStoredItem(connectionAuthKey, JSON.stringify(auth));
}

export async function clearConnectionProfile() {
  await deleteStoredItem(connectionProfileKey);
  await deleteStoredItem(connectionAuthKey);
}

async function canUseSecureStore() {
  if (
    typeof SecureStore.getItemAsync !== "function" ||
    typeof SecureStore.setItemAsync !== "function" ||
    typeof SecureStore.deleteItemAsync !== "function" ||
    typeof SecureStore.isAvailableAsync !== "function"
  ) {
    return false;
  }
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

async function getStoredItem(key: string) {
  if (!(await canUseSecureStore())) return null;
  return SecureStore.getItemAsync(key);
}

async function setStoredItem(key: string, value: string) {
  if (!(await canUseSecureStore())) return;
  await SecureStore.setItemAsync(key, value);
}

async function deleteStoredItem(key: string) {
  if (!(await canUseSecureStore())) return;
  await SecureStore.deleteItemAsync(key);
}
