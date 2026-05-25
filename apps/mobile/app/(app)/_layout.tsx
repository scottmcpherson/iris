import { Stack } from "expo-router";
import { MobileSidebarDrawer } from "../../src/components/MobileSidebar";
import { MobileSidebarStateProvider, useMobileSidebar } from "../../src/components/MobileSidebarContext";
import { useTheme } from "../../src/theme/useTheme";

function AppDrawer() {
  const theme = useTheme();
  const { open, selectedSessionId, openSidebar, closeSidebar } = useMobileSidebar();

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
