import { Command as CommandIcon, Sparkles } from "lucide-react";
import { useLayoutEffect, useRef, type MutableRefObject } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "../../../shared/ui/command";
import { cn } from "../../../shared/ui/utils";
import type { RuntimeReadiness } from "../../../app/runtimeReadiness";
import { runtimeReadinessGatewayAction } from "../../../app/runtimeReadiness";
import type { HermesSlashCommand } from "../../../types/hermes";

type SlashCommandMenuProps = {
  commands: HermesSlashCommand[];
  activeIndex: number;
  loading: boolean;
  error: string | null;
  runtimeReadiness: RuntimeReadiness;
  profile: string;
  commandRefs: MutableRefObject<Record<string, HTMLElement | null>>;
  onRefresh: () => void;
  onGatewayAction: (action: "start" | "restart") => void;
  gatewayActionBusy?: boolean;
  gatewayActionBusyAction?: "start" | "restart" | "stop" | null;
  onActiveIndex: (index: number) => void;
  onSelect: (command: HermesSlashCommand) => void;
};

export function SlashCommandMenu({
  commands,
  activeIndex,
  loading,
  error,
  runtimeReadiness,
  profile,
  commandRefs,
  onRefresh,
  onGatewayAction,
  gatewayActionBusy = false,
  gatewayActionBusyAction = null,
  onActiveIndex,
  onSelect,
}: SlashCommandMenuProps) {
  const activeCommand = commands[activeIndex] || commands[0];
  const gatewayAction = runtimeReadinessGatewayAction(runtimeReadiness);
  const gatewayBusyLabel = gatewayActionLabel(gatewayAction, gatewayActionBusy, gatewayActionBusyAction);
  const unavailableDetail =
    gatewayBusyLabel ||
    (runtimeReadiness === "gateway-stopped"
      ? `${profile} gateway is stopped`
      : runtimeReadiness === "adapter-unavailable"
        ? "Iris adapter is unreachable"
        : "Click to retry");
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowClassName = cn(
    "group grid h-[50px] w-full min-w-0 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-[9px] overflow-hidden rounded-lg px-[9px] py-0 text-left text-[12px] font-[inherit] leading-none text-menu-foreground",
    "hover:bg-menu-hover hover:text-menu-hover-foreground",
    "data-[active=true]:bg-menu-hover data-[active=true]:text-menu-hover-foreground data-[active=true]:outline data-[active=true]:outline-1 data-[active=true]:outline-menu-border"
  );
  const iconClassName = "inline-flex size-[22px] items-center justify-center rounded-[7px] bg-secondary text-composer-icon-foreground group-hover:text-menu-hover-foreground group-data-[active=true]:bg-accent group-data-[active=true]:text-menu-hover-foreground";

  useLayoutEffect(() => {
    if (!activeCommand) return;
    const list = listRef.current;
    const item = commandRefs.current[activeCommand.id];
    if (!list || !item) return;

    const padding = 7;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top + padding) {
      list.scrollTop -= listRect.top + padding - itemRect.top;
    } else if (itemRect.bottom > listRect.bottom - padding) {
      list.scrollTop += itemRect.bottom - (listRect.bottom - padding);
    }
  }, [activeCommand, commandRefs]);

  return (
    <Command
      id="composer-slash-menu"
      className="absolute bottom-[calc(100%+8px)] left-0 z-[32] h-auto max-h-80 w-[min(460px,100%)] overflow-hidden rounded-xl border border-menu-border bg-menu p-[7px] text-menu-foreground shadow-context-menu"
      aria-label="Slash commands"
      shouldFilter={false}
      value={activeCommand?.id || ""}
      onValueChange={(value) => {
        const nextIndex = commands.findIndex((command) => command.id === value);
        if (nextIndex >= 0) onActiveIndex(nextIndex);
      }}
    >
      <CommandList ref={listRef} className="max-h-[306px] scroll-py-[7px] overflow-x-hidden overflow-y-auto">
        <CommandGroup className="p-0">
          {loading && !commands.length ? (
            <div className="px-[9px] py-[9px] text-[11px] font-[720] text-menu-muted-foreground">Loading commands...</div>
          ) : null}
          {error && !commands.length ? (
            <CommandItem
              value="commands-unavailable"
              className={rowClassName}
              onSelect={() => {
                if (gatewayActionBusy) return;
                if (gatewayAction) onGatewayAction(gatewayAction);
                else onRefresh();
              }}
              aria-disabled={gatewayActionBusy}
            >
              <span className={iconClassName}>
                <CommandIcon size={14} />
              </span>
              <span className="grid min-w-0 gap-1 overflow-hidden">
                <strong className="truncate text-[12px] font-[760] leading-[15px] text-menu-hover-foreground">Commands unavailable</strong>
                <small className="truncate text-[11px] font-[720] leading-[13px] text-menu-muted-foreground">{unavailableDetail}</small>
              </span>
            </CommandItem>
          ) : null}
          {!loading && !error && !commands.length ? <CommandEmpty>No matching commands</CommandEmpty> : null}
          {commands.map((command, index) => {
            const active = index === activeIndex;
            const meta = command.description || command.category || command.source;
            return (
              <CommandItem
                key={command.id}
                ref={(node) => {
                  commandRefs.current[command.id] = node;
                }}
                value={command.id}
                className={rowClassName}
                role="option"
                aria-selected={active}
                data-active={active}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onActiveIndex(index)}
                onSelect={() => onSelect(command)}
              >
                <span className={iconClassName}>
                  {command.source === "skill" ? <Sparkles size={14} /> : <CommandIcon size={14} />}
                </span>
                <span className="grid min-w-0 gap-1 overflow-hidden">
                  <strong className="truncate text-[12px] font-[760] leading-[15px] text-menu-hover-foreground">{command.label || command.text}</strong>
                  {meta ? <small className="truncate text-[11px] font-[720] leading-[13px] text-menu-muted-foreground">{meta}</small> : null}
                </span>
                <span className="max-w-[124px] truncate pl-2 text-[11px] font-[720] leading-[13px] text-menu-muted-foreground">
                  {command.category}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function gatewayActionLabel(
  action: "start" | "restart" | null,
  busy: boolean,
  busyAction: "start" | "restart" | "stop" | null,
) {
  if (action === "start" && busy && busyAction === "start") return "Starting gateway...";
  if (action === "restart" && busy && busyAction === "restart") return "Restarting gateway...";
  return "";
}
