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
        section: "overview",
        onBack: noop,
        onSectionChange: noop,
      }),
    );

    expect(html).not.toContain("<p>Agents</p>");
    expect(html).not.toContain("127.0.0.1");
  });

  it("renders the agent detail title without the runtime pill or avatar", () => {
    const html = renderToStaticMarkup(
      createElement(AgentTopbar, {
        detailProfile: "default",
        profile: profileFixture(),
        section: "overview",
        onBack: noop,
        onSectionChange: noop,
      }),
    );

    expect(html).toContain("Agents / default");
    expect(html).not.toContain("agent-topbar-runtime-pill");
    expect(html).not.toContain("agent-avatar");
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
