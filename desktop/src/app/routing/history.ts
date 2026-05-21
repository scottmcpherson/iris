import { createBrowserHistory, createHashHistory } from "@tanstack/react-router";
import { isTauri } from "@tauri-apps/api/core";

export function createIrisHistory() {
  return isTauri() ? createHashHistory() : createBrowserHistory();
}
