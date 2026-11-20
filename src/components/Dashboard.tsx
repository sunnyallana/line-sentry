import React, { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '../context/auth-context';
import { useSocketEvent } from '../hooks/useSocketEvent';
import apiService from '../services/api';
import {
  Button, EmptyState, PageHeader, PageLoader, Section, Stat, StatStrip, StatusDot, formatNumber, machineStatusLabel,
} from './ui';
import { cn } from '../lib/cn';
import { type FloorMachine, type FloorSnapshot, timeInState } from '../lib/floor';

interface DashboardDept {
  _id: string;
  name: string;
  description?: string;
  machineCount?: number;
  avgOEE?: number;
}

interface FactoryStats {
  totalUnits: number;
  avgOEE: number;
  unclassifiedStoppages: number;
  activeMachines: number;
}

type OverviewMachine = FloorMachine;

interface RaisedAlert {
  _id: string;
  title: string;
  message: string;
  level: number;
  machineId?: string | null;
  at: string;
  deliveries?: { channel: string; ok: boolean; error?: string | null }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

const STATES = ['running', 'stoppage', 'stopped_yet_producing', 'inactive'] as const;
type State = (typeof STATES)[number];

const stateBar: Record<State, string> = {
  running: 'bg-success',
  stoppage: 'bg-destructive',
  stopped_yet_producing: 'bg-warning',
  inactive: 'bg-muted-foreground/30',
};

const deptIdOf = (m: OverviewMachine) => m.departmentId;
const normalise = (status: string): State => ((STATES as readonly string[]).includes(status) ? (status as State) : 'inactive');

const countStates = (machines: OverviewMachine[]) => {
  const counts: Record<State, number> = { running: 0, stoppage: 0, stopped_yet_producing: 0, inactive: 0 };
  machines.forEach((m) => { counts[normalise(m.status)] += 1; });
  return counts;
};

/** How a group of machines is split across states, as one proportional bar. */
const StateBar = ({ counts, total }: { counts: Record<State, number>; total: number }) => {
  const summary = STATES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${machineStatusLabel(s).toLowerCase()}`).join(', ');
  return (
    <div
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={total ? summary : 'No machines'}
      title={total ? summary : 'No machines'}
    >
      {STATES.map((s) =>
        counts[s] > 0 ? <span key={s} className={cn('h-full', stateBar[s])} style={{ width: `${(counts[s] / total) * 100}%` }} /> : null,
      )}
    </div>
  );
};

const Dashboard: React.FC = () => {
  const { user, isOperator, isAdmin } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const factory = useQuery<FactoryStats>({
    queryKey: ['factory-stats'],
    queryFn: () => apiService.getFactoryStats(),
  });

  const departments = useQuery<DashboardDept[]>({
    queryKey: ['dashboard-departments'],
    queryFn: async () => {
      const data: DashboardDept[] = await apiService.getDepartments(50);
      return Promise.all(
        data.map(async (d) => ({
          ...d,
          avgOEE: (await apiService.getDepartmentStats(d._id)).avgOEE,
        })),
      );
    },
  });

  const floorQ = useQuery<FloorSnapshot>({
    queryKey: ['floor'],
    queryFn: () => apiService.getFloor(),
    refetchInterval: 30_000,
  });
  const machinesQ = { data: floorQ.data?.machines, isLoading: floorQ.isLoading };
  const alertsQ = useQuery<RaisedAlert[]>({
    queryKey: ['alerts'],
    queryFn: () => apiService.getAlerts(8),
    refetchInterval: 60_000,
  });

  // Realtime. A state change is written straight into the cached machine list,
  // so the page reacts at once; the heavier figures are refetched (TanStack
  // Query coalesces those).
  const refreshFactory = () => queryClient.invalidateQueries({ queryKey: ['factory-stats'] });
  useSocketEvent('production-update', () => {
    refreshFactory();
    queryClient.invalidateQueries({ queryKey: ['dashboard-departments'] });
    queryClient.invalidateQueries({ queryKey: ['floor'] });
  });
  useSocketEvent('stoppage-added', refreshFactory);
  useSocketEvent('unclassified-stoppage-detected', refreshFactory);
  useSocketEvent('stoppage-resolved', refreshFactory);
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

  const depts = useMemo(() => departments.data ?? [], [departments.data]);
  const machines = useMemo(() => {
    const visible = new Set(depts.map((d) => d._id));
    return (machinesQ.data ?? []).filter((m) => {
      const dept = deptIdOf(m);
      return dept ? visible.has(dept) : false;
    });
  }, [machinesQ.data, depts]);

  if (departments.isLoading || machinesQ.isLoading) {
    return <PageLoader label="Loading overview…" />;
  }

  const stats: FactoryStats = factory.data ?? { totalUnits: 0, avgOEE: 0, unclassifiedStoppages: 0, activeMachines: 0 };
  const totals = countStates(machines);
  const stopped = machines.filter((m) => normalise(m.status) === 'stoppage');
  const noPower = machines.filter((m) => normalise(m.status) === 'stopped_yet_producing');
  const waiting = machines.filter((m) => m.waitingForReason && normalise(m.status) === 'running');
  const attention = [...stopped, ...noPower, ...waiting];
  const deptName = (m: OverviewMachine) => m.departmentName || depts.find((d) => d._id === deptIdOf(m))?.name || '';
  const behind = machines.filter((m) => normalise(m.status) === 'running' && m.expectedSoFar >= 10 && m.unitsThisHour < m.expectedSoFar * 0.9);

  const recentAlerts = (alertsQ.data ?? []).filter((a) => Date.now() - new Date(a.at).getTime() < DAY_MS);

  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  return (
    <div className="space-y-6">
      <PageHeader
        title={isOperator ? user?.department?.name || 'Overview' : 'Overview'}
        description={today}
      />

      <StatStrip>
        <Stat
          label="Running now"
          value={totals.running}
          unit={`of ${machines.length}`}
          hint={machines.length ? `${totals.inactive} idle` : 'No machines yet'}
        />
        <Stat label="Units today" value={formatNumber(stats.totalUnits)} />
        {!isOperator && <Stat label="Average OEE" value={stats.avgOEE} unit="%" hint="All departments, today" />}
        <Stat
          label="Stoppages to classify"
          value={stats.unclassifiedStoppages}
          tone={stats.unclassifiedStoppages > 0 ? 'bad' : 'neutral'}
          hint={stats.unclassifiedStoppages > 0 ? 'Open the machine and pick a reason' : 'All classified'}
        />
      </StatStrip>

      <Section
        flush
        title="Needs attention"
        description={attention.length ? 'Stopped machines, unusual states, and stoppages with no reason recorded.' : undefined}
      >
        {attention.length === 0 ? (
          <p className="px-5 py-6 text-[13px] text-muted-foreground">
            {machines.length === 0 ? 'No machines are set up yet.' : 'Nothing right now. Every machine is running or idle.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {attention.map((m) => (
              <li key={m._id}>
                <Link
                  to={`/machine/${m._id}`}
                  className="group flex items-center gap-4 px-5 py-3 transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:ring-inset"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{m.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {deptName(m)}
                      {m.waitingForReason && ` · stoppage at ${String(m.waitingForReason.hour).padStart(2, '0')}:00 has no reason`}
                    </p>
                  </div>
                  {timeInState(m.statusSince) && (
                    <span className="hidden text-xs text-muted-foreground sm:inline">{timeInState(m.statusSince)}</span>
                  )}
                  <StatusDot status={m.status} />
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-spring group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {recentAlerts.length > 0 && (
        <Section flush title="Alerts in the last 24 hours" description="Sent when a machine stays stopped with no reason recorded.">
          <ul className="divide-y divide-border">
            {recentAlerts.map((a) => {
              const failed = (a.deliveries ?? []).filter((d) => !d.ok);
              const row = (
                <>
                  <span className="tabular w-12 shrink-0 text-xs text-muted-foreground">{clock.format(new Date(a.at))}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {a.title}
                      {a.level >= 2 && <span className="ml-2 text-xs font-normal text-destructive">Escalated</span>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.message}
                      {failed.length > 0 && <span className="text-warning"> Not delivered by {failed.map((d) => d.channel).join(', ')}.</span>}
                    </p>
                  </div>
                </>
              );
              return (
                <li key={a._id}>
                  {a.machineId ? (
                    <Link to={`/machine/${a.machineId}`} className="group flex items-center gap-4 px-5 py-3 transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:ring-inset">
                      {row}
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-spring group-hover:translate-x-0.5" />
                    </Link>
                  ) : (
                    <div className="flex items-center gap-4 px-5 py-3">{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {behind.length > 0 && (
        <Section flush title="Behind this hour" description="Running, but more than 10% under what the mold should have made by now.">
          <ul className="divide-y divide-border">
            {behind.map((m) => (
              <li key={m._id}>
                <Link
                  to={`/machine/${m._id}`}
                  className="group flex items-center gap-4 px-5 py-3 transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:ring-inset"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{m.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{[deptName(m), m.moldName].filter(Boolean).join(' · ')}</p>
                  </div>
                  <p className="tabular text-[13px] text-muted-foreground">
                    <span className="font-medium text-warning">{formatNumber(m.unitsThisHour)}</span> of {formatNumber(m.expectedSoFar)} expected by now
                  </p>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-spring group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        flush
        title={isOperator ? 'Your department' : 'Departments'}
        actions={
          <div className="hidden items-center gap-4 sm:flex">
            {STATES.map((s) => (
              <StatusDot key={s} status={s} className="text-xs text-muted-foreground" />
            ))}
          </div>
        }
      >
        {depts.length === 0 ? (
          <EmptyState
            title="No departments yet"
            description={
              isOperator
                ? 'You are not assigned to a department. Ask an administrator to assign you.'
                : 'Create a department, then add its machines.'
            }
            action={isAdmin ? <Button onClick={() => navigate('/departments')}>Create a department</Button> : undefined}
          />
        ) : (
          <ul className="divide-y divide-border">
            {depts.map((d) => {
              const own = machines.filter((m) => deptIdOf(m) === d._id);
              const counts = countStates(own);
              return (
                <li key={d._id}>
                  <Link
                    to={`/department/${d._id}`}
                    className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 px-5 py-3.5 transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:ring-inset sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_5rem_1rem]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{d.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {own.length === 0
                          ? 'No machines'
                          : `${counts.running} of ${own.length} running${counts.stoppage ? ` · ${counts.stoppage} stopped` : ''}`}
                      </p>
                    </div>
                    <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto">
                      <StateBar counts={counts} total={own.length} />
                    </div>
                    <div className="tabular row-start-1 text-right sm:row-start-auto">
                      <p className="text-sm font-medium text-foreground">{d.avgOEE != null ? `${d.avgOEE}%` : '–'}</p>
                      <p className="text-xs text-muted-foreground">OEE</p>
                    </div>
                    <ChevronRight className="hidden h-4 w-4 text-muted-foreground transition-transform duration-200 ease-spring group-hover:translate-x-0.5 sm:block" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
};

export default Dashboard;
