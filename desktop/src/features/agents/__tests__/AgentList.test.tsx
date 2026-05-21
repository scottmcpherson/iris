import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentList } from "../AgentList";
import type { HermesProfile, HermesStatus } from "../../../types/hermes";

describe("AgentList", () => {
  it("renders button-driven agent actions without the legacy sidebar context menu", () => {
    const html = renderToStaticMarkup(
      createElement(AgentList, {
        profiles: [profileFixture({ name: "health" })],
        status: statusFixture(profileFixture({ name: "health" })),
        gatewayActionBusy: false,
        gatewayActionBusyAction: null,
        gatewayActionBusyProfile: "",
        adapterInstallBusyProfile: "",
        onOpenAgent: noop,
        onProfileAction: noopProfileAction,
        onGatewayAction: noop,
        onInstallAdapter: noop,
      }),
    );

    expect(html).toContain("More actions for health");
    expect(html).toContain("agent-content-frame");
    expect(html).toContain("data-layout=\"index\"");
    expect(html).toContain("agent-list-menu-trigger");
    expect(html.includes(`sidebar-${"context"}-menu`)).toBe(false);
    expect(html.includes(`agent-list-${"context"}-menu`)).toBe(false);
  });

  it("shows gateway actions for stopped profiles", () => {
    const html = renderToStaticMarkup(
      createElement(AgentList, {
        profiles: [profileFixture({ name: "health", gatewayRunning: false })],
        status: statusFixture(profileFixture({ name: "health", gatewayRunning: false })),
        gatewayActionBusy: false,
        gatewayActionBusyAction: null,
        gatewayActionBusyProfile: "",
        adapterInstallBusyProfile: "",
        onOpenAgent: noop,
        onProfileAction: noopProfileAction,
        onGatewayAction: noop,
        onInstallAdapter: noop,
      }),
    );

    expect(html).toContain("Gateway stopped");
    expect(html).toContain("Start gateway");
    expect(html).not.toContain("Diagnose");
  });

  it("shows in-progress feedback for the target gateway action", () => {
    const html = renderToStaticMarkup(
      createElement(AgentList, {
        profiles: [profileFixture({ name: "health", gatewayRunning: false })],
        status: statusFixture(profileFixture({ name: "health", gatewayRunning: false })),
        gatewayActionBusy: true,
        gatewayActionBusyAction: "start",
        gatewayActionBusyProfile: "health",
        adapterInstallBusyProfile: "",
        onOpenAgent: noop,
        onProfileAction: noopProfileAction,
        onGatewayAction: noop,
        onInstallAdapter: noop,
      }),
    );

    expect(html).toContain("Starting gateway...");
  });

  it("does not attribute another profile's failed adapter probe to a running agent", () => {
    const html = renderToStaticMarkup(
      createElement(AgentList, {
        profiles: [
          profileFixture({ name: "default", gatewayRunning: true }),
          profileFixture({ name: "health", gatewayRunning: false }),
        ],
        status: {
          ...statusFixture(profileFixture({ name: "default", gatewayRunning: true })),
          profiles: [
            profileFixture({ name: "default", gatewayRunning: true }),
            profileFixture({ name: "health", gatewayRunning: false }),
          ],
          activeApiStatus: {
            ok: false,
            profile: "default",
            requestedProfile: "health",
            error: "Iris adapter is for 'default', not 'health'.",
          },
        },
        gatewayActionBusy: false,
        gatewayActionBusyAction: null,
        gatewayActionBusyProfile: "",
        adapterInstallBusyProfile: "",
        onOpenAgent: noop,
        onProfileAction: noopProfileAction,
        onGatewayAction: noop,
        onInstallAdapter: noop,
      }),
    );

    expect(html).toContain("Running");
    expect(html).toContain("Gateway stopped");
    expect(html).not.toContain("Adapter unavailable");
  });

  it("does not offer gateway recovery while Core is offline", () => {
    const html = renderToStaticMarkup(
      createElement(AgentList, {
        profiles: [profileFixture({ name: "health", gatewayRunning: false })],
        status: { ...statusFixture(profileFixture({ name: "health", gatewayRunning: false })), connected: false },
        gatewayActionBusy: false,
        gatewayActionBusyAction: null,
        gatewayActionBusyProfile: "",
        adapterInstallBusyProfile: "",
        onOpenAgent: noop,
        onProfileAction: noopProfileAction,
        onGatewayAction: noop,
        onInstallAdapter: noop,
      }),
    );

    expect(html).toContain("Core offline");
    expect(html).not.toContain("Start gateway");
  });
});

function noop() {}

async function noopProfileAction() {
  return "";
}

function profileFixture(overrides: Partial<HermesProfile> = {}): HermesProfile {
  return {
    name: "default",
    path: "/tmp/default",
    active: false,
    exists: true,
    model: "gpt-5.5",
    provider: "openai-codex",
    memoryBytes: 0,
    memoryUpdatedAt: null,
    skillCount: 2,
    sessionCount: 0,
    estimatedCostUsd: null,
    gatewayRunning: true,
    ...overrides,
  };
}

function statusFixture(profile = profileFixture()): HermesStatus {
  return {
    ok: true,
    connected: true,
    root: "/tmp/hermes",
    hermesPath: "/tmp/hermes",
    version: "test",
    activeProfile: profile,
    profiles: [profile],
    checkedAt: 1,
    activeApiStatus: { ok: true, profile: profile.name },
  };
}
