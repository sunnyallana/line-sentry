import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, type LucideIcon } from 'lucide-react';
import apiService from '../services/api';
import { StatusDot } from './ui';
import { cn } from '../lib/cn';
import type { FloorSnapshot } from '../lib/floor';

/* Jump to anything by typing a few letters: a page, a department, a machine.
   Opened with Ctrl+K (Cmd+K on a Mac) or the search button in the top bar.
   Everything is reachable from the keyboard: arrows move, Enter opens, Escape
   closes. */

export interface PaletteDestination {
  name: string;
  href: string;
  icon: LucideIcon;
  group: string;
}

interface Item {
  key: string;
  label: string;
  detail?: string;
  href: string;
  group: string;
  icon?: LucideIcon;
  status?: string;
}

/** Every word typed must appear somewhere in the item, in any order. */
function matches(item: Item, query: string): boolean {
  const haystack = `${item.label} ${item.detail ?? ''} ${item.group}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

const MAX_PER_GROUP = 8;

export const CommandPalette = ({
  open,
  onClose,
  destinations,
}: {
  open: boolean;
  onClose: () => void;
  destinations: PaletteDestination[];
}) => {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Shares the Overview's cache, so opening the palette rarely costs a request.
  const floorQ = useQuery<FloorSnapshot>({
    queryKey: ['floor'],
    queryFn: () => apiService.getFloor(),
    enabled: open,
    staleTime: 30_000,
  });

  const items = useMemo<Item[]>(() => {
    const pages: Item[] = destinations.map((d) => ({
      key: `page:${d.href}`,
      label: d.name,
      href: d.href,
      group: 'Pages',
      icon: d.icon,
    }));
    const machines = floorQ.data?.machines ?? [];
    const departments = new Map<string, string>();
    machines.forEach((m) => departments.set(m.departmentId, m.departmentName ?? 'Department'));
    return [
      ...pages,
      ...[...departments].map(([id, name]) => ({
        key: `department:${id}`,
        label: name,
        href: `/department/${id}`,
        group: 'Departments',
      })),
      ...machines.map((m) => ({
        key: `machine:${m._id}`,
        label: m.name,
        detail: m.departmentName ?? undefined,
        href: `/machine/${m._id}`,
        group: 'Machines',
        status: m.status,
      })),
    ];
  }, [destinations, floorQ.data]);

  const groups = useMemo(() => {
    const found = query.trim() ? items.filter((i) => matches(i, query)) : items;
    const byGroup = new Map<string, Item[]>();
    found.forEach((i) => {
      const list = byGroup.get(i.group) ?? [];
      if (list.length < MAX_PER_GROUP) list.push(i);
      byGroup.set(i.group, list);
    });
    return [...byGroup];
  }, [items, query]);
  const flat = useMemo(() => groups.flatMap(([, list]) => list), [groups]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const go = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    navigate(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(flat[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let index = -1;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 animate-fade-in bg-black/45" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to"
        className="relative z-10 flex max-h-[70vh] w-full max-w-xl animate-scale-in flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sheet"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Go to a page, department or machine"
            aria-label="Search"
            role="combobox"
            aria-expanded
            aria-controls="palette-results"
            aria-activedescendant={flat[active] ? `palette-${flat[active].key}` : undefined}
            className="h-12 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-0"
          />
          <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground sm:block">Esc</kbd>
        </div>

        <div ref={listRef} id="palette-results" role="listbox" className="scrollbar-thin overflow-y-auto p-2">
          {flat.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              {floorQ.isLoading ? 'Loading…' : `Nothing matches "${query}".`}
            </p>
          ) : (
            groups.map(([group, list]) => (
              <div key={group} className="mb-1 last:mb-0">
                <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">{group}</p>
                {list.map((item) => {
                  index += 1;
                  const mine = index;
                  const selected = mine === active;
                  return (
                    <button
                      key={item.key}
                      id={`palette-${item.key}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-active={selected}
                      onMouseMove={() => setActive(mine)}
                      onClick={() => go(item)}
                      className={cn(
                        'flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm',
                        selected ? 'bg-foreground/[0.07] text-foreground' : 'text-foreground',
                      )}
                    >
                      {item.icon && <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />}
                      {item.status && <StatusDot status={item.status} label={false} />}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.detail && <span className="shrink-0 truncate text-xs text-muted-foreground">{item.detail}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="hidden items-center gap-4 border-t border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground sm:flex">
          <span><kbd className="font-sans">↑</kbd> <kbd className="font-sans">↓</kbd> to move</span>
          <span><kbd className="font-sans">Enter</kbd> to open</span>
        </div>
      </div>
    </div>,
    document.body,
  );
};

/** Opens on Ctrl+K / Cmd+K from anywhere. Returns the open state and setters. */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return { open, show: () => setOpen(true), hide: () => setOpen(false) };
}
