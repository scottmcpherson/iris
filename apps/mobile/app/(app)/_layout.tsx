import { Stack } from "expo-router";
import { MobileSidebarDrawer } from "../../src/components/MobileSidebar";
import {
  MobileSidebarStateProvider,
  useMobileSidebarActions,
  useMobileSidebarState,
} from "../../src/components/MobileSidebarContext";
import { useTheme } from "../../src/theme/useTheme";

function AppDrawer() {
  const theme = useTheme();
  const { open, selectedSessionId } = useMobileSidebarState();
  const { openSidebar, closeSidebar } = useMobileSidebarActions();

  return (
    <MobileSidebarDrawer
      open={open}
      onOpen={openSidebar}
      onClose={closeSidebar}
      selectedSessionId={selectedSessionId}
    >
      <Stack
        screenOptions={{
          headerShown: false,
          animation: "none",
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      />
    </MobileSidebarDrawer>
  );
}

export default function AppLayout() {
  return (
    <MobileSidebarStateProvider>
      <AppDrawer />
    </MobileSidebarStateProvider>
  );
}
