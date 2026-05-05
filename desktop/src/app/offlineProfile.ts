import type { HermesProfile } from "../types/hermes";

export const offlineProfile: HermesProfile = {
  name: "default",
  path: "~/.hermes",
  active: true,
  exists: false,
  model: "not configured",
  provider: "not configured",
  memoryBytes: 0,
  memoryUpdatedAt: null,
  skillCount: 0,
  sessionCount: 0,
  estimatedCostUsd: null,
  gatewayRunning: false,
};
