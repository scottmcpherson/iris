import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentTopbar } from "../AgentTopbar";
import type { HermesProfile } from "../../../types/hermes";

describe("AgentTopbar", () => {
  it("keeps the agent list topbar free of duplicate page and URL text", () => {
    const html = renderToStaticMarkup(
      createElement(AgentTopbar, {
        detailProfile: null,
        profile: profileFixture(),
        profiles: [profileFixture()],
        status: null,
        section: "overview",
        onSwitchAgent: noop,
        onManageAgents: noop,
        onSectionChange: noop,
      }),
    );

    expect(html).not.toContain("<p>Agents</p>");
    expect(html).not.toContain("127.0.0.1");
  });

  it("renders the agent switcher trigger with the current agent name and no breadcrumb", () => {
    const html = renderToStaticMarkup(
      createElement(AgentTopbar, {
        detailProfile: "default",
        profile: profileFixture(),
        profiles: [profileFixture()],
        status: null,
        section: "overview",
        onSwitchAgent: noop,
        onManageAgents: noop,
        onSectionChange: noop,
      }),
    );

    expect(html).toContain("agent-switcher-trigger");
    expect(html).toContain(">default<");
    expect(html).not.toContain("Agents / default");
    expect(html).not.toContain("agent-topbar-runtime-pill");
    expect(html).not.toContain("All agents");
  });
});

function noop() {}

function profileFixture(): HermesProfile {
  return {
    name: "default",
    path: "/tmp/default",
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
