import { useState, type ReactNode } from "react";
import { Platform, StyleSheet } from "react-native";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Button as MenuButton, HStack, Host, Image, Menu, Text as UIText } from "@expo/ui/swift-ui";
import { disabled as disabledModifier, foregroundStyle, opacity, tint } from "@expo/ui/swift-ui/modifiers";
import type { SFSymbol } from "sf-symbols-typescript";
import { useTheme } from "../theme/useTheme";
import { ComposerOptionButton } from "./ComposerOptionButton";
import { OptionSheet, type OptionSheetItem } from "./OptionSheet";

export type ComposerOptionGroup = {
  id: string;
  title: string;
  items: OptionSheetItem[];
};

type ComposerOptionMenuProps = {
  /** SF Symbol shown in the native (iOS 26) glass menu trigger. */
  systemImage: SFSymbol;
  /** lucide icon shown in the fallback trigger on older OS / Android. */
  fallbackIcon: ReactNode;
  title: string;
  value: string;
  items: OptionSheetItem[];
  /** When provided, the native menu drills into one submenu per group instead of a flat list. */
  groups?: ComposerOptionGroup[];
  disabled?: boolean;
  showIcon?: boolean;
  showValue?: boolean;
  showChevron?: boolean;
  emptyLabel?: string;
  onSelect: (id: string) => void;
};

export function ComposerOptionMenu({
  systemImage,
  fallbackIcon,
  title,
  value,
  items,
  groups,
  disabled,
  showIcon = true,
  showValue = true,
  showChevron = true,
  emptyLabel,
  onSelect,
}: ComposerOptionMenuProps) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [nativeMenuAvailable] = useState(() => Platform.OS === "ios" && isLiquidGlassAvailable());

  if (nativeMenuAvailable) {
    const muted = theme.colors.textMuted;
    const label = (
      <HStack spacing={6} alignment="center">
        {showIcon ? <Image systemName={systemImage} size={20} color={muted} /> : null}
        {showValue ? <UIText modifiers={[foregroundStyle(muted)]}>{value}</UIText> : null}
        {showChevron ? <Image systemName="chevron.down" size={13} color={muted} /> : null}
      </HStack>
    );
    // The composer sits at the bottom so these menus open upward, where iOS reverses
    // item order. Declaring bottom-to-top keeps the visible order matching the source.
    const menuChildren =
      groups && groups.length
        ? groups
            .slice()
            .reverse()
            .map((group) => (
              <Menu key={group.id} label={group.title}>
                {renderItems(group.items, onSelect)}
              </Menu>
            ))
        : renderItems(items, onSelect);
    return (
      <Host matchContents style={styles.host}>
        <Menu
          label={label}
          modifiers={disabled ? [tint(muted), disabledModifier(true), opacity(0.46)] : [tint(muted)]}
        >
          {menuChildren}
        </Menu>
      </Host>
    );
  }

  return (
    <>
      <ComposerOptionButton
        icon={showIcon ? fallbackIcon : null}
        label={title}
        value={value}
        variant="toolbar"
        showValue={showValue}
        showChevron={showChevron}
        disabled={disabled}
        onPress={() => setSheetOpen(true)}
      />
      <OptionSheet
        visible={sheetOpen}
        title={title}
        items={items}
        emptyLabel={emptyLabel}
        onSelect={(id) => {
          onSelect(id);
          setSheetOpen(false);
        }}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}

function renderItems(items: OptionSheetItem[], onSelect: (id: string) => void) {
  return items
    .slice()
    .reverse()
    .map((item) => (
      <MenuButton
        key={item.id}
        label={item.label}
        systemImage={item.selected ? "checkmark" : undefined}
        onPress={() => onSelect(item.id)}
      />
    ));
}

function createStyles(_theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    host: {
      height: 38,
      justifyContent: "center",
    },
  });
}
