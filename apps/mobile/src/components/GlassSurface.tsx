import { type ReactNode } from "react";
import { View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";

type GlassSurfaceProps = Omit<ViewProps, "style"> & {
  children?: ReactNode;
  /** Geometry shared by both paths: radius, padding, sizing, overflow. */
  style?: StyleProp<ViewStyle>;
  /** Fill applied only when Liquid Glass is unavailable: background + border. */
  fallbackStyle?: StyleProp<ViewStyle>;
  glassEffectStyle?: "clear" | "regular";
  colorScheme?: "auto" | "light" | "dark";
  tintColor?: string;
  isInteractive?: boolean;
};

/**
 * Renders content on an iOS 26 Liquid Glass material, falling back to a solid
 * surface on Android / older iOS. `style` is the shared geometry; `fallbackStyle`
 * carries the background/border the glass material would otherwise provide.
 *
 * Do not nest a GlassSurface inside another glass surface — glass elements are
 * meant to be siblings, not stacked, or they double-frost.
 */
export function GlassSurface({
  children,
  style,
  fallbackStyle,
  glassEffectStyle = "regular",
  colorScheme = "dark",
  tintColor,
  isInteractive = false,
  ...viewProps
}: GlassSurfaceProps) {
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView
        glassEffectStyle={glassEffectStyle}
        colorScheme={colorScheme}
        tintColor={tintColor}
        isInteractive={isInteractive}
        style={style}
        {...viewProps}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[style, fallbackStyle]} {...viewProps}>
      {children}
    </View>
  );
}
