import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HermesMemory, HermesStatus } from "../../../types/hermes";
import { MemoryView } from "../MemoryView";

describe("MemoryView", () => {
  it("renders revision counts and selected revision content from memory history", () => {
    const html = renderToStaticMarkup(
      createElement(MemoryView, {
        memory: memoryFixture(),
        profile: "default",
        status: statusFixture(),
        onSaveMemory: async () => "",
        onResetMemory: async () => "",
      }),
    );

    expect(html).toContain("Revision history");
    expect(html).toContain("MEMORY.md");
    expect(html).toContain("saved snapshots");
    expect(html).toContain("Before Iris save");
    expect(html).toContain("old memory facts");
    expect(html).toContain("+1");
    expect(html).toContain("-1");
  });

  it("frames empty revision history as Iris-managed snapshots", () => {
    const memory = memoryFixture({ history: [] });
    const html = renderToStaticMarkup(
      createElement(MemoryView, {
        memory,
        profile: "default",
        status: statusFixture(),
        onSaveMemory: async () => "",
        onResetMemory: async () => "",
      }),
    );

    expect(html).toContain("Snapshots appear here after Iris saves or resets MEMORY.md.");
    expect(html).not.toContain("all agent memory changes");
    expect(html).not.toContain("Complete history");
  });
});

function memoryFixture(overrides: Partial<HermesMemory> = {}): HermesMemory {
  return {
    ok: true,
    profile: "default",
    path: "/tmp/default/memories",
    memory: {
      name: "MEMORY.md",
      path: "/tmp/default/memories/MEMORY.md",
      exists: true,
      updatedAt: 1_774_199_763,
      bytes: 20,
      content: "current memory facts",
      contentHash: "current-memory-hash",
    },
    user: {
      name: "USER.md",
      path: "/tmp/default/memories/USER.md",
      exists: true,
      updatedAt: 1_774_199_763,
      bytes: 10,
      content: "user facts",
      contentHash: "user-hash",
    },
    history: [
      {
        id: "revision_1",
        file: "MEMORY.md",
        action: "save",
        updatedAt: 1_774_199_700,
        bytes: 16,
        summary: "Before Iris save",
        content: "old memory facts",
      },
    ],
    ...overrides,
  };
}

function statusFixture(): HermesStatus {
  return {
    ok: true,
    connected: true,
    root: "/tmp/hermes",
    hermesPath: "/tmp/hermes",
    version: "test",
    activeProfile: {
      name: "default",
      path: "/tmp/default",
      active: true,
      exists: true,
      model: "gpt-5.5",
      provider: "openai-codex",
      memoryBytes: 30,
      memoryUpdatedAt: 1_774_199_763,
      skillCount: 0,
      sessionCount: 0,
      estimatedCostUsd: null,
      gatewayRunning: true,
    },
    coreApiUrl: "http://127.0.0.1:8765",
    checkedAt: 1_774_199_763,
    profiles: [],
  };
}
