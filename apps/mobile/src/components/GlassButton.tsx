import { type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  type AccessibilityState,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { GlassSurface } from "./GlassSurface";

const PRESS_SCALE = 1.12;
const PRESS_IN_SPRING = { damping: 12, stiffness: 340 };
const PRESS_OUT_SPRING = { damping: 15, stiffness: 320 };

type GlassButtonProps = {
  onPress?: () => void;
  accessibilityLabel: string;
  accessibilityState?: AccessibilityState;
  disabled?: boolean;
  tintColor?: string;
  /** Glass capsule/circle geometry shared with the fallback. */
  style?: StyleProp<ViewStyle>;
  /** Background + border applied only when Liquid Glass is unavailable. */
  fallbackStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/**
 * A Liquid Glass button that springs slightly larger on press, mirroring the
 * native iOS glass button swell. The scale lives on a wrapper so it animates
 * the whole glass capsule rather than just its contents.
 */
export function GlassButton({
  onPress,
  accessibilityLabel,
  accessibilityState,
  disabled = false,
  tintColor,
  style,
  fallbackStyle,
  children,
}: GlassButtonProps) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={animatedStyle}>
      <GlassSurface isInteractive tintColor={tintColor} style={style} fallbackStyle={fallbackStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={accessibilityState}
          disabled={disabled}
          onPress={onPress}
          onPressIn={() => {
            scale.value = withSpring(PRESS_SCALE, PRESS_IN_SPRING);
          }}
          onPressOut={() => {
            scale.value = withSpring(1, PRESS_OUT_SPRING);
          }}
          style={styles.fill}
        >
          {children}
        </Pressable>
      </GlassSurface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
