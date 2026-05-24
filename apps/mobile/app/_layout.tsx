import { useMemo } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { QueryClientProvider } from "@tanstack/react-query";
import { IrisConnectionProvider } from "../src/connection/useIrisConnection";
import { createMobileQueryClient } from "../src/lib/queryClient";
import { useTheme } from "../src/theme/useTheme";

export default function RootLayout() {
  const theme = useTheme();
  const queryClient = useMemo(() => createMobileQueryClient(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <IrisConnectionProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.colors.background },
          }}
        />
      </IrisConnectionProvider>
    </QueryClientProvider>
  );
}
