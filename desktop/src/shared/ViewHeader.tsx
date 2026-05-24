import type { ReactNode } from "react";
import { Button } from "./ui/button";

type ViewHeaderProps = {
  icon: ReactNode;
  eyebrow?: string;
  title: string;
  action: string;
  onAction?: () => void;
};

export function ViewHeader({ icon, eyebrow, title, action, onAction }: ViewHeaderProps) {
  return (
    <div className="view-header grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 min-w-0">
      <div className="view-icon w-9 h-9 rounded-[10px]">{icon}</div>
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
      </div>
      <Button size="appSmall" onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}
