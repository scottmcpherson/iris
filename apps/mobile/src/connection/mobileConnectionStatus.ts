import type { SavedConnectionProfile } from "./pairingPayload";

export type MobileConnectionState =
  | { status: "unpaired" }
  | { status: "connecting"; profile: SavedConnectionProfile }
  | { status: "connected"; profile: SavedConnectionProfile; localCoreUrl: string }
  | { status: "disconnected"; profile: SavedConnectionProfile; error?: string }
  | {
      status: "blocked";
      profile: SavedConnectionProfile;
      reason: "auth-required" | "core-unreachable";
    };

export function mobileConnectionDisplayName(state: MobileConnectionState) {
  if (!("profile" in state)) return "Iris Core";
  const hostLabel = state.profile.hostLabel.trim();
  return hostLabel || "Iris Core";
}

export function mobileSidebarConnectionStatusLabel(state: MobileConnectionState) {
  const connectionName = mobileConnectionDisplayName(state);
  switch (state.status) {
    case "unpaired":
      return "Not paired";
    case "connecting":
      return `Connecting to ${connectionName}`;
    case "connected":
      return connectionName;
    case "disconnected":
      return `${connectionName} · Disconnected`;
    case "blocked":
      return state.reason === "core-unreachable"
        ? `${connectionName} · Host unreachable`
        : `${connectionName} · Needs credentials`;
  }
}

export function mobileSidebarConnectionAccessibilityLabel(state: MobileConnectionState) {
  const connectionName = mobileConnectionDisplayName(state);
  switch (state.status) {
    case "unpaired":
      return "Not paired";
    case "connecting":
      return `Connecting to ${connectionName}`;
    case "connected":
      return `Connected to ${connectionName}`;
    case "disconnected":
      return `Disconnected from ${connectionName}`;
    case "blocked":
      return state.reason === "core-unreachable"
        ? `${connectionName} is unreachable`
        : `${connectionName} needs credentials`;
  }
}
