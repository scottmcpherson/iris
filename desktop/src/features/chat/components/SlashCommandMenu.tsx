import { Command, Sparkles } from "lucide-react";
import type { MutableRefObject } from "react";
import type { HermesSlashCommand } from "../../../types/hermes";

type SlashCommandMenuProps = {
  commands: HermesSlashCommand[];
  activeIndex: number;
  loading: boolean;
  error: string | null;
  commandRefs: MutableRefObject<Record<string, HTMLButtonElement | null>>;
  onRefresh: () => void;
  onActiveIndex: (index: number) => void;
  onSelect: (command: HermesSlashCommand) => void;
};

export function SlashCommandMenu({
  commands,
  activeIndex,
  loading,
  error,
  commandRefs,
  onRefresh,
  onActiveIndex,
  onSelect,
}: SlashCommandMenuProps) {
  return (
    <div
      id="composer-slash-menu"
      className="composer-slash-menu"
      role="listbox"
      aria-label="Slash commands"
    >
      {loading && !commands.length ? (
        <div className="composer-slash-empty">Loading commands...</div>
      ) : null}
      {error && !commands.length ? (
        <button
          type="button"
          className="composer-slash-row disabled"
          onClick={onRefresh}
        >
          <span className="composer-slash-icon"><Command size={14} /></span>
          <span className="composer-slash-main">
            <strong>Commands unavailable</strong>
            <small>Click to retry</small>
          </span>
        </button>
      ) : null}
      {!loading && !error && !commands.length ? (
        <div className="composer-slash-empty">No matching commands</div>
      ) : null}
      {commands.map((command, index) => {
        const active = index === activeIndex;
        const meta = command.description || command.category || command.source;
        return (
          <button
            key={command.id}
            ref={(node) => {
              commandRefs.current[command.id] = node;
            }}
            type="button"
            className="composer-slash-row"
            role="option"
            aria-selected={active}
            data-active={active}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onActiveIndex(index)}
            onClick={() => onSelect(command)}
          >
            <span className="composer-slash-icon">
              {command.source === "skill" ? <Sparkles size={14} /> : <Command size={14} />}
            </span>
            <span className="composer-slash-main">
              <strong>{command.label || command.text}</strong>
              {meta ? <small>{meta}</small> : null}
            </span>
            <span className="composer-slash-meta">{active ? "Tab" : command.category}</span>
          </button>
        );
      })}
    </div>
  );
}
