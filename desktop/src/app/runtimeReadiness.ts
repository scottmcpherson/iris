import type { HermesProfile, HermesStatus } from "../types/hermes";

export type RuntimeReadiness =
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
  if (!status?.connected) return "offline";
  if (!runtimeGatewayIsReachable(status, selectedProfile)) return "gateway-stopped";
  if (!status.activeApiStatus?.ok) return "adapter-unavailable";
  if (status.activeApiStatus?.ok) return "ready";
  return "core-only";
}

export function agentRuntimeReadinessForStatus(
  status: HermesStatus | null,
  profile?: HermesProfile | null,
): RuntimeReadiness {
  if (!status?.connected) return "offline";
  if (!profile?.gatewayRunning) return "gateway-stopped";
  if (activeApiStatusBelongsToProfile(status, profile) && status.activeApiStatus && !status.activeApiStatus.ok) {
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

export function runtimeReadinessTone(readiness: RuntimeReadiness): RuntimeReadinessTone {
  if (readiness === "offline") return "offline";
  if (readiness === "ready") return "ready";
  return "degraded";
}

export function runtimeReadinessShortLabel(readiness: RuntimeReadiness) {
  if (readiness === "offline") return "Offline";
  if (readiness === "gateway-stopped") return "Gateway stopped";
  if (readiness === "adapter-unavailable") return "Adapter unavailable";
  if (readiness === "ready") return "Ready";
  return "Connecting";
}

export function runtimeReadinessLabel(readiness: RuntimeReadiness, profileName = "default") {
  if (readiness === "offline") return "Core offline";
  if (readiness === "gateway-stopped") return `${profileName} gateway stopped`;
  if (readiness === "adapter-unavailable") return `${profileName} adapter unavailable`;
  if (readiness === "ready") return `${profileName} ready`;
  return "Core connected";
}

export function runtimeReadinessDetail(readiness: RuntimeReadiness, profileName = "default", connectionMode = "") {
  if (readiness === "offline" && connectionMode === "ssh") {
    return "Remote Core is offline. Start Iris Core on that host, then retry.";
  }
  if (readiness === "offline") return "Start Iris Core, then retry.";
  if (readiness === "gateway-stopped") return `${profileName} gateway is stopped. Start it to send messages.`;
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
  const endpointProfile = status.activeApiStatus?.profile || status.activeApiStatus?.requestedProfile;
  if (endpointProfile) return endpointProfile === profile.name;
  return status.activeProfile?.name === profile.name;
}
