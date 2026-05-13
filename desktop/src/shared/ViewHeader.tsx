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
    <div className="view-header">
      <div className="view-icon">{icon}</div>
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
