import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type MobileSidebarStateContextValue = {
  open: boolean;
  selectedSessionId: string;
  transitioningSessionId: string;
};

type MobileSidebarActionsContextValue = {
  openSidebar: () => void;
  closeSidebar: () => void;
  toggleSidebar: () => void;
  setSelectedSessionId: (sessionId: string) => void;
  startSessionTransition: (sessionId: string) => void;
  finishSessionTransition: (sessionId: string) => void;
};

type MobileSidebarContextValue = MobileSidebarStateContextValue & MobileSidebarActionsContextValue;

const MobileSidebarStateContext = createContext<MobileSidebarStateContextValue | null>(null);
const MobileSidebarActionsContext = createContext<MobileSidebarActionsContextValue | null>(null);

export function MobileSidebarStateProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [transitioningSessionId, setTransitioningSessionId] = useState("");

  const state = useMemo<MobileSidebarStateContextValue>(
    () => ({
      open,
      selectedSessionId,
      transitioningSessionId,
    }),
    [open, selectedSessionId, transitioningSessionId],
  );

  const actions = useMemo<MobileSidebarActionsContextValue>(
    () => ({
      openSidebar: () => setOpen(true),
      closeSidebar: () => setOpen(false),
      toggleSidebar: () => setOpen((current) => !current),
      setSelectedSessionId,
      startSessionTransition: (sessionId) => setTransitioningSessionId(sessionId),
      finishSessionTransition: (sessionId) => {
        setTransitioningSessionId((current) => (current === sessionId ? "" : current));
      },
    }),
    [],
  );

  return (
    <MobileSidebarActionsContext.Provider value={actions}>
      <MobileSidebarStateContext.Provider value={state}>{children}</MobileSidebarStateContext.Provider>
    </MobileSidebarActionsContext.Provider>
  );
}

export function useMobileSidebarState() {
  const context = useContext(MobileSidebarStateContext);
  if (!context) {
    throw new Error("useMobileSidebarState must be used within MobileSidebarStateProvider");
  }
  return context;
}

export function useMobileSidebarActions() {
  const context = useContext(MobileSidebarActionsContext);
  if (!context) {
    throw new Error("useMobileSidebarActions must be used within MobileSidebarStateProvider");
  }
  return context;
}

export function useMobileSidebar() {
  return {
    ...useMobileSidebarState(),
    ...useMobileSidebarActions(),
  };
}
