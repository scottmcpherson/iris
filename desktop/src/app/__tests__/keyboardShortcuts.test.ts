import { describe, expect, it } from "vitest";
import { globalShortcutActionForKey } from "../keyboardShortcuts";

describe("globalShortcutActionForKey", () => {
  it("opens the command palette with Command+K or Control+K", () => {
    expect(shortcutForKey("k", { metaKey: true })).toEqual({
      type: "open-command-menu",
    });
    expect(shortcutForKey("K", { ctrlKey: true })).toEqual({
      type: "open-command-menu",
    });
  });

  it("does not open the command palette with Command+P", () => {
    expect(shortcutForKey("p", { metaKey: true })).toBeNull();
    expect(shortcutForKey("P", { ctrlKey: true })).toBeNull();
  });

  it("does not run global view shortcuts after a palette handles the event", () => {
    expect(shortcutForKey("2", { metaKey: true, defaultPrevented: true })).toBeNull();
  });

  it("does not run global view shortcuts from inside command surfaces", () => {
    expect(
      shortcutForKey("2", {
        metaKey: true,
        target: {
          closest: (selector: string) => selector === '[data-slot="command"]' ? {} : null,
        } as unknown as EventTarget,
      }),
    ).toBeNull();
  });
});

function shortcutForKey(
  key: string,
  overrides: Partial<Parameters<typeof globalShortcutActionForKey>[0]> = {},
) {
  return globalShortcutActionForKey({
    key,
    metaKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    target: null,
    ...overrides,
  });
}
