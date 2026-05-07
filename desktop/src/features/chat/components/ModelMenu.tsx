import { Check, ChevronDown, Search, Zap } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from "react";
import type {
  HermesModelProvider,
  HermesModelSelection,
} from "../../../types/hermes";

type ModelMenuProps = {
  open: boolean;
  disabled: boolean;
  title: string;
  selection: HermesModelSelection | null;
  providers: HermesModelProvider[];
  activeOptionKey: string;
  modelSearch: string;
  modelError: string | null;
  searchRef: MutableRefObject<HTMLInputElement | null>;
  optionRefs: MutableRefObject<Record<string, HTMLButtonElement | null>>;
  onToggle: () => void;
  onSearch: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onSelect: (selection: HermesModelSelection) => void;
};

export function ModelMenu({
  open,
  disabled,
  title,
  selection,
  providers,
  activeOptionKey,
  modelSearch,
  modelError,
  searchRef,
  optionRefs,
  onToggle,
  onSearch,
  onSearchKeyDown,
  onSelect,
}: ModelMenuProps) {
  return (
    <>
      <button
        type="button"
        className="composer-model-button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model ${selection?.model || "unavailable"}`}
        disabled={disabled}
        onClick={onToggle}
      >
        <Zap size={14} />
        <span>{selection?.model || "Model"}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div className="composer-model-menu" role="menu" aria-label="Choose model">
          <label className="composer-model-search">
            <Search size={14} />
            <input
              ref={searchRef}
              value={modelSearch}
              placeholder="Search models"
              aria-label="Search models"
              onChange={(event) => onSearch(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </label>
          {modelError ? <div className="composer-menu-note">{modelError}</div> : null}
          {providers.length ? null : (
            <div className="composer-menu-note">No matching models</div>
          )}
          {providers.map((provider) =>
            provider.models.length ? (
              <div key={provider.slug || provider.name} className="composer-model-group">
                <div className="composer-model-provider">{provider.name}</div>
                {provider.models.map((model) => {
                  const optionKey = modelOptionKey(provider.slug, model);
                  const selected =
                    selection?.provider === provider.slug &&
                    selection?.model === model;
                  const active = activeOptionKey === optionKey;
                  return (
                    <button
                      key={optionKey}
                      ref={(node) => {
                        optionRefs.current[optionKey] = node;
                      }}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      data-active={active}
                      onClick={() =>
                        onSelect({
                          provider: provider.slug,
                          model,
                          providerName: provider.name,
                        })
                      }
                    >
                      <span>{model}</span>
                      {selected ? <Check size={14} /> : null}
                    </button>
                  );
                })}
              </div>
            ) : null,
          )}
        </div>
      ) : null}
    </>
  );
}

function modelOptionKey(provider: string, model: string) {
  return `${provider}:${model}`;
}
