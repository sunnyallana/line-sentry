import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useDebounce } from './useDebounce';

export interface Pagination {
  currentPage: number;
  totalPages: number;
  limit: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

interface Options {
  queryKey: string;
  /** Key of the array in the paginated response, e.g. "departments". */
  listKey: string;
  fetcher: (params: Record<string, string>) => Promise<Record<string, unknown>>;
  limit?: number;
  initialSort?: { by: string; order: 'asc' | 'desc' };
  initialFilters?: Record<string, string>;
}

/**
 * Shared paginated/searchable/sortable data-table state backed by TanStack
 * Query. Eliminates the duplicated fetch+pagination+filter logic that each
 * admin CRUD page used to hand-roll. `keepPreviousData` avoids flicker between
 * pages.
 */
export function useDataTable<T>(opts: Options) {
  const {
    queryKey,
    listKey,
    fetcher,
    limit = 10,
    initialSort = { by: 'createdAt', order: 'desc' as const },
    initialFilters = {},
  } = opts;

  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounce(searchInput, 300);
  const [filters, setFilters] = useState<Record<string, string>>(initialFilters);
  const [sort, setSort] = useState(initialSort);

  const setSearch = (s: string) => {
    setSearchInput(s);
    setPage(1);
  };
  const setFilter = (key: string, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };
  const toggleSort = (by: string) =>
    setSort((s) => (s.by === by ? { by, order: s.order === 'asc' ? 'desc' : 'asc' } : { by, order: 'asc' }));

  const params = useMemo(
    () => ({
      page: String(page),
      limit: String(limit),
      search,
      sortBy: sort.by,
      sortOrder: sort.order,
      ...filters,
    }),
    [page, limit, search, sort, filters],
  );

  const query = useQuery({
    queryKey: [queryKey, params],
    queryFn: () => fetcher(params),
    placeholderData: keepPreviousData,
  });

  return {
    items: (query.data?.[listKey] as T[] | undefined) ?? [],
    pagination: query.data?.pagination as Pagination | undefined,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    page,
    setPage,
    searchInput,
    setSearch,
    filters,
    setFilter,
    sort,
    toggleSort,
    refetch: query.refetch,
  };
}
