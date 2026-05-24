import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  parseIrisDeepLink,
  type IrisRouteIntent,
} from "./routeIntent";

export type DeepLinkHandler = (intent: IrisRouteIntent) => void;

export async function installIrisDeepLinkHandlers(
  handleIntent: DeepLinkHandler,
  handleInvalidLink: (rawUrl: string) => void = () => {},
) {
  if (!isTauri()) return () => {};

  const processUrls = (urls: string[] | null) => {
    for (const rawUrl of urls || []) {
      const intent = parseIrisDeepLink(rawUrl);
      if (!intent) {
        handleInvalidLink(rawUrl);
        continue;
      }
      void focusCurrentWindow();
      handleIntent(intent);
    }
  };

  try {
    processUrls(await getCurrent());
  } catch (error) {
    console.warn("Could not read startup deep links.", error);
  }

  const unlisten = await onOpenUrl(processUrls);
  return unlisten;
}

async function focusCurrentWindow() {
  try {
    const window = getCurrentWindow();
    await window.unminimize();
    await window.show();
    await window.setFocus();
  } catch (error) {
    console.warn("Could not focus Iris for deep link.", error);
  }
}
