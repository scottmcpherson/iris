import { Check, ChevronDown, Zap } from "lucide-react";
import type { MutableRefObject } from "react";
import type {
  HermesModelProvider,
  HermesModelSelection,
} from "../../../types/hermes";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../../../shared/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../shared/ui/popover";
import { Button } from "../../../shared/ui/button";

type ModelMenuProps = {
  open: boolean;
  disabled: boolean;
  title: string;
  selection: HermesModelSelection | null;
  providers: HermesModelProvider[];
  modelSearch: string;
  modelError: string | null;
  searchRef: MutableRefObject<HTMLInputElement | null>;
  onOpenChange: (open: boolean) => void;
  onSearch: (value: string) => void;
  onSelect: (selection: HermesModelSelection) => void;
};

export function ModelMenu({
  open,
  disabled,
  title,
  selection,
  providers,
  modelSearch,
  modelError,
  searchRef,
  onOpenChange,
  onSearch,
  onSelect,
}: ModelMenuProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="composerModel"
          size="composerModel"
          title={title}
          aria-label={`Model ${selection?.model || "unavailable"}`}
          disabled={disabled}
        >
          <Zap data-icon="inline-start" />
          <span>{selection?.model || "Model"}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="w-[min(360px,calc(100vw-32px))] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            ref={searchRef}
            value={modelSearch}
            placeholder="Search models"
            aria-label="Search models"
            onValueChange={onSearch}
          />
          <CommandList className="max-h-[312px]">
            {modelError ? (
              <CommandEmpty className="py-3 text-xs text-menu-danger">
                {modelError}
              </CommandEmpty>
            ) : null}
            {!modelError && !providers.length ? (
              <CommandEmpty className="py-3 text-xs text-menu-muted-foreground">
                No matching models
              </CommandEmpty>
            ) : null}
            {providers.map((provider, index) =>
              provider.models.length ? (
                <CommandGroup
                  key={provider.slug || provider.name}
                  heading={provider.name}
                >
                  {index > 0 ? <CommandSeparator /> : null}
                  {provider.models.map((model) => {
                    const optionKey = modelOptionKey(provider.slug, model);
                    const selected =
                      selection?.provider === provider.slug &&
                      selection?.model === model;
                    return (
                      <CommandItem
                        key={optionKey}
                        value={optionKey}
                        onSelect={() =>
                          onSelect({
                            provider: provider.slug,
                            model,
                            providerName: provider.name,
                          })
                        }
                      >
                        <span className="truncate">{model}</span>
                        {selected ? <Check data-icon="inline-end" className="ml-auto" /> : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null,
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function modelOptionKey(provider: string, model: string) {
  return `${provider}:${model}`;
}
