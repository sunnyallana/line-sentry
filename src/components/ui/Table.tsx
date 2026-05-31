import React from 'react';
import { ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react';
import { Button } from './Button';
import { cn } from '../../lib/cn';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  sortable?: boolean;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  onSort,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  onSort?: (key: string) => void;
  empty?: React.ReactNode;
}) {
  return (
    <div className="scrollbar-thin overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cn('px-4 py-3 font-medium', c.className)}>
                {c.sortable && onSort ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => onSort(c.key)}
                  >
                    {c.header}
                    <ArrowUpDown className="h-3 w-3" />
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-muted-foreground">
                {empty ?? 'No results'}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn('transition-colors hover:bg-accent/50', onRowClick && 'cursor-pointer')}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-4 py-3 text-foreground', c.className)}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  if (!totalPages || totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between pt-4">
      <p className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" /> Prev
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
