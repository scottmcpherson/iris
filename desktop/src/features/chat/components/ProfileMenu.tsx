import { Bot, Check, ChevronDown } from "lucide-react";
import type { HermesProfile } from "../../../types/hermes";

type ProfileMenuProps = {
  profile: string;
  profiles: HermesProfile[];
  connected: boolean;
  open: boolean;
  disabled: boolean;
  title: string;
  locked: boolean;
  onToggle: () => void;
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
  onToggle,
  onSelect,
}: ProfileMenuProps) {
  return (
    <>
      <button
        type="button"
        className="composer-access-button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          locked
            ? `Conversation agent ${profile}`
            : `Agent ${connected ? profile : "Offline"}`
        }
        disabled={disabled}
        onClick={onToggle}
      >
        <Bot size={15} />
        <span>{connected ? profile : "Offline"}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="composer-profile-menu" role="menu" aria-label="Choose agent">
          <div className="composer-menu-header" role="presentation">Agents</div>
          {profiles.map((item) => (
            <button
              key={item.name}
              type="button"
              role="menuitemradio"
              aria-checked={item.name === profile}
              onClick={() => onSelect(item.name)}
            >
              <span>{item.name}</span>
              {item.name === profile ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
