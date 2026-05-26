import { Button, ContextMenu, Host, HStack, Image, Spacer, Text as UIText } from "@expo/ui/swift-ui";
import {
  background,
  buttonStyle,
  contentShape,
  cornerRadius,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  opacity,
  padding,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import { StyleSheet } from "react-native";
import { type IrisCoreSession } from "@iris/core-client";
import { mobileSessionShowsUnread } from "../chat/sessionReadState";
import { useTheme } from "../theme/useTheme";
import { mobileSidebarTimeLabel } from "./mobileSidebarModel";

type NativeSessionContextMenuProps = {
  session: IrisCoreSession;
  selected?: boolean;
  pinned: boolean;
  onPress: () => void;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
};

/**
 * iOS-only native context-menu layer. The visible row stays in React Native so
 * the ScrollView owns layout/painting, while this absolute overlay supplies the
 * real SwiftUI `.contextMenu` and native preview on long press.
 */
export function NativeSessionContextMenu({
  session,
  selected,
  pinned,
  onPress,
  onPin,
  onRename,
  onDelete,
}: NativeSessionContextMenuProps) {
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
    <Host style={StyleSheet.absoluteFill}>
      <ContextMenu>
        <ContextMenu.Trigger>
          <Button onPress={onPress} modifiers={[buttonStyle("plain")]}>
            <NativeSessionHitTarget />
          </Button>
        </ContextMenu.Trigger>
        <ContextMenu.Preview>
          <NativeSessionPreviewRow
            rowModifiers={rowModifiers}
            title={title}
            time={time}
            unread={unread}
          />
        </ContextMenu.Preview>
        <ContextMenu.Items>
          <Button label={pinned ? "Unpin" : "Pin"} systemImage={pinned ? "pin.slash" : "pin"} onPress={onPin} />
          <Button label="Rename" systemImage="pencil" onPress={onRename} />
          <Button label="Delete" systemImage="trash" role="destructive" onPress={onDelete} />
        </ContextMenu.Items>
      </ContextMenu>
    </Host>
  );
}

function NativeSessionHitTarget() {
  return (
    <HStack
      spacing={0}
      alignment="center"
      modifiers={[
        frame({ maxWidth: 1000, minHeight: 38 }),
        contentShape(shapes.rectangle()),
        opacity(0.01),
      ]}
    >
      <UIText>Session</UIText>
      <Spacer />
    </HStack>
  );
}

function NativeSessionPreviewRow({
  rowModifiers,
  title,
  time,
  unread,
}: {
  rowModifiers: ReturnType<typeof padding>[];
  title: string;
  time: string;
  unread: boolean;
}) {
  const theme = useTheme();

  return (
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
  );
}
