import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UpdateAvailableActions } from "../SidebarUpdateButton";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

describe("UpdateAvailableActions", () => {
  it("keeps Skip and Later together at the left while Install stays separate", () => {
    const html = renderToStaticMarkup(
      createElement(UpdateAvailableActions, {
        updates: {
          skip: vi.fn(),
          install: vi.fn(),
        },
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain("flex items-center justify-between gap-2");
    expect(html).toContain("flex items-center gap-2");
    expect(html.indexOf("Skip")).toBeLessThan(html.indexOf("Later"));
    expect(html.indexOf("Later")).toBeLessThan(html.indexOf("Install and Relaunch"));
  });
});
