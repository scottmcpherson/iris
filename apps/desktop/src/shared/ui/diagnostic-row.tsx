import { AlertCircle, CheckCircle2, type LucideIcon } from "lucide-react";
import { Button } from "./button";

export type DiagnosticRowAction = {
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  onClick: () => void;
};

export type DiagnosticRowTone = "ready" | "degraded" | "offline";

export function DiagnosticRow({
  label,
  sublabel,
  ok,
  tone,
  action,
}: {
  label: string;
  sublabel?: string;
  ok: boolean;
  tone: DiagnosticRowTone;
  action?: DiagnosticRowAction | null;
}) {
  const ActionIcon = action?.icon;
  return (
    <div className={`diagnostics-row ${tone}`}>
      <span className="diagnostics-row-icon grid flex-none place-items-center" aria-hidden>
        {ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      </span>
      <div className="flex-1 inline-flex items-baseline gap-2 min-w-0 overflow-hidden">
        <strong className="text-[13px] font-semibold text-foreground truncate">{label}</strong>
        {sublabel ? <span className="text-[12px] text-muted-foreground truncate">{sublabel}</span> : null}
      </div>
      {action ? (
        <Button
          className="flex-none ml-auto"
          variant="appNeutral"
          size="appSmall"
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {ActionIcon ? <ActionIcon data-icon="inline-start" /> : null}
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
