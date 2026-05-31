import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface AppUpdatesController {
  /** Current phase of the update lifecycle. */
  status: AppUpdateStatus;
  /** Target version when an update is available/ready, else null. */
  version: string | null;
  /** Download progress 0-100 while downloading, null when unknown/not downloading. */
  progressPct: number | null;
  /** Last error message, if status is "error". */
  error: string | null;
  /** Check for updates. Pass `{ silent: true }` for background checks (no "up to date"/error toasts). */
  checkForUpdates: (options?: { silent?: boolean }) => Promise<void>;
  /** Download and install the pending update, then mark it ready to relaunch. */
  install: () => Promise<void>;
  /** Relaunch the app to finish applying a downloaded update. */
  relaunchApp: () => Promise<void>;
}

// Re-check in the background a few times a day for long-running sessions.
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Drives the Tauri updater: check → download/install → relaunch.
 *
 * The same controller backs both the "Check for Updates…" menu item (via the
 * `iris://app-command` event handled in App.tsx) and the sidebar update button.
 * Auto-checking only runs in packaged production builds (`import.meta.env.PROD`)
 * so the Vite dev surface and the `*.desktop.dev` bundle never try to update.
 */
export function useAppUpdates(): AppUpdatesController {
  const [status, setStatus] = useState<AppUpdateStatus>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The pending Update instance bridges check() and downloadAndInstall().
  const pendingUpdate = useRef<Update | null>(null);
  // Prevents overlapping check/download cycles.
  const busy = useRef(false);
  // Once an update is downloaded we stop re-checking until the app relaunches.
  const relaunchPending = useRef(false);

  const install = useCallback(async () => {
    const update = pendingUpdate.current;
    if (!update || busy.current) return;
    busy.current = true;
    setStatus("downloading");
    setProgressPct(0);
    setError(null);
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            setProgressPct(0);
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgressPct(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
            break;
          case "Finished":
            setProgressPct(100);
            break;
        }
      });
      relaunchPending.current = true;
      setStatus("ready");
      toast.success(`Iris ${update.version} is ready to install.`, {
        description: "Restart Iris to finish updating.",
        action: { label: "Restart now", onClick: () => void relaunch() },
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setStatus("error");
      setError(message);
      toast.error("Iris could not install the update.", { description: message });
    } finally {
      busy.current = false;
    }
  }, []);

  const checkForUpdates = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!isTauri()) {
        if (!silent) toast.info("Updates are only available in the Iris desktop app.");
        return;
      }
      if (busy.current) return;
      if (relaunchPending.current) {
        if (!silent) {
          toast.success("An update is ready to install.", {
            description: "Restart Iris to finish updating.",
            action: { label: "Restart now", onClick: () => void relaunch() },
          });
        }
        return;
      }
      busy.current = true;
      setStatus("checking");
      setError(null);
      try {
        const update = await check();
        if (update?.available) {
          pendingUpdate.current = update;
          setVersion(update.version);
          setStatus("available");
          toast.message(`Update available: Iris ${update.version}`, {
            description: "Download and install the latest version.",
            action: { label: "Install", onClick: () => void install() },
          });
        } else {
          pendingUpdate.current = null;
          setVersion(null);
          setStatus("idle");
          if (!silent) toast.success("Iris is up to date.");
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        if (!silent) {
          setStatus("error");
          toast.error("Iris could not check for updates.", { description: message });
        } else {
          // Background checks fail quietly (offline, transient, or repo not yet public)
          // so the sidebar button never alarms the user over an unprompted check.
          setStatus("idle");
          console.warn("Silent update check failed:", message);
        }
      } finally {
        busy.current = false;
      }
    },
    [install],
  );

  const relaunchApp = useCallback(async () => {
    await relaunch();
  }, []);

  // Production-only: check once shortly after launch, then periodically.
  useEffect(() => {
    if (!import.meta.env.PROD || !isTauri()) return;
    void checkForUpdates({ silent: true });
    const id = window.setInterval(() => void checkForUpdates({ silent: true }), AUTO_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [checkForUpdates]);

  return { status, version, progressPct, error, checkForUpdates, install, relaunchApp };
}
