import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/shared/ui/utils";

const statusBannerVariants = cva(
  "flex items-center justify-between gap-2.5 rounded-[10px] border px-2.5 py-1.5 text-xs font-bold",
  {
    variants: {
      tone: {
        ready: "border-status-ready-border bg-status-ready-fill text-status-ready-text",
        degraded: "border-status-degraded-border bg-status-degraded-fill text-status-degraded-text",
        offline: "border-status-offline-border bg-status-offline-fill text-status-offline-text",
      },
      density: {
        compact: "px-2.5 py-1.5 text-xs",
        comfortable: "px-3 py-2.5 text-sm",
      },
    },
    defaultVariants: {
      tone: "degraded",
      density: "compact",
    },
  },
);

type StatusBannerProps = React.ComponentProps<"div"> &
  VariantProps<typeof statusBannerVariants> & {
    icon?: LucideIcon;
    action?: React.ReactNode;
  };

export function StatusBanner({
  tone,
  density,
  icon: Icon,
  action,
  className,
  children,
  ...props
}: StatusBannerProps) {
  return (
    <div
      data-slot="status-banner"
      role="status"
      className={cn(statusBannerVariants({ tone, density }), className)}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-2 overflow-hidden">
        {Icon ? <Icon size={density === "comfortable" ? 15 : 13} className="shrink-0" aria-hidden /> : null}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {children}
        </span>
      </span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  );
}
