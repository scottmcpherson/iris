import type { HermesProfile, HermesStatus } from "../types/hermes";

export type RuntimeReadiness =
  | "checking"
  | "offline"
  | "core-only"
  | "gateway-stopped"
  | "adapter-unavailable"
  | "ready";

export type RuntimeReadinessTone = "ready" | "degraded" | "offline";

export function runtimeReadinessForStatus(
  status: HermesStatus | null,
  selectedProfile?: HermesProfile | null,
): RuntimeReadiness {
  if (!status) return "checking";
  if (!status?.connected) return "offline";
  if (!runtimeGatewayIsReachable(status, selectedProfile)) return "gateway-stopped";
  if (!runtimeAdapterIsReachable(status, selectedProfile)) return "adapter-unavailable";
  return "ready";
}

export function agentRuntimeReadinessForStatus(
  status: HermesStatus | null,
  profile?: HermesProfile | null,
): RuntimeReadiness {
  if (!status?.connected) return "offline";
  if (!profile?.gatewayRunning) return "gateway-stopped";
  if (activeApiStatusWasRequestedForProfile(status, profile) && !runtimeAdapterIsReachable(status, profile)) {
    return "adapter-unavailable";
  }
  return "ready";
}

export function runtimeGatewayIsReachable(
  status: HermesStatus | null,
  selectedProfile?: HermesProfile | null,
) {
  if (!status?.connected) return false;
  const profile = selectedProfile || status.activeProfile;
  return Boolean(status.gatewayStatus?.ok || profile?.gatewayRunning);
}

export function runtimeAdapterIsReachable(
  status: HermesStatus | null,
  selectedProfile?: HermesProfile | null,
) {
  if (!status?.connected || !status.activeApiStatus?.ok) return false;
  const profile = selectedProfile || status.activeProfile;
  if (!profile) return false;
  return activeApiStatusBelongsToProfile(status, profile);
}

export function runtimeStatusForProfileReadiness(
  primaryStatus: HermesStatus | null | undefined,
  fallbackStatus: HermesStatus | null | undefined,
  selectedProfile?: HermesProfile | null,
) {
  if (runtimeStatusCanDescribeProfile(primaryStatus, selectedProfile)) return primaryStatus ?? null;
  if (runtimeStatusCanDescribeProfile(fallbackStatus, selectedProfile)) return fallbackStatus ?? null;
  if (primaryStatus && !primaryStatus.connected) return primaryStatus;
  if (fallbackStatus && !fallbackStatus.connected) return fallbackStatus;
  return null;
}

export function runtimeReadinessTone(readiness: RuntimeReadiness): RuntimeReadinessTone {
  if (readiness === "offline") return "offline";
  if (readiness === "ready") return "ready";
  return "degraded";
}

export function runtimeReadinessShortLabel(readiness: RuntimeReadiness) {
  if (readiness === "checking") return "Connecting";
  if (readiness === "offline") return "Offline";
  if (readiness === "gateway-stopped") return "Gateway stopped";
  if (readiness === "adapter-unavailable") return "Adapter unavailable";
  if (readiness === "ready") return "Ready";
  return "Connecting";
}

export function runtimeReadinessLabel(readiness: RuntimeReadiness, profileName = "default") {
  if (readiness === "checking") return "Checking Core connection";
  if (readiness === "offline") return "Core offline";
  if (readiness === "gateway-stopped") return `${profileName} gateway stopped`;
  if (readiness === "adapter-unavailable") return `${profileName} adapter unavailable`;
  if (readiness === "ready") return `${profileName} ready`;
  return "Core connected";
}

export function runtimeReadinessDetail(readiness: RuntimeReadiness, profileName = "default", connectionMode = "") {
  if (readiness === "checking") return "";
  if (readiness === "offline" && connectionMode === "tailscale") {
    return "Can't reach the host over Tailscale. Make sure Tailscale is connected and Iris Core is running on that host, then retry.";
  }
  if (readiness === "offline") return "Start Iris Core, then retry.";
  if (readiness === "gateway-stopped") return `${profileName} gateway is stopped.`;
  if (readiness === "adapter-unavailable") return "Gateway is running, but the Iris adapter is unreachable. Restart the gateway.";
  if (readiness === "ready") return "";
  return "Core is connected, but runtime readiness is still being checked.";
}

export function runtimeReadinessGatewayAction(readiness: RuntimeReadiness): "start" | "restart" | null {
  if (readiness === "gateway-stopped") return "start";
  if (readiness === "adapter-unavailable" || readiness === "core-only") return "restart";
  return null;
}

function activeApiStatusBelongsToProfile(status: HermesStatus, profile: HermesProfile) {
  const endpointProfile = status.activeApiStatus?.requestedProfile || status.activeApiStatus?.profile;
  if (endpointProfile) return endpointProfile === profile.name;
  return status.activeProfile?.name === profile.name;
}

function activeApiStatusWasRequestedForProfile(status: HermesStatus, profile: HermesProfile) {
  const requestedProfile = status.activeApiStatus?.requestedProfile;
  if (requestedProfile) return requestedProfile === profile.name;
  return activeApiStatusBelongsToProfile(status, profile);
}

function runtimeStatusCanDescribeProfile(
  status: HermesStatus | null | undefined,
  profile?: HermesProfile | null,
) {
  if (!status) return false;
  if (!status.connected) return true;
  if (!profile) return false;
  return activeApiStatusWasRequestedForProfile(status, profile);
}
