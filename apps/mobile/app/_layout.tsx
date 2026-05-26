import { useMemo } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { configureReanimatedLogger, ReanimatedLogLevel } from "react-native-reanimated";
import { IrisConnectionProvider } from "../src/connection/useIrisConnection";
import { createMobileQueryClient } from "../src/lib/queryClient";
import { useTheme } from "../src/theme/useTheme";

// Keep real Reanimated warnings/errors, but silence the noisy strict-mode
// advisory about reading a shared value's `.value` during render. Our shared
// values are only read inside worklets (animated styles, gesture callbacks);
// the warning is a known false-positive in Reanimated 4's strict mode.
configureReanimatedLogger({
  level: ReanimatedLogLevel.warn,
  strict: false,
});

export default function RootLayout() {
  const theme = useTheme();
  const queryClient = useMemo(() => createMobileQueryClient(), []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <IrisConnectionProvider>
            <StatusBar style="light" />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: theme.colors.background },
              }}
            />
          </IrisConnectionProvider>
        </SafeAreaProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
