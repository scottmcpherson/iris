import type { ReactNode } from "react";
import { cn } from "../../shared/ui/utils";

export type AgentContentLayout = "index" | "record" | "workbench";

export function AgentContentFrame({
  layout,
  className,
  fillsHeight = false,
  children,
}: {
  layout: AgentContentLayout;
  className?: string;
  fillsHeight?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "agent-content-scroll grid grid-rows-[minmax(0,1fr)] min-w-0 min-h-0 max-h-full h-full overflow-x-hidden",
        fillsHeight ? "overflow-y-hidden" : "overflow-y-auto",
      )}
    >
      <div
        className={cn(
          "agent-content-frame grid w-[min(calc(100%-(var(--agent-page-gutter)*2)),var(--agent-frame-max-width))] min-w-0 mx-auto pt-6 pb-[30px]",
          className,
        )}
        data-layout={layout}
      >
        {children}
      </div>
    </div>
  );
}
