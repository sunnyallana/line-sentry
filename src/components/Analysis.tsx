import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, startOfMonth, startOfWeek, subDays } from 'date-fns';
import { Download } from 'lucide-react';
import apiService from '../services/api';
import { useAuth } from '../context/auth-context';
import {
  Button, EmptyState, Input, PageHeader, PageLoader, Section, Segmented, Select, Stat, StatStrip, Tabs, formatNumber,
} from './ui';
import { cn } from '../lib/cn';
import { useStoppageReasons } from '../lib/reasons';

interface Slice {
  key?: string;
  name?: string;
  date?: string;
  units: number;
  defective: number;
  runningMinutes: number;
  stoppedMinutes: number;
  expectedUnits: number;
  stoppages: number;
  breakdowns: number;
  availability: number;
  quality: number;
  performance: number | null;
  oee: number | null;
  mtbfMinutes: number;
  mttrMinutes: number;
  failureRate: number;
}

interface ReasonRow { reason: string; minutes: number; count: number; share: number; cumulativeShare: number }

interface Losses {
  from: string;
  to: string;
  total: Slice;
  byReason: ReasonRow[];
  byMachine: Slice[];
  byShift: Slice[];
  byOperator: Slice[];
  byMold: Slice[];
  daily: Slice[];
  /** Gaps between consecutive units, counted into buckets by their upper edge in seconds. */
  cycleTimes?: { edges: number[]; counts: number[]; total: number; medianSeconds: number | null; idealSeconds: number | null };
}

type Period = 'today' | 'yesterday' | 'week' | 'month' | 'last30' | 'custom';
const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom' },
];

type Cut = 'byMachine' | 'byShift' | 'byOperator' | 'byMold';
const CUTS: { value: Cut; label: string; column: string }[] = [
  { value: 'byMachine', label: 'By machine', column: 'Machine' },
  { value: 'byShift', label: 'By shift', column: 'Shift' },
  { value: 'byOperator', label: 'By operator', column: 'Operator' },
  { value: 'byMold', label: 'By mold', column: 'Mold' },
];

