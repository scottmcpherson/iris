import type { ReactNode } from "react";
import { cn } from "../../shared/ui/utils";

export type AgentContentLayout = "index" | "record" | "workbench";

export function AgentContentFrame({
  layout,
  className,
  children,
}: {
  layout: AgentContentLayout;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("agent-content-frame", className)} data-layout={layout}>
      {children}
    </div>
  );
}
