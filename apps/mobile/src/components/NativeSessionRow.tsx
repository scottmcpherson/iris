import { Button, ContextMenu, Host, HStack, Image, Spacer, Text as UIText } from "@expo/ui/swift-ui";
import {
  background,
  buttonStyle,
  cornerRadius,
  font,
  foregroundStyle,
  layoutPriority,
  lineLimit,
  padding,
} from "@expo/ui/swift-ui/modifiers";
import { type IrisCoreSession } from "@iris/core-client";
import { mobileSessionShowsUnread } from "../chat/sessionReadState";
import { useTheme } from "../theme/useTheme";
import { mobileSidebarTimeLabel } from "./mobileSidebarModel";

type NativeSessionRowProps = {
  session: IrisCoreSession;
  selected?: boolean;
  nested?: boolean;
  pinned: boolean;
  onPress: () => void;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
};

/**
 * iOS-only session row rendered with native SwiftUI so it can host a real
 * `.contextMenu`. Long-pressing lifts the row and shows the native liquid-glass
 * menu (matching the composer menus); a plain tap still navigates.
 */
export function NativeSessionRow({
  session,
  selected,
  nested,
  pinned,
  onPress,
  onPin,
  onRename,
  onDelete,
}: NativeSessionRowProps) {
  const theme = useTheme();
  const unread = mobileSessionShowsUnread(session, Boolean(selected));
  const title = session.title || "Untitled session";
  const time = mobileSidebarTimeLabel(session.updatedAt || session.createdAt);

  const rowModifiers = [
    padding({ horizontal: theme.spacing[2], vertical: 7 }),
    ...(selected ? [background(theme.colors.surfaceElevated)] : []),
    cornerRadius(theme.radius.md),
  ];

  return (
    <Host style={{ alignSelf: "stretch", height: 36, marginLeft: nested ? theme.spacing[5] : 0 }}>
      <ContextMenu>
        <ContextMenu.Trigger>
          <Button onPress={onPress} modifiers={[buttonStyle("plain")]}>
            <HStack spacing={theme.spacing[2]} alignment="center" modifiers={rowModifiers}>
              <UIText modifiers={[font({ size: 15 }), foregroundStyle(theme.colors.text), lineLimit(1)]}>
                {title}
              </UIText>
              <Spacer minLength={theme.spacing[2]} />
              {unread ? <Image systemName="circle.fill" size={7} color={theme.colors.accentCoolBright} /> : null}
              <UIText
                modifiers={[font({ size: 12 }), foregroundStyle(theme.colors.textMuted), layoutPriority(1)]}
              >
                {time}
              </UIText>
            </HStack>
          </Button>
        </ContextMenu.Trigger>
        <ContextMenu.Items>
          <Button label={pinned ? "Unpin" : "Pin"} systemImage={pinned ? "pin.slash" : "pin"} onPress={onPin} />
          <Button label="Rename" systemImage="pencil" onPress={onRename} />
          <Button label="Delete" systemImage="trash" role="destructive" onPress={onDelete} />
        </ContextMenu.Items>
      </ContextMenu>
    </Host>
  );
}
