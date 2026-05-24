import { QueryClient } from "@tanstack/react-query";

export function createMobileQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: 1,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
