import { Check, ChevronDown, Command } from "lucide-react";
import type { HermesStreamToolEvent } from "../../../types/hermes";
import { titleCase } from "../../../shared/strings";
import {
  streamToolEventFromLegacyContent,
  toolEventDetail,
  toolStatusLabel,
} from "../toolEvents";

export function StreamToolEvents({ events }: { events: HermesStreamToolEvent[] }) {
  return (
    <div className="tool-progress-list" aria-label="Live tool activity">
      {events.map((event) => {
        const detail = toolEventDetail(event);
        const key = event.callId || event.id || `${event.toolName}-${event.label}`;
        const label = event.label || titleCase(event.toolName);
        const statusLabel = toolStatusLabel(event.status);
        const summary = (
          <>
            <span className="tool-progress-icon">
              {event.status === "running" ? <Command size={13} /> : <Check size={13} />}
            </span>
            <span className="tool-progress-title">{label}</span>
            {detail ? <ChevronDown className="tool-progress-chevron" size={13} /> : null}
          </>
        );

        if (!detail) {
          return (
            <div key={key} className={`tool-progress-item ${event.status}`}>
              <div className="tool-progress-summary" aria-label={`${label} ${statusLabel}`}>{summary}</div>
            </div>
          );
        }

        return (
          <details key={key} className={`tool-progress-item ${event.status}`}>
            <summary className="tool-progress-summary" aria-label={`${label} ${statusLabel} details`}>
              {summary}
            </summary>
            <pre className="tool-progress-detail">{detail}</pre>
          </details>
        );
      })}
    </div>
  );
}

export function LegacyToolEvents({ content }: { content: string }) {
  return <StreamToolEvents events={[streamToolEventFromLegacyContent(content)]} />;
}
