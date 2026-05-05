import { useEffect, useMemo, useState } from "react";
import { Command, Search, X } from "lucide-react";
import type { CommandItem } from "../../app/types";

type CommandMenuProps = {
  commands: CommandItem[];
  open: boolean;
  onClose: () => void;
};

export function CommandMenu({ commands, open, onClose }: CommandMenuProps) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const filteredCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.detail} ${command.shortcut || ""}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  if (!open) return null;

  return (
    <div className="command-scrim" role="presentation" onMouseDown={onClose}>
      <section
        className="command-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-search">
          <Search size={16} />
          <input
            autoFocus
            value={query}
            placeholder="Search commands"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "Enter" && filteredCommands[0]) {
                filteredCommands[0].run();
                onClose();
              }
            }}
          />
          <button className="icon-button" title="Close command menu" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="command-list">
          {filteredCommands.length ? (
            filteredCommands.map((command) => (
              <button
                key={command.id}
                className="command-row"
                onClick={() => {
                  command.run();
                  onClose();
                }}
              >
                <Command size={15} />
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.detail}</small>
                </span>
                {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
              </button>
            ))
          ) : (
            <p className="command-empty">No matching commands.</p>
          )}
        </div>
      </section>
    </div>
  );
}
