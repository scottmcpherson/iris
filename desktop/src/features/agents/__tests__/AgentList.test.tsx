import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentListContextMenu } from "../AgentList";
import type { HermesProfile } from "../../../types/hermes";

describe("AgentListContextMenu", () => {
  it("uses the reusable fixed-position context menu shell", () => {
    const html = renderToStaticMarkup(
      createElement(AgentListContextMenu, {
        profile: profileFixture({ name: "health" }),
        top: 120,
        left: 320,
        onDismiss: noop,
        onDuplicate: noop,
        onDelete: noop,
      }),
    );

    expect(html).toContain("sidebar-context-menu agent-list-context-menu");
    expect(html).toContain("style=\"top:120px;left:320px\"");
    expect(html).toContain("Duplicate");
    expect(html).toContain("Delete");
    expect(html).not.toContain("profile-context-menu");
  });

  it("disables delete for the default agent", () => {
    const html = renderToStaticMarkup(
      createElement(AgentListContextMenu, {
        profile: profileFixture({ name: "default" }),
        top: 120,
        left: 320,
        onDismiss: noop,
        onDuplicate: noop,
        onDelete: noop,
      }),
    );

    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("The default agent cannot be deleted");
  });
});

function noop() {}

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
