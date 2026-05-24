import { useCallback, useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import type { HistoryLocation, RouterHistory } from "@tanstack/history";

type HistoryNavState = {
  currentIndex: number;
  maxIndex: number;
};

/**
 * Tracks the router's position in its history stack and exposes
 * browser-style back/forward actions. TanStack records each entry's index on
 * `location.state.__TSR_index`; mirroring it here lets us know when forward
 * navigation is available (the router's own `canGoBack` only covers back).
 *
 * Degrades to inert defaults when rendered outside a RouterProvider so that
 * AppShell unit tests can exercise layout without standing up a router.
 */
export function useHistoryNav() {
  const history = useOptionalRouterHistory();

  const [state, setState] = useState<HistoryNavState>(() => {
    const index = history ? indexOf(history.location) : 0;
    return { currentIndex: index, maxIndex: index };
  });

  useEffect(() => {
    if (!history) return;
    return history.subscribe(({ location, action }) => {
      const nextIndex = indexOf(location);
      setState((prev) => {
        switch (action.type) {
          case "PUSH":
            // New entries truncate any forward stack.
            return { currentIndex: nextIndex, maxIndex: nextIndex };
          case "REPLACE":
            return { currentIndex: nextIndex, maxIndex: prev.maxIndex };
          default:
            // BACK / FORWARD / GO move the cursor but don't change the ceiling.
            return {
              currentIndex: nextIndex,
              maxIndex: Math.max(prev.maxIndex, nextIndex),
            };
        }
      });
    });
  }, [history]);

  const goBack = useCallback(() => {
    history?.back();
  }, [history]);
  const goForward = useCallback(() => {
    history?.forward();
  }, [history]);

  return {
    canGoBack: Boolean(history) && state.currentIndex > 0,
    canGoForward: Boolean(history) && state.currentIndex < state.maxIndex,
    goBack,
    goForward,
  };
}

function useOptionalRouterHistory(): RouterHistory | null {
  const router = useRouter({ warn: false }) as { history?: RouterHistory } | null | undefined;
  return router?.history ?? null;
}

function indexOf(location: HistoryLocation) {
  return typeof location.state.__TSR_index === "number" ? location.state.__TSR_index : 0;
}
