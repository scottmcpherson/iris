import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentList } from "../AgentList";
import type { HermesProfile } from "../../../types/hermes";

describe("AgentList", () => {
  it("renders button-driven agent actions without the legacy sidebar context menu", () => {
    const html = renderToStaticMarkup(
      createElement(AgentList, {
        profiles: [profileFixture({ name: "health" })],
        selectedProfile: "health",
        runtimeReadiness: "ready",
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
    expect(html).toContain("agent-list-menu-trigger");
    expect(html.includes(`sidebar-${"context"}-menu`)).toBe(false);
    expect(html.includes(`agent-list-${"context"}-menu`)).toBe(false);
  });

  it("shows gateway actions for stopped profiles", () => {
    const html = renderToStaticMarkup(
      createElement(AgentList, {
        profiles: [profileFixture({ name: "health", gatewayRunning: false })],
        selectedProfile: "health",
        runtimeReadiness: "gateway-stopped",
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
        selectedProfile: "health",
        runtimeReadiness: "gateway-stopped",
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
