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
  /** Release date (RFC3339) of the available update, if provided. */
  date: string | null;
  /** Release notes / body of the available update, if provided. */
  notes: string | null;
  /** Download progress 0-100 while downloading, null when unknown/not downloading. */
  progressPct: number | null;
  /** Last error message, if status is "error". */
  error: string | null;
  /** Check for updates. Pass `{ silent: true }` for background checks (no toasts). */
  checkForUpdates: (options?: { silent?: boolean }) => Promise<void>;
  /** Download, install, and relaunch into the pending update. */
  install: () => Promise<void>;
  /** Relaunch the app to finish applying a downloaded update. */
  relaunchApp: () => Promise<void>;
  /** Skip the available version: remember it and stop surfacing it. */
  skip: () => void;
}

// Re-check in the background a few times a day for long-running sessions.
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SKIPPED_VERSION_KEY = "iris.updates.skippedVersion";

function readSkippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIPPED_VERSION_KEY);
  } catch {
    return null;
  }
}

/**
 * Drives the Tauri updater: check → download/install → relaunch.
 *
 * The same controller backs the "Check for Updates…" menu item (via the
 * `iris://app-command` event in App.tsx) and the sidebar update indicator,
 * which stays hidden until an update is available. Auto-checking only runs in
 * packaged production builds (`import.meta.env.PROD`).
 */
export function useAppUpdates(): AppUpdatesController {
  const [status, setStatus] = useState<AppUpdateStatus>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
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
      // "Install and Relaunch": restart straight into the new version.
      await relaunch();
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
        if (!silent) toast.success("An update is downloaded — restart Iris to finish.");
        return;
      }
      busy.current = true;
      // Keep an already-surfaced update visible while a background re-check runs.
      setStatus((prev) => (prev === "available" ? prev : "checking"));
      setError(null);
      try {
        const update = await check();
        const skippedVersion = readSkippedVersion();
        if (update?.available && !(silent && update.version === skippedVersion)) {
          pendingUpdate.current = update;
          setVersion(update.version);
          setDate(update.date ?? null);
          setNotes(update.body ?? null);
          setStatus("available");
        } else {
          pendingUpdate.current = null;
          setVersion(null);
          setStatus("idle");
          if (!silent) {
            toast.success(update?.available ? "That update is skipped." : "Iris is up to date.");
          }
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        if (!silent) {
          setStatus("error");
          toast.error("Iris could not check for updates.", { description: message });
        } else {
          // Background checks fail quietly (offline, transient, or repo not yet public).
          setStatus("idle");
          console.warn("Silent update check failed:", message);
        }
      } finally {
        busy.current = false;
      }
    },
    [],
  );

  const relaunchApp = useCallback(async () => {
    await relaunch();
  }, []);

  const skip = useCallback(() => {
    try {
      if (version) localStorage.setItem(SKIPPED_VERSION_KEY, version);
    } catch {
      // Non-fatal: skipping just won't persist.
    }
    pendingUpdate.current = null;
    setStatus("idle");
  }, [version]);

  // Production-only: check once shortly after launch, then periodically.
  useEffect(() => {
    if (!import.meta.env.PROD || !isTauri()) return;
    void checkForUpdates({ silent: true });
    const id = window.setInterval(() => void checkForUpdates({ silent: true }), AUTO_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [checkForUpdates]);

  return { status, version, date, notes, progressPct, error, checkForUpdates, install, relaunchApp, skip };
}
