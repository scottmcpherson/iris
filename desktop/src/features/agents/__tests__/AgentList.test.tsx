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
        onOpenAgent: noop,
        onProfileAction: noopProfileAction,
      }),
    );

    expect(html).toContain("More actions for health");
    expect(html).toContain("agent-list-menu-trigger");
    expect(html.includes(`sidebar-${"context"}-menu`)).toBe(false);
    expect(html.includes(`agent-list-${"context"}-menu`)).toBe(false);
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
