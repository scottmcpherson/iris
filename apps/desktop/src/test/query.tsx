import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: Infinity,
      },
    },
  });
}

export function renderWithQueryClient(node: ReactNode, client = createTestQueryClient()) {
  return {
    client,
    node: <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  };
}
