import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, FileText, Package, RefreshCw, RotateCw, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import type { AppUpdateStatus, AppUpdatesController } from "./useAppUpdates";

const RELEASE_NOTES_URL = "https://github.com/scottmcpherson/iris/releases/latest";

function formatReleaseDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function triggerVisual(
  status: AppUpdateStatus,
  progressPct: number | null,
): { Icon: LucideIcon; colorClass: string; spin: boolean; label: string } {
  switch (status) {
    case "downloading":
      return {
        Icon: RefreshCw,
        colorClass: "text-accent-cool-bright",
        spin: true,
        label: progressPct != null ? `Downloading update… ${progressPct}%` : "Downloading update…",
      };
    case "ready":
      return { Icon: RotateCw, colorClass: "text-accent-cool-bright", spin: false, label: "Update ready — restart Iris" };
    case "error":
      return { Icon: TriangleAlert, colorClass: "text-accent-warm-amber", spin: false, label: "Update error" };
    default:
      return { Icon: Package, colorClass: "text-accent-cool-bright", spin: false, label: "Update available" };
  }
}

/**
 * Update indicator pinned to the sidebar's top-right chrome row. It stays
 * hidden until an update is available (mosttly-style), then appears lit blue;
 * clicking it opens a popover with the version, release date, and actions.
 * Renders nothing outside the Tauri desktop shell.
 */
export function SidebarUpdateButton({ updates }: { updates: AppUpdatesController }) {
  const [open, setOpen] = useState(false);
  if (!isTauri()) return null;

  const { status, version, date, progressPct, error } = updates;
  // Nothing actionable while idle or mid-check — keep the chrome row clean.
  if (status === "idle" || status === "checking") return null;

  const { Icon: TriggerIcon, colorClass, spin, label } = triggerVisual(status, progressPct);
  const releasedOn = formatReleaseDate(date);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="chrome-action" aria-label={label} title={label}>
          <span className="relative inline-flex">
            <TriggerIcon size={16} className={[colorClass, spin ? "animate-spin" : ""].filter(Boolean).join(" ")} />
            {status === "available" ? (
              <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-accent-cool-bright" />
            ) : null}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} collisionPadding={16} className="w-[22rem] p-0">
        {status === "available" ? (
          <>
            <div className="flex flex-col gap-3 p-4">
              <div className="text-sm font-semibold text-foreground">Update Available</div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                <dt className="text-text-secondary">Version</dt>
                <dd className="text-foreground">{version}</dd>
                {releasedOn ? (
                  <>
                    <dt className="text-text-secondary">Released</dt>
                    <dd className="text-foreground">{releasedOn}</dd>
                  </>
                ) : null}
              </dl>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="appNeutral" size="xs" onClick={() => { updates.skip(); setOpen(false); }}>
                  Skip
                </Button>
                <Button variant="appNeutral" size="xs" onClick={() => setOpen(false)}>
                  Later
                </Button>
                <Button variant="default" size="xs" onClick={() => void updates.install()}>
                  Install and Relaunch
                </Button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void openUrl(RELEASE_NOTES_URL)}
              className="flex w-full items-center gap-2 border-t border-menu-border px-4 py-2.5 text-[13px] text-text-secondary hover:text-foreground"
            >
              <FileText size={14} />
              <span className="flex-1 text-left">View Release Notes</span>
              <ExternalLink size={13} />
            </button>
          </>
        ) : status === "downloading" ? (
          <div className="flex flex-col gap-2 p-4">
            <div className="text-sm font-semibold text-foreground">Downloading update…</div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-accent">
              <div className="h-full rounded-full bg-accent-cool-bright transition-[width] duration-200" style={{ width: `${progressPct ?? 0}%` }} />
            </div>
            <div className="text-[13px] text-text-secondary">
              {progressPct != null ? `${progressPct}%` : "Starting…"} · Iris will relaunch when ready.
            </div>
          </div>
        ) : status === "ready" ? (
          <div className="flex flex-col gap-3 p-4">
            <div className="text-sm font-semibold text-foreground">Update ready</div>
            <div className="text-[13px] text-text-secondary">Restart Iris to finish updating.</div>
            <div className="flex justify-end gap-2">
              <Button variant="appNeutral" size="appSmall" onClick={() => setOpen(false)}>
                Later
              </Button>
              <Button variant="default" size="appSmall" onClick={() => void updates.relaunchApp()}>
                Restart Now
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <div className="text-sm font-semibold text-foreground">Update error</div>
            <div className="text-[13px] break-words text-text-secondary">{error ?? "Something went wrong."}</div>
            <div className="flex justify-end gap-2">
              <Button variant="appNeutral" size="appSmall" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button variant="default" size="appSmall" onClick={() => void updates.checkForUpdates({ silent: false })}>
                Retry
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
