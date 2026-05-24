import { useEffect, useMemo, useState } from "react";
import { Command as CommandIcon } from "lucide-react";
import type { CommandItem as AppCommandItem } from "../../app/types";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../../shared/ui/command";

type CommandMenuProps = {
  commands: AppCommandItem[];
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
    <CommandDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title="Command menu"
      description="Search commands"
      commandProps={{ shouldFilter: false }}
      showCloseButton={false}
    >
      <CommandInput
        autoFocus
        value={query}
        placeholder="Search commands"
        aria-label="Search commands"
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[430px]">
        {filteredCommands.length ? (
          <CommandGroup heading="Commands">
            {filteredCommands.map((command) => (
              <CommandItem
                key={command.id}
                value={`${command.label} ${command.detail} ${command.shortcut || ""}`}
                className="grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]"
                onSelect={() => {
                  command.run();
                  onClose();
                }}
              >
                <CommandIcon data-icon="inline-start" />
                <span className="grid min-w-0 gap-0.5">
                  <strong className="truncate font-[760]">{command.label}</strong>
                  <small className="truncate text-xs text-menu-muted-foreground group-data-[selected=true]:text-menu-selected-muted-foreground">
                    {command.detail}
                  </small>
                </span>
                {command.shortcut ? <CommandShortcut>{command.shortcut}</CommandShortcut> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : (
          <CommandEmpty>No matching commands.</CommandEmpty>
        )}
      </CommandList>
    </CommandDialog>
  );
}
