import { describe, expect, it } from "vitest";
import { runtimeGatewayIsReachable, runtimeReadinessDetail, runtimeReadinessForStatus } from "../runtimeReadiness";
import type { HermesProfile, HermesStatus } from "../../types/hermes";

describe("runtimeReadinessForStatus", () => {
  it("keeps the initial status fetch separate from confirmed Core offline", () => {
    expect(runtimeReadinessForStatus(null, profileFixture())).toBe("checking");
    expect(runtimeReadinessDetail("checking")).toBe("");
  });

  it("separates Core connectivity from runtime readiness", () => {
    expect(runtimeReadinessForStatus({ ...statusFixture(), connected: false }, profileFixture())).toBe("offline");
    expect(
      runtimeReadinessForStatus(
        { ...statusFixture(), gatewayStatus: { ok: false }, activeApiStatus: { ok: false } },
        { ...profileFixture(), gatewayRunning: false },
      ),
    ).toBe("gateway-stopped");
    expect(
      runtimeReadinessForStatus(
        { ...statusFixture(), gatewayStatus: { ok: true }, activeApiStatus: { ok: false } },
        profileFixture(),
      ),
    ).toBe("adapter-unavailable");
    expect(runtimeReadinessForStatus(statusFixture(), profileFixture())).toBe("ready");
  });

  it("does not treat a reachable adapter as proof the selected gateway is available", () => {
    const staleProfile = { ...profileFixture(), gatewayRunning: false };

    expect(
      runtimeReadinessForStatus(
        { ...statusFixture(), gatewayStatus: { ok: true }, activeApiStatus: { ok: true } },
        staleProfile,
      ),
    ).toBe("ready");
    expect(
      runtimeGatewayIsReachable(
        { ...statusFixture(), gatewayStatus: { ok: false }, activeApiStatus: { ok: true } },
        staleProfile,
      ),
    ).toBe(false);
    expect(
      runtimeReadinessForStatus(
        { ...statusFixture(), gatewayStatus: { ok: false }, activeApiStatus: { ok: true } },
        staleProfile,
      ),
    ).toBe("gateway-stopped");
  });
});

function profileFixture(): HermesProfile {
  return {
    name: "default",
    path: "",
    active: true,
    exists: true,
    model: "gpt-5.5",
    provider: "openai",
    memoryBytes: 0,
    memoryUpdatedAt: null,
    skillCount: 0,
    sessionCount: 0,
    estimatedCostUsd: null,
    gatewayRunning: true,
  };
}

function statusFixture(): HermesStatus {
  const activeProfile = profileFixture();
  return {
    ok: true,
    connected: true,
    root: "",
    hermesPath: null,
    version: "test",
    activeProfile,
    profiles: [activeProfile],
    checkedAt: 1,
    gatewayStatus: { ok: true },
    activeApiStatus: { ok: true },
  };
}
