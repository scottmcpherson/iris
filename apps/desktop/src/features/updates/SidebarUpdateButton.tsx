import { isTauri } from "@tauri-apps/api/core";
import { AlertTriangle, Download, RefreshCw, RotateCw, type LucideIcon } from "lucide-react";
import type { AppUpdatesController } from "./useAppUpdates";

interface SidebarUpdateButtonProps {
  updates: AppUpdatesController;
}

interface StateConfig {
  Icon: LucideIcon;
  label: string;
  /** Tailwind text-color utility (token-backed) applied to the icon, if any. */
  colorClass?: string;
  spin?: boolean;
  dot?: boolean;
  onClick: () => void;
}

/**
 * Compact updater affordance pinned to the top-right of the sidebar header.
 * Doubles as a status indicator and an action button: its icon, tint, and
 * click behaviour are derived from the shared {@link AppUpdatesController}.
 * Renders nothing outside the Tauri desktop shell (e.g. the Vite web surface).
 */
export function SidebarUpdateButton({ updates }: SidebarUpdateButtonProps) {
  if (!isTauri()) return null;

  const { status, version, progressPct } = updates;
  const recheck = () => void updates.checkForUpdates({ silent: false });

  const config: StateConfig = ((): StateConfig => {
    switch (status) {
      case "checking":
        return { Icon: RefreshCw, label: "Checking for updates…", spin: true, onClick: () => {} };
      case "available":
        return {
          Icon: Download,
          label: version ? `Install Iris ${version}` : "Install update",
          colorClass: "text-accent-cool-bright",
          dot: true,
          onClick: () => void updates.install(),
        };
      case "downloading":
        return {
          Icon: RefreshCw,
          label:
            progressPct != null ? `Downloading update… ${progressPct}%` : "Downloading update…",
          colorClass: "text-accent-cool-bright",
          spin: true,
          onClick: () => {},
        };
      case "ready":
        return {
          Icon: RotateCw,
          label: "Restart to finish updating",
          colorClass: "text-accent-cool-bright",
          onClick: () => void updates.relaunchApp(),
        };
      case "error":
        return {
          Icon: AlertTriangle,
          label: "Update check failed — click to retry",
          colorClass: "text-accent-warm-amber",
          onClick: recheck,
        };
      default:
        return { Icon: RefreshCw, label: "Check for updates", onClick: recheck };
    }
  })();

  const { Icon, label, colorClass, spin, dot, onClick } = config;
  const iconClass = [colorClass, spin ? "animate-spin" : ""].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      className="chrome-action"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <span className="relative inline-flex">
        <Icon size={16} className={iconClass || undefined} />
        {dot ? (
          <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-accent-cool-bright" />
        ) : null}
      </span>
    </button>
  );
}
