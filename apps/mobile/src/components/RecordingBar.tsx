import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { Check, X } from "lucide-react-native";
import type { AudioRecorder } from "expo-audio";
import { useTheme } from "../theme/useTheme";
import { normalizeMetering } from "../chat/voiceMetering";

// Scrolling amplitude history. A fresh sample is appended at the right on every
// tick and the strip clips on the left, so speech scrolls leftward (voice-memo
// style). Quiet samples collapse to a dot, drawing the dotted baseline.
const BAR_COUNT = 44;
const SAMPLE_INTERVAL_MS = 70;
const BAR_BASE_HEIGHT = 18;
const BAR_MIN_SCALE = 0.12;
const EMPTY_LEVELS = Array.from({ length: BAR_COUNT }, () => 0);

export function RecordingBar({
  recorder,
  recording,
  error,
  cancelDisabled,
  confirmDisabled,
  onCancel,
  onConfirm,
}: {
  recorder: AudioRecorder;
  recording: boolean;
  error?: string;
  cancelDisabled: boolean;
  confirmDisabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [levels, setLevels] = useState<number[]>(EMPTY_LEVELS);
  const [width, setWidth] = useState(0);
  const bufferRef = useRef<number[]>(EMPTY_LEVELS.slice());
  const flowStartedRef = useRef(false);
  const flow = useSharedValue(0);
  const glow = useSharedValue(0.12);
  const isError = Boolean(error);

  useEffect(() => {
    // Mutating shared values is only allowed inside callbacks (not synchronously
    // in the effect body), so the looping flow is kicked off on the first tick.
    function pushSample() {
      if (!flowStartedRef.current) {
        flowStartedRef.current = true;
        flow.value = withRepeat(withTiming(1, { duration: 4500, easing: Easing.linear }), -1, false);
      }
      let sample = 0;
      try {
        const status = recorder.getStatus();
        if (status.isRecording) sample = normalizeMetering(status.metering);
      } catch {
        sample = 0;
      }
      const next = bufferRef.current.slice(1);
      next.push(sample);
      bufferRef.current = next;
      setLevels(next);
      // Brighten the sheen with the voice level.
      glow.value = withTiming(0.12 + sample * 0.55, { duration: 120 });
    }
    const id = setInterval(pushSample, SAMPLE_INTERVAL_MS);
    return () => {
      clearInterval(id);
      cancelAnimation(flow);
    };
  }, [recorder, flow, glow]);

  const gradientStyle = useAnimatedStyle(() => ({
    opacity: glow.value,
    transform: [{ translateX: -flow.value * width }],
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    if (Math.abs(next - width) > 1) setWidth(next);
  };

  return (
    <View style={styles.pill} onLayout={onLayout}>
      {isError ? null : (
        <Animated.View
          style={[styles.gradientLayer, { width: Math.max(width * 2, 1) }, gradientStyle]}
          pointerEvents="none"
        >
          <LinearGradient
            colors={[
              theme.colors.accentCoolBright,
              theme.colors.accentSuccess,
              theme.colors.accentCoolBright,
              theme.colors.accentSuccess,
              theme.colors.accentCoolBright,
            ]}
            locations={[0, 0.25, 0.5, 0.75, 1]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isError ? "Dismiss voice error" : "Cancel voice input"}
        disabled={cancelDisabled}
        onPress={onCancel}
        style={({ pressed }) => [styles.cancelButton, pressed ? styles.pressed : null]}
      >
        <X color={theme.colors.textSecondary} size={18} />
      </Pressable>
      {isError ? (
        <Text style={styles.errorText} numberOfLines={1}>
          {error}
        </Text>
      ) : (
        <View
          style={styles.bars}
          pointerEvents="none"
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={recording ? "Recording" : "Preparing voice input"}
        >
          {levels.map((level, index) => (
            <View
              key={index}
              style={[styles.bar, { transform: [{ scaleY: Math.max(BAR_MIN_SCALE, level) }] }]}
            />
          ))}
        </View>
      )}
      {isError ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send voice input"
          disabled={confirmDisabled}
          onPress={onConfirm}
          style={({ pressed }) => [
            styles.confirmButton,
            confirmDisabled ? styles.confirmButtonDisabled : null,
            pressed && !confirmDisabled ? styles.pressed : null,
          ]}
        >
          <Check color={theme.colors.buttonPrimaryText} size={18} />
        </Pressable>
      )}
    </View>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    pill: {
      flex: 1,
      minHeight: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.input,
      paddingHorizontal: theme.spacing[1],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      overflow: "hidden",
    },
    gradientLayer: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
    },
    bars: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 2,
      height: BAR_BASE_HEIGHT,
    },
    bar: {
      width: 2.5,
      height: BAR_BASE_HEIGHT,
      borderRadius: 999,
      backgroundColor: theme.colors.textSecondary,
    },
    errorText: {
      flex: 1,
      color: theme.colors.textMuted,
      fontSize: 13,
      fontWeight: "700",
    },
    cancelButton: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.accent,
    },
    confirmButton: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.colors.buttonPrimary,
    },
    confirmButtonDisabled: {
      opacity: 0.46,
    },
    pressed: {
      opacity: 0.76,
    },
  });
}
