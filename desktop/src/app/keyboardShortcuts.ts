import type { View } from "./types";

export type GlobalShortcutAction =
  | { type: "open-command-menu" }
  | { type: "refresh" }
  | { type: "select-view"; view: View };

type GlobalShortcutEvent = Pick<KeyboardEvent, "ctrlKey" | "defaultPrevented" | "key" | "metaKey" | "target">;

export function globalShortcutActionForKey(event: GlobalShortcutEvent) {
  if (event.defaultPrevented || isInsideCommandSurface(event.target)) return null;

  const commandKey = event.metaKey || event.ctrlKey;
  if (!commandKey) return null;

  const key = event.key.toLowerCase();
  if (key === "k") return { type: "open-command-menu" } satisfies GlobalShortcutAction;
  if (key === "r") return { type: "refresh" } satisfies GlobalShortcutAction;
  if (/^[1-3]$/.test(key)) {
    const views: View[] = ["chat", "agents", "jobs"];
    return { type: "select-view", view: views[Number(key) - 1] } satisfies GlobalShortcutAction;
  }

  return null;
}

function isInsideCommandSurface(target: EventTarget | null) {
  const maybeElement = target as { closest?: (selector: string) => unknown } | null;
  return Boolean(maybeElement?.closest?.('[data-slot="command"]'));
}
