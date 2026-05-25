import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type MobileSidebarContextValue = {
  open: boolean;
  selectedSessionId: string;
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
  setSelectedSessionId: (sessionId: string) => void;
};

const MobileSidebarContext = createContext<MobileSidebarContextValue | null>(null);

export function MobileSidebarStateProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState("");

  const value = useMemo<MobileSidebarContextValue>(
    () => ({
      open,
      selectedSessionId,
      openSidebar: () => setOpen(true),
      closeSidebar: () => setOpen(false),
      toggleSidebar: () => setOpen((current) => !current),
      setSelectedSessionId,
    }),
    [open, selectedSessionId],
  );

  return <MobileSidebarContext.Provider value={value}>{children}</MobileSidebarContext.Provider>;
}

export function useMobileSidebar() {
  const context = useContext(MobileSidebarContext);
  if (!context) {
    throw new Error("useMobileSidebar must be used within MobileSidebarStateProvider");
  }
  return context;
}
