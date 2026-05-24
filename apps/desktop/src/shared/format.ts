import type { HermesStatus } from "../types/hermes";

export function formatBytes(bytes: number) {
  if (!bytes) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function endpointLabel(endpoint?: HermesStatus["gatewayStatus"]) {
  if (!endpoint) return "Not checked";
  if (endpoint.ok) return `Healthy${endpoint.status ? ` (${endpoint.status})` : ""} ${endpoint.url || ""}`.trim();
  return `Unhealthy - ${endpoint.error || "Offline"}`;
}
