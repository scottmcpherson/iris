import { useState, type ComponentType, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, { ZoomIn } from "react-native-reanimated";
import { Check, Pencil, Pin, PinOff, Trash2, type LucideProps } from "lucide-react-native";
import { type IrisCoreSession } from "@iris/core-client";
import { useTheme } from "../theme/useTheme";
import { GlassSurface } from "./GlassSurface";

export type SessionMenuAnchor = { x: number; y: number; width: number; height: number };

const MENU_WIDTH = 248;
const MENU_MARGIN = 10;
const ESTIMATED_MENU_HEIGHT = 200;

type SessionActionMenuProps = {
  visible: boolean;
  session: IrisCoreSession | null;
  pinned: boolean;
  anchor: SessionMenuAnchor | null;
  busy?: boolean;
  error?: string;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export function SessionActionMenu({
  visible,
  session,
  pinned,
  anchor,
  busy = false,
  error,
  onPin,
  onRename,
  onDelete,
  onClose,
}: SessionActionMenuProps) {
  const theme = useTheme();
  const styles = createStyles(theme);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFill}>
        {/* Transparent tap-catcher only — no full-screen blur. The glass card
            frosts just the content directly behind it, like the native composer menus. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss menu"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        {visible && session && anchor ? (
          <SessionMenuContent
            session={session}
            pinned={pinned}
            anchor={anchor}
            busy={busy}
            error={error}
            styles={styles}
            onPin={onPin}
            onRename={onRename}
            onDelete={onDelete}
          />
        ) : null}
      </View>
    </Modal>
  );
}

// Mounted only while the menu is open, so the two-step delete confirmation
// resets automatically on every open without needing an effect.
function SessionMenuContent({
  session,
  pinned,
  anchor,
  busy,
  error,
  styles,
  onPin,
  onRename,
  onDelete,
}: {
  session: IrisCoreSession;
  pinned: boolean;
  anchor: SessionMenuAnchor;
  busy: boolean;
  error?: string;
  styles: ReturnType<typeof createStyles>;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const left = Math.min(Math.max(anchor.x, MENU_MARGIN), screenWidth - MENU_WIDTH - MENU_MARGIN);
  const below = anchor.y + anchor.height + MENU_MARGIN;
  const fitsBelow = below + ESTIMATED_MENU_HEIGHT <= screenHeight - MENU_MARGIN;
  const top = fitsBelow ? below : Math.max(MENU_MARGIN, anchor.y - ESTIMATED_MENU_HEIGHT - MENU_MARGIN);

  return (
    <Animated.View entering={ZoomIn.duration(150)} style={[styles.menuContainer, { top, left, width: MENU_WIDTH }]}>
      <MenuCard styles={styles}>
        <View style={styles.menuHeader}>
          <Text style={styles.menuHeaderText} numberOfLines={1}>
            {session.title || "Untitled session"}
          </Text>
        </View>
        <MenuRow icon={pinned ? PinOff : Pin} label={pinned ? "Unpin" : "Pin"} onPress={onPin} />
        <MenuRow icon={Pencil} label="Rename" onPress={onRename} />
        <MenuRow
          icon={confirmDelete ? Check : Trash2}
          label={busy ? "Deleting…" : confirmDelete ? "Confirm delete" : "Delete"}
          destructive
          disabled={busy}
          onPress={() => {
            if (busy) return;
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            onDelete();
          }}
        />
        {error ? <Text style={styles.menuError}>{error}</Text> : null}
      </MenuCard>
    </Animated.View>
  );
}

function MenuCard({ children, styles }: { children: ReactNode; styles: ReturnType<typeof createStyles> }) {
  return (
    <GlassSurface style={styles.cardGlass} fallbackStyle={styles.cardFallbackFill}>
      {children}
    </GlassSurface>
  );
}

function MenuRow({
  icon: Icon,
  label,
  destructive = false,
  disabled = false,
  onPress,
}: {
  icon: ComponentType<LucideProps>;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = createStyles(theme);
  const color = destructive ? theme.colors.danger : theme.colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuRow,
        pressed ? styles.rowPressed : null,
        disabled ? styles.rowDisabled : null,
      ]}
    >
      <Text style={[styles.menuRowLabel, { color }]} numberOfLines={1}>
        {label}
      </Text>
      <Icon color={color} size={18} />
    </Pressable>
  );
}

type SessionRenameDialogProps = {
  session: IrisCoreSession | null;
  busy?: boolean;
  error?: string;
  onSubmit: (title: string) => void;
  onClose: () => void;
};

export function SessionRenameDialog({ session, busy = false, error, onSubmit, onClose }: SessionRenameDialogProps) {
  const theme = useTheme();
  const styles = createStyles(theme);

  return (
    <Modal visible={Boolean(session)} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.dialogRoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss rename"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, styles.dialogScrim]}
        />
        {session ? (
          // Keyed by session id so the input seeds from the session title on mount,
          // and reseeds when a different session is renamed — no effect required.
          <RenameDialogContent
            key={session.id}
            initialTitle={session.title || ""}
            busy={busy}
            error={error}
            styles={styles}
            placeholderColor={theme.colors.textMuted}
            onSubmit={onSubmit}
            onClose={onClose}
          />
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

function RenameDialogContent({
  initialTitle,
  busy,
  error,
  styles,
  placeholderColor,
  onSubmit,
  onClose,
}: {
  initialTitle: string;
  busy: boolean;
  error?: string;
  styles: ReturnType<typeof createStyles>;
  placeholderColor: string;
  onSubmit: (title: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialTitle);
  const submitDisabled = busy || !value.trim();

  return (
    <DialogCard styles={styles}>
      <View style={styles.dialogBody}>
        <Text style={styles.dialogTitle}>Rename session</Text>
        <Text style={styles.dialogMessage}>Enter a new name for this session.</Text>
        <TextInput
          autoFocus
          selectTextOnFocus
          autoCorrect={false}
          autoCapitalize="none"
          value={value}
          onChangeText={setValue}
          placeholder="Session name"
          placeholderTextColor={placeholderColor}
          style={styles.dialogInput}
          returnKeyType="done"
          editable={!busy}
          onSubmitEditing={() => {
            if (!submitDisabled) onSubmit(value);
          }}
        />
        {error ? <Text style={styles.dialogError}>{error}</Text> : null}
      </View>
      <View style={styles.dialogButtonBar}>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.alertButton, pressed ? styles.alertButtonPressed : null]}
        >
          <Text style={styles.alertButtonText}>Cancel</Text>
        </Pressable>
        <View style={styles.alertButtonSeparator} />
        <Pressable
          accessibilityRole="button"
          disabled={submitDisabled}
          onPress={() => onSubmit(value)}
          style={({ pressed }) => [styles.alertButton, pressed ? styles.alertButtonPressed : null]}
        >
          <Text
            style={[
              styles.alertButtonText,
              styles.alertButtonTextPrimary,
              submitDisabled ? styles.alertButtonTextDisabled : null,
            ]}
          >
            {busy ? "Saving…" : "Rename"}
          </Text>
        </Pressable>
      </View>
    </DialogCard>
  );
}

function DialogCard({ children, styles }: { children: ReactNode; styles: ReturnType<typeof createStyles> }) {
  return (
    <GlassSurface style={styles.dialogCard} fallbackStyle={styles.dialogCardSolid}>
      {children}
    </GlassSurface>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const cardShadow = Platform.select({
    web: { boxShadow: `0 18px 48px ${theme.colors.background}` },
    default: {
      shadowColor: theme.colors.background,
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.5,
      shadowRadius: 28,
      elevation: 24,
    },
  });

  const cardBase = {
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderStrong,
    overflow: "hidden" as const,
    paddingVertical: theme.spacing[1],
  };

  return StyleSheet.create({
    menuContainer: {
      position: "absolute",
      ...cardShadow,
    },
    cardGlass: {
      ...cardBase,
    },
    cardFallbackFill: {
      backgroundColor: theme.colors.surfaceElevated,
    },
    dialogScrim: {
      backgroundColor: theme.colors.muted,
    },
    menuHeader: {
      paddingHorizontal: theme.spacing[3],
      paddingTop: theme.spacing[2],
      paddingBottom: theme.spacing[1],
    },
    menuHeaderText: {
      color: theme.colors.textMuted,
      fontSize: 12,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.4,
    },
    menuRow: {
      minHeight: 46,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing[3],
      paddingHorizontal: theme.spacing[3],
    },
    menuRowLabel: {
      flex: 1,
      minWidth: 0,
      fontSize: 16,
      fontWeight: "600",
    },
    rowPressed: {
      opacity: 0.6,
    },
    rowDisabled: {
      opacity: 0.45,
    },
    menuError: {
      color: theme.colors.danger,
      fontSize: 12,
      lineHeight: 16,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
    },
    dialogRoot: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: theme.spacing[5],
    },
    dialogCard: {
      width: 270,
      maxWidth: "100%",
      borderRadius: 14,
      overflow: "hidden",
      ...cardShadow,
    },
    dialogCardSolid: {
      backgroundColor: theme.colors.surfaceElevated,
    },
    dialogBody: {
      alignItems: "center",
      paddingHorizontal: theme.spacing[4],
      paddingTop: theme.spacing[4],
      paddingBottom: theme.spacing[3],
      gap: theme.spacing[1],
    },
    dialogTitle: {
      color: theme.colors.text,
      fontSize: 17,
      fontWeight: "700",
      textAlign: "center",
    },
    dialogMessage: {
      color: theme.colors.textMuted,
      fontSize: 13,
      lineHeight: 17,
      textAlign: "center",
    },
    dialogInput: {
      alignSelf: "stretch",
      marginTop: theme.spacing[2],
      height: 36,
      borderRadius: theme.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderStrong,
      backgroundColor: theme.colors.input,
      paddingHorizontal: theme.spacing[2],
      color: theme.colors.text,
      fontSize: 15,
    },
    dialogError: {
      color: theme.colors.danger,
      fontSize: 12,
      lineHeight: 16,
      textAlign: "center",
      marginTop: theme.spacing[1],
    },
    dialogButtonBar: {
      flexDirection: "row",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.borderStrong,
    },
    alertButton: {
      flex: 1,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    alertButtonPressed: {
      backgroundColor: theme.colors.muted,
    },
    alertButtonSeparator: {
      width: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.borderStrong,
    },
    alertButtonText: {
      color: theme.colors.accentCoolBright,
      fontSize: 17,
      fontWeight: "400",
    },
    alertButtonTextPrimary: {
      fontWeight: "600",
    },
    alertButtonTextDisabled: {
      color: theme.colors.textMuted,
    },
  });
}
