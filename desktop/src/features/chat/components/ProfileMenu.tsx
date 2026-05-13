import { Bot, ChevronDown } from "lucide-react";
import type { HermesProfile } from "../../../types/hermes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../../shared/ui/dropdown-menu";
import { Button } from "../../../shared/ui/button";

type ProfileMenuProps = {
  profile: string;
  profiles: HermesProfile[];
  connected: boolean;
  open: boolean;
  disabled: boolean;
  title: string;
  locked: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (profile: string) => void;
};

export function ProfileMenu({
  profile,
  profiles,
  connected,
  open,
  disabled,
  title,
  locked,
  onOpenChange,
  onSelect,
}: ProfileMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="composerAccess"
          size="composerAccess"
          title={title}
          aria-label={
            locked
              ? `Session agent ${profile}`
              : `Agent ${connected ? profile : "Offline"}`
          }
          disabled={disabled}
        >
          <Bot data-icon="inline-start" />
          <span>{connected ? profile : "Offline"}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={10}
        className="max-w-[min(280px,62vw)] min-w-[178px]"
      >
        <DropdownMenuLabel>Agents</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={profile} onValueChange={onSelect}>
          {profiles.map((item) => (
            <DropdownMenuRadioItem key={item.name} value={item.name}>
              {item.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
