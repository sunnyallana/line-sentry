import { QueryClient } from '@tanstack/react-query';

/**
 * Shared TanStack Query client. Sensible defaults for a realtime dashboard:
 * data is considered fresh briefly (socket events drive precise invalidation),
 * and we avoid noisy refetch-on-focus.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
