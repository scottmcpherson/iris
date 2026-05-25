import { describe, expect, it } from "vitest";
import {
  mobileSidebarConnectionAccessibilityLabel,
  mobileSidebarConnectionStatusLabel,
  type MobileConnectionState,
} from "../connection/mobileConnectionStatus";
import type { SavedConnectionProfile } from "../connection/pairingPayload";

function profile(overrides: Partial<SavedConnectionProfile> = {}): SavedConnectionProfile {
  return {
    apiBasePath: "/v1",
    coreUrl: "http://iris.local:8765/v1",
    createdAt: 1,
    hostId: "host_local",
    hostLabel: "Local",
    id: "host_local:direct-core",
    transport: "direct-core",
    updatedAt: 1,
    ...overrides,
  };
}

describe("mobile sidebar connection status", () => {
  it("shows the active connection name when connected", () => {
    const state: MobileConnectionState = {
      status: "connected",
      profile: profile({ hostLabel: "Studio Mac" }),
      localCoreUrl: "http://iris.local:8765/v1",
    };

    expect(mobileSidebarConnectionStatusLabel(state)).toBe("Studio Mac");
    expect(mobileSidebarConnectionAccessibilityLabel(state)).toBe("Connected to Studio Mac");
  });

  it("keeps the connection name visible when disconnected", () => {
    const state: MobileConnectionState = {
      status: "disconnected",
      profile: profile({ hostLabel: "Studio Mac" }),
      error: "offline",
    };

    expect(mobileSidebarConnectionStatusLabel(state)).toBe("Studio Mac · Disconnected");
    expect(mobileSidebarConnectionAccessibilityLabel(state)).toBe("Disconnected from Studio Mac");
  });

  it("labels unpaired and blocked connection states", () => {
    expect(mobileSidebarConnectionStatusLabel({ status: "unpaired" })).toBe("Not paired");
    expect(
      mobileSidebarConnectionStatusLabel({
        status: "blocked",
        profile: profile(),
        reason: "core-unreachable",
      }),
    ).toBe("Local · Host unreachable");
  });
});
