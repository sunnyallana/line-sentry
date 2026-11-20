import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Maximize, Minimize, X } from 'lucide-react';
import apiService from '../services/api';
import socketService from '../services/socket';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { IconButton, PageLoader, formatNumber, machineStatusLabel } from './ui';
import { cn } from '../lib/cn';
import { type FloorMachine, type FloorSnapshot, timeInState } from '../lib/floor';

/* The wall screen. Read from across the hall: one tile per machine, the tile's
   colour is the machine's state and nothing else, and there is nothing to tap.
   With several departments it shows one at a time and moves on by itself. */

const ROTATE_EVERY_MS = 20_000;

const tileTone: Record<string, string> = {
  running: 'border-success/40 bg-success/[0.12]',
  stoppage: 'border-destructive/50 bg-destructive/[0.16]',
  stopped_yet_producing: 'border-warning/50 bg-warning/[0.14]',
  inactive: 'border-border bg-card',
};
const stateTone: Record<string, string> = {
  running: 'text-success',
  stoppage: 'text-destructive',
  stopped_yet_producing: 'text-warning',
  inactive: 'text-muted-foreground',
};

const Board: React.FC = () => {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [page, setPage] = useState(0);
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);

  const floorQ = useQuery<FloorSnapshot>({
    queryKey: ['floor'],
    queryFn: () => apiService.getFloor(),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    socketService.connect();
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, []);

  // A state change shows at once; the figures follow on the next refetch.
  useSocketEvent('machine-state-update', (e) => {
    queryClient.setQueryData<FloorSnapshot>(['floor'], (old) =>
      old && {
        ...old,
        machines: old.machines.map((m) =>
          m._id === e.machineId && m.status !== e.status ? { ...m, status: e.status, statusSince: new Date().toISOString() } : m,
        ),
      },
    );
  });
  useSocketEvent('production-update', () => queryClient.invalidateQueries({ queryKey: ['floor'] }));

  const departments = useMemo(() => {
    const groups = new Map<string, { name: string; machines: FloorMachine[] }>();
    (floorQ.data?.machines ?? []).forEach((m) => {
      const g = groups.get(m.departmentId) ?? { name: m.departmentName ?? 'Department', machines: [] };
      g.machines.push(m);
      groups.set(m.departmentId, g);
    });
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [floorQ.data]);

  useEffect(() => {
    if (departments.length < 2) return;
    const id = window.setInterval(() => setPage((p) => (p + 1) % departments.length), ROTATE_EVERY_MS);
    return () => window.clearInterval(id);
  }, [departments.length]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => { /* the browser refused; the board still works windowed */ });
  };

  if (floorQ.isLoading) return <div className="flex min-h-screen items-center justify-center bg-background"><PageLoader label="Loading the board…" /></div>;

  const current = departments[page % Math.max(1, departments.length)];
  const all = floorQ.data?.machines ?? [];
  const running = all.filter((m) => m.status === 'running').length;
  const stopped = all.filter((m) => m.status === 'stoppage').length;
  const columns = !current ? 1 : current.machines.length <= 4 ? 2 : current.machines.length <= 9 ? 3 : 4;

  return (
    <div className="flex min-h-screen flex-col bg-background p-6 text-foreground">
      <header className="mb-5 flex items-center justify-between gap-6">
        <div className="min-w-0">
          <h1 className="truncate text-4xl font-semibold leading-tight">{current?.name ?? 'No machines yet'}</h1>
          <p className="mt-1 text-lg text-muted-foreground">
            {running} of {all.length} running{stopped > 0 && <span className="text-destructive"> · {stopped} stopped</span>}
            {departments.length > 1 && ` · showing ${page % departments.length + 1} of ${departments.length} departments`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <time className="tabular text-4xl font-semibold" dateTime={new Date(now).toISOString()}>
            {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(now)}
          </time>
          <div className="flex items-center gap-1 opacity-40 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100">
            <IconButton label={fullscreen ? 'Leave full screen' : 'Full screen'} onClick={toggleFullscreen}>
              {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </IconButton>
            <Link
              to="/dashboard"
              aria-label="Close the board"
              title="Close the board"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </header>

      <main
        className="grid flex-1 auto-rows-fr gap-4"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        aria-live="polite"
      >
        {(current?.machines ?? []).map((m) => {
          const producing = m.status === 'running' || m.status === 'stoppage';
          const paced = producing && m.expectedPerHour > 0;
          const behind = paced && m.unitsThisHour < m.expectedSoFar * 0.9;
          const since = timeInState(m.statusSince, now);
          return (
            <article key={m._id} className={cn('flex min-h-[180px] flex-col rounded-xl border-2 p-5', tileTone[m.status] ?? tileTone.inactive)}>
              <div className="flex items-start justify-between gap-3">
                <h2 className="truncate text-3xl font-semibold leading-tight">{m.name}</h2>
                {m.waitingForReason && (
                  <span className="shrink-0 rounded-md bg-destructive px-2 py-1 text-sm font-medium text-destructive-foreground">Needs a reason</span>
                )}
              </div>
              <p className={cn('mt-1 text-xl font-medium', stateTone[m.status] ?? stateTone.inactive)}>
                {machineStatusLabel(m.status)}
                {since && <span className="font-normal text-muted-foreground"> · {since}</span>}
              </p>

              <div className="mt-auto flex items-end justify-between gap-4 pt-4">
                <div>
                  <p className="tabular text-5xl font-semibold leading-none">{formatNumber(m.unitsThisHour)}</p>
                  <p className="mt-1.5 text-base text-muted-foreground">
                    {paced ? (
                      <>this hour · <span className={cn(behind && 'text-warning')}>{formatNumber(m.expectedSoFar)} expected by now</span></>
                    ) : 'units this hour'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="tabular text-2xl font-semibold leading-none">{formatNumber(m.unitsToday)}</p>
                  <p className="mt-1.5 text-base text-muted-foreground">today</p>
                </div>
              </div>
            </article>
          );
        })}
      </main>

      {departments.length > 1 && (
        <footer className="mt-5 flex justify-center gap-2" aria-hidden>
          {departments.map((d, i) => (
            <span key={d.name} className={cn('h-1.5 rounded-full transition-all duration-300', i === page % departments.length ? 'w-8 bg-foreground' : 'w-1.5 bg-foreground/25')} />
          ))}
        </footer>
      )}
    </div>
  );
};

export default Board;
