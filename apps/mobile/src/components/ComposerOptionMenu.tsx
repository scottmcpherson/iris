import { useState, type ReactNode } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
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
  /** Render the value as a static, non-interactive chip (used when the selection is locked). */
  readOnly?: boolean;
  variant?: "toolbar" | "chip";
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
  readOnly,
  variant = "toolbar",
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
  const chip = variant === "chip";

  // Locked selections (e.g. agent/project once a session exists) show their value as a
  // static, legible chip instead of a dimmed disabled control.
  if (readOnly) {
    return (
      <View style={styles.readOnlyChip} accessibilityLabel={`${title}: ${value}`}>
        {showIcon ? fallbackIcon : null}
        {showValue ? <Text style={styles.readOnlyValue} numberOfLines={1}>{value}</Text> : null}
      </View>
    );
  }

  if (nativeMenuAvailable) {
    const muted = theme.colors.textMuted;
    const valueColor = chip ? theme.colors.textSecondary : muted;
    const label = (
      <HStack spacing={6} alignment="center">
        {showIcon ? <Image systemName={systemImage} size={chip ? 16 : 20} color={muted} /> : null}
        {showValue ? <UIText modifiers={[foregroundStyle(valueColor)]}>{value}</UIText> : null}
        {showChevron ? <Image systemName="chevron.down" size={chip ? 11 : 13} color={muted} /> : null}
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
    const menu = (
      <Host matchContents style={styles.host}>
        <Menu
          label={label}
          modifiers={disabled ? [tint(muted), disabledModifier(true), opacity(0.46)] : [tint(muted)]}
        >
          {menuChildren}
        </Menu>
      </Host>
    );
    return chip ? <View style={[styles.chip, disabled ? styles.chipDisabled : null]}>{menu}</View> : menu;
  }

  return (
    <>
      <ComposerOptionButton
        icon={showIcon ? fallbackIcon : null}
        label={title}
        value={value}
        variant={chip ? "chip" : "toolbar"}
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

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    host: {
      height: 38,
      justifyContent: "center",
    },
    chip: {
      height: 38,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
      backgroundColor: theme.colors.surfaceRaised,
      paddingHorizontal: theme.spacing[3],
      justifyContent: "center",
    },
    chipDisabled: {
      opacity: 0.46,
    },
    readOnlyChip: {
      height: 38,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.borderSubtle,
      backgroundColor: theme.colors.surfaceRaised,
      paddingHorizontal: theme.spacing[3],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    readOnlyValue: {
      maxWidth: 160,
      color: theme.colors.textSecondary,
      fontSize: 14,
      fontWeight: "600",
    },
  });
}
