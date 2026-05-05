import type { ReactNode } from "react";

type ViewHeaderProps = {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  action: string;
  onAction?: () => void;
};

export function ViewHeader({ icon, eyebrow, title, action, onAction }: ViewHeaderProps) {
  return (
    <div className="view-header">
      <div className="view-icon">{icon}</div>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      <button className="small-button" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}
