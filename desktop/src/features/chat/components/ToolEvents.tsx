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
        const summary = (
          <>
            <span className="tool-progress-icon">
              {event.status === "running" ? <Command size={15} /> : <Check size={15} />}
            </span>
            <span className="tool-progress-title">{event.label || titleCase(event.toolName)}</span>
            <span className="tool-progress-status">{toolStatusLabel(event.status)}</span>
            {detail ? <ChevronDown className="tool-progress-chevron" size={14} /> : null}
          </>
        );

        if (!detail) {
          return (
            <div key={key} className={`tool-progress-item ${event.status}`}>
              <div className="tool-progress-summary">{summary}</div>
            </div>
          );
        }

        return (
          <details key={key} className={`tool-progress-item ${event.status}`}>
            <summary className="tool-progress-summary" aria-label={`${event.label || event.toolName} details`}>
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
