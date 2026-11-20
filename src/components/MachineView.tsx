import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { format, startOfYear, startOfMonth, startOfWeek, startOfDay } from 'date-fns';
import { Pencil } from 'lucide-react';
import { Machine, MachineStats, MachineStatus } from '../types';
import apiService from '../services/api';
import socketService from '../services/socket';
import { useAuth } from '../context/auth-context';
import { useSocketEvent } from '../hooks/useSocketEvent';
import ProductionTimeline from './ProductionTimeline';
import {
  Button, EmptyState, Field, Input, Modal, PageHeader, PageLoader, Section, Segmented, Spinner, Stat, StatStrip,
  StatusDot, formatNumber,
} from './ui';

type Period = 'today' | 'week' | 'month' | 'year' | 'custom';
const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom' },
];
const fmt = (d: Date) => format(d, 'yyyy-MM-dd');
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Minutes as "3 h 20 min", "45 min" or "2.5 days". */
const duration = (minutes: number | undefined) => {
  if (!minutes || minutes <= 0) return '–';
  if (minutes >= 2880) return `${(minutes / 1440).toFixed(1)} days`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`;
  return `${Math.round(minutes)} min`;
};

/* One OEE factor: what it is in plain words, its value, and a bar to compare
   the three at a glance. The bar is neutral; the lowest factor is the one to
   work on and is the only one marked. */
const Factor = ({ name, meaning, value, lowest }: { name: string; meaning: string; value: number; lowest: boolean }) => (
  <div>
    <div className="flex items-baseline justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {name}
          {lowest && <span className="ml-2 text-xs font-normal text-warning">Lowest</span>}
        </p>
        <p className="text-xs text-muted-foreground">{meaning}</p>
      </div>
      <p className="tabular shrink-0 text-sm font-semibold text-foreground">{value}%</p>
    </div>
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <div
        className={lowest ? 'h-full rounded-full bg-warning' : 'h-full rounded-full bg-foreground/70'}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  </div>
);

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 py-2">
    <dt className="text-[13px] text-muted-foreground">{label}</dt>
    <dd className="text-sm font-medium text-foreground">{value}</dd>
  </div>
);

const MachineView: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();

  const [selectedPeriod, setSelectedPeriod] = useState<Period>('today');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [appliedCustomDates, setAppliedCustomDates] = useState({ start: '', end: '' });
  const [machineStatus, setMachineStatus] = useState<string>('inactive');
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', description: '' });

  const range = (): { startDate: string; endDate: string } => {
    const now = new Date();
    switch (selectedPeriod) {
      case 'week': return { startDate: fmt(startOfWeek(now)), endDate: fmt(now) };
      case 'month': return { startDate: fmt(startOfMonth(now)), endDate: fmt(now) };
      case 'year': return { startDate: fmt(startOfYear(now)), endDate: fmt(now) };
      case 'custom': return { startDate: appliedCustomDates.start || customStartDate, endDate: appliedCustomDates.end || customEndDate };
      default: return { startDate: fmt(startOfDay(now)), endDate: fmt(now) };
    }
  };

  const machineQ = useQuery<Machine>({ queryKey: ['machine', id], queryFn: () => apiService.getMachine(id!), enabled: !!id });
  const statsQ = useQuery<MachineStats>({
    queryKey: ['machine-stats', id, selectedPeriod, appliedCustomDates.start, appliedCustomDates.end],
    queryFn: () => apiService.getMachineStats(id!, range()),
    enabled: !!id && (selectedPeriod !== 'custom' || (!!appliedCustomDates.start && !!appliedCustomDates.end)),
  });

  const machine = machineQ.data ?? null;
  const stats = statsQ.data ?? null;

  // Seed edit form + live status from the fetched machine
  useEffect(() => {
    if (machineQ.data) {
      setEditForm({ name: machineQ.data.name, description: machineQ.data.description || '' });
      setMachineStatus((prev) => (prev === 'inactive' ? machineQ.data!.status : prev));
    }
  }, [machineQ.data]);

  // Join the machine's realtime room
  useEffect(() => {
    if (!id) return;
    socketService.connect();
    socketService.joinMachine(id);
    return () => socketService.leaveMachine(id);
  }, [id]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['machine-stats', id] });
  };
  const forMachine = (cb: () => void) => (u: { machineId: string }) => { if (u.machineId === id) cb(); };

  useSocketEvent('production-update', forMachine(refresh));
  useSocketEvent('production-assignment-updated', forMachine(refresh));
  useSocketEvent('stoppage-updated', forMachine(refresh));
  useSocketEvent('stoppage-added', forMachine(() => { refresh(); queryClient.invalidateQueries({ queryKey: ['machine', id] }); }));
  useSocketEvent('machine-state-update', (u) => {
    if (u.machineId !== id) return;
    setMachineStatus(u.status);
    queryClient.setQueryData<Machine>(['machine', id], (m) => (m ? { ...m, status: u.dbStatus as MachineStatus } : m));
  });

  const handleApplyCustomDates = () => {
    if (!customStartDate || !customEndDate) return toast.error('Choose a start date and an end date');
    if (customStartDate > customEndDate) return toast.error('The start date must be on or before the end date');
    setAppliedCustomDates({ start: customStartDate, end: customEndDate });
  };
  const hasUnappliedChanges = selectedPeriod === 'custom'
    && (customStartDate !== appliedCustomDates.start || customEndDate !== appliedCustomDates.end)
    && !!customStartDate && !!customEndDate;

  const handleSaveEdit = async () => {
    if (!machine || !id) return;
    try {
      await apiService.updateMachine(id, editForm);
      queryClient.invalidateQueries({ queryKey: ['machine', id] });
      setIsEditing(false);
      toast.success('Machine details saved');
    } catch (err) {
      toast.error(errMsg(err, 'Failed to update machine'));
    }
  };

  const handleAddStoppage = async (stoppage: Record<string, unknown>) => {
    try {
      await apiService.addStoppageRecord({ ...stoppage, machineId: id });
      toast.success('Stoppage recorded');
      refresh();
    } catch (err) {
      toast.error(errMsg(err, 'Failed to record stoppage'));
    }
  };
  const handleUpdateProduction = async (machineId: string, hour: number, date: string, data: Record<string, unknown>) => {
    try {
      await apiService.updateProductionAssignment({ machineId, hour, date, ...data });
      toast.success('Saved');
      refresh();
    } catch (err) {
      toast.error(errMsg(err, 'Failed to update production data'));
    }
  };

  if (machineQ.isLoading) return <PageLoader label="Loading machine…" />;
  if (!machine) {
    return (
      <EmptyState
        title="Machine not found"
        description="It may have been removed."
        action={<Button variant="outline" onClick={() => navigate('/dashboard')}>Back to overview</Button>}
      />
    );
  }

  const displayStatus = machineStatus || machine.status;
  const needDates = selectedPeriod === 'custom' && (!appliedCustomDates.start || !appliedCustomDates.end);
  const periodLabel = PERIODS.find((p) => p.value === selectedPeriod)?.label.toLowerCase() ?? '';
  const good = stats ? stats.totalUnitsProduced - stats.totalDefectiveUnits : 0;
  const defectRate = stats && stats.totalUnitsProduced > 0 ? ((stats.totalDefectiveUnits / stats.totalUnitsProduced) * 100).toFixed(1) : '0.0';
  const factors = stats
    ? [
        { name: 'Availability', meaning: 'Share of the time the machine was running, not stopped.', value: stats.availability },
        { name: 'Performance', meaning: 'Units made compared with what the mold should make in that time.', value: stats.performance },
        { name: 'Quality', meaning: 'Share of units that were good, not defective.', value: stats.quality },
      ]
    : [];
  const lowest = factors.length && stats && stats.oee < 100 ? Math.min(...factors.map((f) => f.value)) : null;
  // The hour-by-hour view follows the period chosen at the top of the page.
  const timelinePeriod =
    selectedPeriod === 'year'
      ? { timeframe: 'custom' as const, start: fmt(startOfYear(new Date())), end: fmt(new Date()) }
      : selectedPeriod === 'custom'
        ? { timeframe: 'custom' as const, start: appliedCustomDates.start, end: appliedCustomDates.end }
        : { timeframe: selectedPeriod };
  const deptId = typeof machine.departmentId === 'string' ? machine.departmentId : (machine.departmentId as { _id?: string } | undefined)?._id;

  return (
    <div className="space-y-6">
      <PageHeader
        title={machine.name}
        description={machine.description}
        meta={<StatusDot status={displayStatus} />}
        onBack={() => (deptId ? navigate(`/department/${deptId}`) : navigate(-1))}
        backLabel="Back to department"
        actions={
          isAdmin ? (
            <Button variant="outline" onClick={() => setIsEditing(true)}><Pencil className="h-4 w-4" /> Edit details</Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Period> ariaLabel="Period" value={selectedPeriod} onChange={setSelectedPeriod} options={PERIODS} />
        {selectedPeriod === 'custom' && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); handleApplyCustomDates(); }}
          >
            <Input type="date" aria-label="Start date" className="w-40" value={customStartDate} max={customEndDate || undefined} onChange={(e) => setCustomStartDate(e.target.value)} />
            <span className="text-[13px] text-muted-foreground">to</span>
            <Input type="date" aria-label="End date" className="w-40" value={customEndDate} min={customStartDate || undefined} onChange={(e) => setCustomEndDate(e.target.value)} />
            <Button type="submit" variant={hasUnappliedChanges ? 'primary' : 'outline'} disabled={!customStartDate || !customEndDate || (!hasUnappliedChanges && !!appliedCustomDates.start)}>
              {hasUnappliedChanges || !appliedCustomDates.start ? 'Show' : 'Showing'}
            </Button>
          </form>
        )}
      </div>

      {statsQ.isLoading ? (
        <div className="flex items-center justify-center gap-3 py-16 text-[13px] text-muted-foreground"><Spinner className="h-4 w-4" /> Loading figures…</div>
      ) : needDates ? (
        <Section><p className="text-[13px] text-muted-foreground">Choose a start date and an end date, then select Show.</p></Section>
      ) : !stats ? (
        <Section><p className="text-[13px] text-muted-foreground">No production was recorded for {periodLabel}.</p></Section>
      ) : (
        <>
          <StatStrip>
            <Stat label="OEE" value={stats.oee} unit="%" hint="Availability × Performance × Quality" />
            <Stat label="Units made" value={formatNumber(stats.totalUnitsProduced)} hint={`${formatNumber(good)} good`} />
            <Stat label="Running time" value={duration(stats.totalRunningMinutes)} />
            <Stat
              label="Defects"
              value={formatNumber(stats.totalDefectiveUnits)}
              hint={`${defectRate}% of units`}
              tone={stats.totalDefectiveUnits > 0 ? 'warn' : 'neutral'}
            />
          </StatStrip>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <Section title="What makes up OEE" description="The lowest of the three is where time or output is being lost." className="lg:col-span-3">
              <div className="space-y-5">
                {factors.map((f) => (
                  <Factor key={f.name} {...f} lowest={lowest != null && f.value === lowest && f.value < 100} />
                ))}
              </div>
            </Section>

            <Section title="Reliability" className="lg:col-span-2">
              <dl className="-my-2 divide-y divide-border">
                <Row label="Average time between breakdowns" value={duration(stats.mtbf)} />
                <Row label="Average time to repair" value={duration(stats.mttr)} />
                <Row label="Running time" value={duration(stats.totalRunningMinutes)} />
                <Row label="Good units" value={formatNumber(good)} />
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">
                Breakdown figures count stoppages classified as a breakdown.
              </p>
            </Section>
          </div>
        </>
      )}

      <Section title="Hour by hour" description="Units, stoppages, operator and mold for each hour. Select an hour to record or classify.">
        <ProductionTimeline
          machineId={id!}
          onAddStoppage={handleAddStoppage}
          onUpdateProduction={handleUpdateProduction}
          period={timelinePeriod}
        />
      </Section>

      <Modal
        open={isEditing}
        onClose={() => setIsEditing(false)}
        title="Edit machine details"
        footer={
          <>
            <Button variant="outline" onClick={() => setIsEditing(false)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={!editForm.name.trim()}>Save</Button>
          </>
        }
      >
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (editForm.name.trim()) handleSaveEdit(); }}>
          <Field label="Name">
            <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
          </Field>
          <Field label="Description" hint="Optional. Shown under the name.">
            <Input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
          </Field>
        </form>
      </Modal>
    </div>
  );
};

export default MachineView;