const day = (d: Date) => format(d, 'yyyy-MM-dd');
const duration = (minutes: number) => {
  if (!minutes || minutes <= 0) return '–';
  if (minutes < 1) return 'under 1 min';
  if (minutes >= 2880) return `${(minutes / 1440).toFixed(1)} days`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`;
  return `${Math.round(minutes)} min`;
};
const pct = (v: number | null | undefined) => (v == null ? '–' : `${v}%`);

function rangeFor(period: Period, custom: { start: string; end: string }) {
  const now = new Date();
  switch (period) {
    case 'yesterday': return { startDate: day(subDays(now, 1)), endDate: day(subDays(now, 1)) };
    case 'week': return { startDate: day(startOfWeek(now, { weekStartsOn: 1 })), endDate: day(now) };
    case 'month': return { startDate: day(startOfMonth(now)), endDate: day(now) };
    case 'last30': return { startDate: day(subDays(now, 29)), endDate: day(now) };
    case 'custom': return { startDate: custom.start, endDate: custom.end };
    default: return { startDate: day(now), endDate: day(now) };
  }
}

function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const escape = (v: string | number | null) => {
    const text = v == null ? '' : String(v);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [header, ...rows].map((r) => r.map(escape).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const Analysis: React.FC = () => {
  const { isAdmin } = useAuth();
  const { labelOf } = useStoppageReasons();
  const [period, setPeriod] = useState<Period>('week');
  const [customDraft, setCustomDraft] = useState({ start: '', end: '' });
  const [custom, setCustom] = useState({ start: '', end: '' });
  const [departmentId, setDepartmentId] = useState('');
  const [cut, setCut] = useState<Cut>('byMachine');

  const range = rangeFor(period, custom);
  const ready = period !== 'custom' || (!!custom.start && !!custom.end);

  const departmentsQ = useQuery<{ _id: string; name: string }[]>({
    queryKey: ['analysis-departments'],
    queryFn: () => apiService.getDepartments(100),
    enabled: isAdmin,
  });

  const lossesQ = useQuery<Losses>({
    queryKey: ['losses', range.startDate, range.endDate, departmentId],
    queryFn: () => apiService.getLosses({ ...range, ...(departmentId ? { departmentId } : {}) }),
    enabled: ready,
  });

  const data = lossesQ.data;
  const total = data?.total;
  const rows = useMemo(() => (data ? data[cut] : []), [data, cut]);
  const cutMeta = CUTS.find((c) => c.value === cut)!;
  const longestReason = Math.max(1, ...(data?.byReason.map((r) => r.minutes) ?? [0]));
  const mostUnits = Math.max(1, ...(data?.daily.map((d) => d.units) ?? [0]));
  const hasData = !!total && (total.units > 0 || total.runningMinutes > 0 || total.stoppedMinutes > 0);
  const cycles = data?.cycleTimes;
  const tallestBucket = Math.max(1, ...(cycles?.counts ?? [0]));
  const seconds = (n: number) => (n >= 60 ? `${Math.round(n / 6) / 10} min` : `${n} s`);
  const unclassified = data?.byReason.find((r) => r.reason === 'unclassified');

  const exportCsv = () => {
    if (!data) return;
    downloadCsv(
      `linesentry-${cut.replace('by', '').toLowerCase()}-${data.from}-to-${data.to}.csv`,
      [cutMeta.column, 'Units', 'Expected units', 'Defective', 'Running (min)', 'Stopped (min)', 'Stoppages', 'Breakdowns', 'Availability %', 'Performance %', 'Quality %', 'OEE %', 'MTBF (min)', 'MTTR (min)', 'Breakdowns per 100 running hours'],
      rows.map((r) => [r.name ?? '', r.units, r.expectedUnits, r.defective, Math.round(r.runningMinutes), Math.round(r.stoppedMinutes), r.stoppages, r.breakdowns, r.availability, r.performance, r.quality, r.oee, r.mtbfMinutes, r.mttrMinutes, r.failureRate]),
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analysis"
        description="Where time and output were lost, and who or what it happened to."
        actions={
          <Button variant="outline" onClick={exportCsv} disabled={!hasData}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Period> ariaLabel="Period" value={period} onChange={setPeriod} options={PERIODS} />
        {period === 'custom' && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); if (customDraft.start && customDraft.end) setCustom(customDraft); }}
          >
            <Input type="date" aria-label="Start date" className="w-40" value={customDraft.start} max={customDraft.end || undefined} onChange={(e) => setCustomDraft({ ...customDraft, start: e.target.value })} />
            <span className="text-[13px] text-muted-foreground">to</span>
            <Input type="date" aria-label="End date" className="w-40" value={customDraft.end} min={customDraft.start || undefined} onChange={(e) => setCustomDraft({ ...customDraft, end: e.target.value })} />
            <Button type="submit" disabled={!customDraft.start || !customDraft.end}>Show</Button>
          </form>
        )}
        {isAdmin && (
          <Select aria-label="Department" className="w-52" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">All departments</option>
            {(departmentsQ.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </Select>
        )}
      </div>

      {!ready ? (
        <Section><p className="text-[13px] text-muted-foreground">Choose a start date and an end date, then select Show.</p></Section>
      ) : lossesQ.isLoading ? (
        <PageLoader label="Adding up the period…" />
      ) : lossesQ.isError || !data || !total ? (
        <Section>
          <EmptyState
            title="The analysis could not be loaded"
            description="Check the connection and try again."
            action={<Button variant="outline" onClick={() => lossesQ.refetch()}>Try again</Button>}
          />
        </Section>
      ) : !hasData ? (
        <Section>
          <EmptyState title="Nothing was recorded in this period" description="Pick a different period, or check that machines are sending signals in Setup." />
        </Section>
      ) : (
        <>
          <StatStrip>
            <Stat label="OEE" value={total.oee ?? '–'} unit={total.oee != null ? '%' : undefined} hint={total.oee == null ? 'Needs a mold on the timeline' : 'Availability × Performance × Quality'} />
            <Stat label="Availability" value={total.availability} unit="%" hint={total.stoppedMinutes > 0 ? `${duration(total.stoppedMinutes)} stopped` : 'No stopped time'} />
            <Stat label="Units" value={formatNumber(total.units)} hint={total.expectedUnits > 0 ? `${formatNumber(total.expectedUnits)} expected` : `${formatNumber(total.defective)} defective`} />
            <Stat label="Time between breakdowns" value={duration(total.mtbfMinutes)} hint={`${total.breakdowns} ${total.breakdowns === 1 ? 'breakdown' : 'breakdowns'}`} />
            <Stat label="Time to repair" value={duration(total.mttrMinutes)} hint={`${total.failureRate} per 100 running hours`} />
          </StatStrip>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
            <Section
              className="xl:col-span-3"
              title="Stoppage time by reason"
              description="Longest first. The percentage on the right is the running total, so the first few rows show where most of the lost time is."
            >
              {data.byReason.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No stoppages in this period.</p>
              ) : (
                <ul className="space-y-3">
                  {data.byReason.map((r) => (
                    <li key={r.reason} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
                      <span className={cn('truncate text-[13px]', r.reason === 'unclassified' ? 'text-destructive' : 'text-foreground')}>{labelOf(r.reason)}</span>
                      <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <span
                          className={cn('block h-full rounded-full', r.reason === 'unclassified' ? 'bg-destructive' : 'bg-foreground/60')}
                          style={{ width: `${Math.max(1.5, (r.minutes / longestReason) * 100)}%` }}
                        />
                      </span>
                      <span className="tabular whitespace-nowrap text-right text-[13px] text-muted-foreground">
                        <span className="font-medium text-foreground">{r.minutes > 0 ? duration(r.minutes) : 'under 1 min'}</span> · {r.count}× · {r.cumulativeShare}%
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {unclassified && unclassified.minutes >= 1 && (
                <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                  {duration(unclassified.minutes)} of stopped time has no reason recorded. Open the machine and add one so it counts in the right row.
                </p>
              )}
            </Section>

            <Section className="xl:col-span-2" title="Units per day" description={data.daily.length > 1 ? `${data.daily.length} days` : undefined}>
              <div className="flex h-40 items-end gap-1">
                {data.daily.map((d) => (
                  <div key={d.date} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end">
                    <div
                      className="mx-auto w-full max-w-[28px] rounded-t-[2px] bg-foreground/55 transition-colors duration-150 group-hover:bg-foreground/80"
                      style={{ height: `${Math.max(d.units > 0 ? 2 : 0, (d.units / mostUnits) * 100)}%` }}
                      role="img"
                      aria-label={`${d.date}: ${d.units} units, OEE ${pct(d.oee)}`}
                    />
                    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-md group-hover:block">
                      <span className="block font-medium text-foreground">{format(new Date(`${d.date}T00:00:00`), 'EEE d MMM')}</span>
                      <span className="block text-muted-foreground">{formatNumber(d.units)} units · OEE {pct(d.oee)}</span>
                      <span className="block text-muted-foreground">Stopped {duration(d.stoppedMinutes)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>{format(new Date(`${data.daily[0]?.date ?? data.from}T00:00:00`), 'd MMM')}</span>
                {data.daily.length > 1 && <span>{format(new Date(`${data.daily[data.daily.length - 1].date}T00:00:00`), 'd MMM')}</span>}
              </div>
            </Section>
          </div>

          {cycles && cycles.total > 0 && (
            <Section
              title="Time between units"
              description={
                cycles.medianSeconds != null
                  ? `Half of all units followed the one before within ${seconds(cycles.medianSeconds)}${cycles.idealSeconds ? `; the molds in use call for ${seconds(cycles.idealSeconds)}` : ''}. Bars to the right are slow cycles and short stops.`
                  : undefined
              }
            >
              <div className="flex h-36 items-end gap-1.5">
                {cycles.counts.map((count, i) => {
                  const from = i === 0 ? 0 : cycles.edges[i - 1];
                  const label = `${from} to ${seconds(cycles.edges[i])}`;
                  const slow = cycles.idealSeconds != null && from >= cycles.idealSeconds * 2;
                  return (
                    <div key={cycles.edges[i]} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end">
                      <div
                        className={cn('w-full rounded-t-[2px] transition-colors duration-150', slow ? 'bg-warning/70 group-hover:bg-warning' : 'bg-foreground/55 group-hover:bg-foreground/80')}
                        style={{ height: `${count > 0 ? Math.max(2, (count / tallestBucket) * 100) : 0}%` }}
                        role="img"
                        aria-label={`${label}: ${count} units`}
                      />
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-md group-hover:block">
                        <span className="block font-medium text-foreground">{label}</span>
                        <span className="block text-muted-foreground">{formatNumber(count)} units · {Math.round((count / cycles.total) * 100)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex gap-1.5 text-[11px] text-muted-foreground" aria-hidden>
                {cycles.edges.map((edge) => (
                  <span key={edge} className="min-w-0 flex-1 truncate text-center">{seconds(edge)}</span>
                ))}
              </div>
            </Section>
          )}

          <Section flush>
            <div className="px-5 pt-3">
              <Tabs<Cut> ariaLabel="Compare by" value={cut} onChange={setCut} tabs={CUTS.map((c) => ({ value: c.value, label: c.label }))} />
            </div>
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-5 py-2 font-medium">{cutMeta.column}</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Units</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Stopped</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Stoppages</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Availability</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Performance</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Quality</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">OEE</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Time to repair</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td className={cn('px-5 py-2.5 font-medium', r.key === 'unassigned' ? 'text-muted-foreground' : 'text-foreground')}>{r.name}</td>
                      <td className="px-5 py-2.5 text-right">{formatNumber(r.units)}</td>
                      <td className="px-5 py-2.5 text-right">{duration(r.stoppedMinutes)}</td>
                      <td className="px-5 py-2.5 text-right">{r.stoppages}</td>
                      <td className="px-5 py-2.5 text-right">{pct(r.availability)}</td>
                      <td className="px-5 py-2.5 text-right">{pct(r.performance)}</td>
                      <td className="px-5 py-2.5 text-right">{pct(r.quality)}</td>
                      <td className="px-5 py-2.5 text-right font-medium">{pct(r.oee)}</td>
                      <td className="px-5 py-2.5 text-right">{duration(r.mttrMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
};

export default Analysis;
