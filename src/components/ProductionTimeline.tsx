import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO, isToday } from 'date-fns';
import { toast } from 'react-toastify';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ProductionTimelineDay, ProductionHour, StoppageRecord, User, Mold } from '../types';
import socketService from '../services/socket';
import apiService from '../services/api';
import { useAuth } from '../context/auth-context';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { Button, Field, IconButton, Input, Select, Modal, Segmented, Spinner, Tabs, formatNumber } from './ui';
import { cn } from '../lib/cn';
import { KIND_LABELS, useStoppageReasons } from '../lib/reasons';

interface ProductionTimelineProps {
  machineId: string;
  onAddStoppage?: (stoppage: Partial<StoppageRecord>) => void;
  onUpdateProduction?: (machineId: string, hour: number, date: string, data: Record<string, unknown>) => void;
  /** When given, the page chooses the days and the timeline hides its own picker. */
  period?: { timeframe: 'today' | 'week' | 'month' | 'custom'; start?: string; end?: string };
}

interface Shift { name: string; startTime: string; endTime: string; isActive?: boolean }

const fmtHour = (h: number) => `${h.toString().padStart(2, '0')}:00`;
const isPending = (s: StoppageRecord) => s.reason === 'unclassified' || !!(s as { isPending?: boolean }).isPending;
const TEXTAREA_CLASS =
  'flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-[border-color,box-shadow] duration-150 ease-out hover:border-foreground/30 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20 focus-visible:ring-offset-0';

type HourTab = 'details' | 'assignment' | 'stoppage';

/* ---------------------------------------------------------------- modal --- */

interface ProductionModalProps {
  open: boolean;
  onClose: () => void;
  hour: ProductionHour;
  date: string;
  machineId: string;
  availableOperators?: User[];
  availableMolds?: Mold[];
  shifts: Shift[];
  initialTab?: HourTab;
}

const SummaryRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 py-2">
    <dt className="text-[13px] text-muted-foreground">{label}</dt>
    <dd className="text-sm font-medium text-foreground">{value}</dd>
  </div>
);

const ProductionModal: React.FC<ProductionModalProps> = ({
  open, onClose, hour, date, machineId, availableOperators = [], availableMolds = [], shifts = [], initialTab,
}) => {
  const { user: currentUser } = useAuth();
  const { reasons, labelOf, kindOf } = useStoppageReasons();
  const [activeTab, setActiveTab] = useState<HourTab>(initialTab ?? (hour.stoppages.some(isPending) ? 'stoppage' : 'details'));
  const [stoppageForm, setStoppageForm] = useState({ reason: '', description: '', duration: 5, sapNotificationNumber: '' });
  const [assignmentForm, setAssignmentForm] = useState({
    operatorId: currentUser?.role === 'operator' ? (currentUser._id || '') : (hour.operator?._id || ''),
    moldId: hour.mold?._id || '',
    defectiveUnits: hour.defectiveUnits || 0,
  });
  const [applyToShift, setApplyToShift] = useState(false);
  const [shiftInfo, setShiftInfo] = useState<{ name: string; hours: number[] } | null>(null);

  const pendingStoppage = hour.stoppages.find((s) => s.reason === 'unclassified' || (s as { isPending?: boolean }).isPending);

  // Detect the shift containing this hour (for the apply-to-shift option)
  useEffect(() => {
    if (shifts.length === 0 || !hour) return;
    const current = shifts.find((shift) => {
      const start = parseInt(shift.startTime.split(':')[0]);
      const end = parseInt(shift.endTime.split(':')[0]);
      return end > start ? hour.hour >= start && hour.hour < end : hour.hour >= start || hour.hour < end;
    });
    if (!current) { setShiftInfo(null); setApplyToShift(false); return; }
    const start = parseInt(current.startTime.split(':')[0]);
    const end = parseInt(current.endTime.split(':')[0]);
    const hours: number[] = [];
    if (start <= end) { for (let h = start; h < end; h++) hours.push(h); }
    else if (hour.hour >= start) { for (let h = start; h < 24; h++) hours.push(h); }
    else { for (let h = 0; h < end; h++) hours.push(h); }
    setShiftInfo({ name: current.name, hours });
    setApplyToShift(false);
  }, [shifts, hour]);

  const isBreakdown = !!stoppageForm.reason && kindOf(stoppageForm.reason) === 'breakdown';

  const handleStoppageSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stoppageForm.reason.trim()) return;
    if (isBreakdown) {
      if (!stoppageForm.sapNotificationNumber.trim()) return toast.error('Enter the SAP notification number for this breakdown');
      if (!/^\d+$/.test(stoppageForm.sapNotificationNumber.trim())) return toast.error('The SAP notification number can only contain digits');
    }
    try {
      await apiService.addStoppageRecord({
        machineId, hour: hour.hour, date,
        reason: stoppageForm.reason,
        description: stoppageForm.description.trim(),
        duration: stoppageForm.duration,
        ...(isBreakdown && { sapNotificationNumber: stoppageForm.sapNotificationNumber }),
        ...(pendingStoppage && { pendingStoppageId: (pendingStoppage as { _id?: string })._id }),
      });
      setStoppageForm({ reason: '', description: '', duration: 5, sapNotificationNumber: '' });
      toast.success(pendingStoppage ? 'Stoppage classified' : 'Stoppage recorded');
      onClose();
    } catch {
      toast.error('Could not save the stoppage. Try again.');
    }
    socketService.emit('stoppage-updated', { machineId, date, hour: hour.hour });
  };

  const handleAssignmentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const operatorId = assignmentForm.operatorId === '' ? null : assignmentForm.operatorId;
    const moldId = assignmentForm.moldId === '' ? null : assignmentForm.moldId;
    try {
      await apiService.updateProductionAssignment({
        machineId, hour: hour.hour, date, operatorId, moldId,
        defectiveUnits: assignmentForm.defectiveUnits,
        applyToShift: shiftInfo ? applyToShift : false,
      });
      toast.success(applyToShift && shiftInfo ? `Saved for the whole ${shiftInfo.name} shift` : 'Saved');
      onClose();
    } catch {
      toast.error('Could not save. Try again.');
    }
    socketService.emit('production-assignment-updated', {
      machineId, date,
      hours: applyToShift && shiftInfo ? shiftInfo.hours : [hour.hour],
      originalHour: hour.hour, operatorId, moldId, defectiveUnits: assignmentForm.defectiveUnits,
    });
  };

  const runningMinutes = Math.min(60, hour.runningMinutes || 0);
  const stoppageMinutes = Math.min(60, hour.stoppageMinutes || 0);
  const inactiveMinutes = 60 - runningMinutes - stoppageMinutes;

  const good = Math.max(0, hour.unitsProduced - hour.defectiveUnits);
  const target = hour.mold?.productionCapacityPerHour;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`${format(parseISO(date), 'EEE d MMM')}, ${fmtHour(hour.hour)} to ${fmtHour((hour.hour + 1) % 24)}`}
      description={pendingStoppage ? 'The machine stopped in this hour and no reason has been recorded.' : undefined}
    >
      <div className="-mt-1 mb-5">
        <Tabs<HourTab>
          ariaLabel="Hour details"
          value={activeTab}
          onChange={setActiveTab}
          tabs={[
            { value: 'details', label: 'Summary' },
            { value: 'assignment', label: 'Operator and mold' },
            { value: 'stoppage', label: pendingStoppage ? 'Classify stoppage' : 'Record a stoppage' },
          ]}
        />
      </div>

      {activeTab === 'details' && (
        <div className="space-y-5">
          <dl className="-my-2 divide-y divide-border">
            <SummaryRow label="Units made" value={`${formatNumber(hour.unitsProduced)}${target ? ` of ${formatNumber(target)} expected` : ''}`} />
            <SummaryRow label="Good units" value={formatNumber(good)} />
            <SummaryRow label="Defective units" value={formatNumber(hour.defectiveUnits)} />
            <SummaryRow label="Operator" value={hour.operator?.username || 'Not assigned'} />
            <SummaryRow label="Mold" value={hour.mold?.name || 'Not assigned'} />
          </dl>

          <div>
            <p className="mb-2 text-[13px] font-medium text-foreground">How the hour was spent</p>
            <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="bg-success" style={{ width: `${(runningMinutes / 60) * 100}%` }} />
              <div className="bg-destructive" style={{ width: `${(stoppageMinutes / 60) * 100}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Running {runningMinutes} min · Stopped {stoppageMinutes} min · Idle {Math.max(0, inactiveMinutes)} min
            </p>
          </div>

          {hour.stoppages.length > 0 && (
            <div>
              <p className="mb-2 text-[13px] font-medium text-foreground">Stoppages</p>
              <ul className="divide-y divide-border rounded-md border border-border">
                {hour.stoppages.map((s, i) => (
                  <li key={s._id ?? i} className="flex items-center justify-between gap-4 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className={cn('text-sm font-medium', isPending(s) ? 'text-destructive' : 'text-foreground')}>{isPending(s) ? 'No reason yet' : labelOf(s.reason)}</p>
                      {s.description && !isPending(s) && <p className="truncate text-xs text-muted-foreground">{s.description}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-[13px] text-muted-foreground">{s.duration || 0} min</span>
                      {isPending(s) && <Button size="sm" onClick={() => setActiveTab('stoppage')}>Add reason</Button>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {activeTab === 'assignment' && (
        <form onSubmit={handleAssignmentSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Operator">
              <Select
                value={assignmentForm.operatorId}
                disabled={currentUser?.role === 'operator'}
                onChange={(e) => setAssignmentForm({ ...assignmentForm, operatorId: e.target.value })}
              >
                <option value="">Not assigned</option>
                {availableOperators.map((op) => <option key={op._id} value={op._id}>{op.username}</option>)}
              </Select>
            </Field>
            <Field label="Mold" hint="Sets the expected units per hour.">
              <Select value={assignmentForm.moldId} onChange={(e) => setAssignmentForm({ ...assignmentForm, moldId: e.target.value })}>
                <option value="">Not assigned</option>
                {availableMolds.map((m) => (
                  <option key={m._id} value={m._id}>{m.name} ({formatNumber(m.productionCapacityPerHour)} per hour)</option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Defective units in this hour" className="max-w-[12rem]">
            <Input
              type="number"
              min={0}
              max={hour.unitsProduced || undefined}
              value={assignmentForm.defectiveUnits}
              onChange={(e) => setAssignmentForm({ ...assignmentForm, defectiveUnits: parseInt(e.target.value) || 0 })}
            />
          </Field>

          {shiftInfo && (
            <label className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5 text-sm text-foreground">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" checked={applyToShift} onChange={(e) => setApplyToShift(e.target.checked)} />
              <span>
                Use this operator and mold for the whole {shiftInfo.name} shift
                <span className="block text-xs text-muted-foreground">
                  {fmtHour(shiftInfo.hours[0])} to {fmtHour((shiftInfo.hours[shiftInfo.hours.length - 1] + 1) % 24)}. Defective units stay on this hour only.
                </span>
              </span>
            </label>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      )}

      {activeTab === 'stoppage' && (
        <form onSubmit={handleStoppageSubmit} className="space-y-4">
          <div>
            <p className="mb-2 text-[13px] font-medium text-foreground">
              {pendingStoppage ? `Why did the machine stop? (${pendingStoppage.duration || 0} min so far)` : 'What stopped the machine?'}
            </p>
            <div role="radiogroup" aria-label="Reason" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {reasons.map((r) => {
                const selected = stoppageForm.reason === r.key;
                return (
                  <button
                    key={r.key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setStoppageForm({ ...stoppageForm, reason: r.key })}
                    className={cn(
                      'pressable min-h-[60px] rounded-md border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected ? 'border-primary bg-primary/[0.06] ring-1 ring-primary' : 'border-border hover:border-foreground/30',
                    )}
                  >
                    <span className="block text-sm font-medium text-foreground">{r.label}</span>
                    <span className="block text-xs text-muted-foreground">{KIND_LABELS[r.kind]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {!pendingStoppage && (
            <Field label="How long, in minutes" className="max-w-[12rem]">
              <Input type="number" required min={1} max={60} value={stoppageForm.duration} onChange={(e) => setStoppageForm({ ...stoppageForm, duration: parseInt(e.target.value) || 5 })} />
            </Field>
          )}

          {isBreakdown && (
            <Field label="SAP notification number" hint="Needed for breakdowns. Digits only.">
              <Input required inputMode="numeric" pattern="[0-9]*" value={stoppageForm.sapNotificationNumber} onChange={(e) => setStoppageForm({ ...stoppageForm, sapNotificationNumber: e.target.value })} />
            </Field>
          )}

          <Field label={stoppageForm.reason === 'other' ? 'What happened' : 'Note (optional)'}>
            <textarea className={TEXTAREA_CLASS} rows={2} value={stoppageForm.description} onChange={(e) => setStoppageForm({ ...stoppageForm, description: e.target.value })} />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!stoppageForm.reason.trim()}>{pendingStoppage ? 'Save reason' : 'Record stoppage'}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
};

/* ------------------------------------------------------------- timeline --- */

type Timeframe = 'today' | 'week' | 'month' | 'custom';
const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'custom', label: 'Custom' },
];

const CHART_HEIGHT = 132; // px available to the tallest bar

const ProductionTimeline: React.FC<ProductionTimelineProps> = ({ machineId, period }) => {
  const { user: currentUser } = useAuth();
  const [data, setData] = useState<ProductionTimelineDay[]>([]);
  const [selectedHour, setSelectedHour] = useState<{ hour: ProductionHour; date: string; tab?: HourTab } | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>('today');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [appliedCustomDates, setAppliedCustomDates] = useState({ start: '', end: '' });
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);

  useEffect(() => {
    if (!period) return;
    setTimeframe(period.timeframe);
    setAppliedCustomDates({ start: period.start ?? '', end: period.end ?? '' });
    setSelectedDayIndex(0);
  }, [period?.timeframe, period?.start, period?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reference data (cached) — operators, molds, shifts
  const operatorsQ = useQuery<User[]>({
    queryKey: ['timeline-operators', currentUser?._id, currentUser?.role],
    queryFn: async () => {
      let operators: User[];
      if (currentUser?.role === 'admin') operators = await apiService.getUsers();
      else operators = [await apiService.getCurrentUser()];
      return operators.filter((u) => u.role === 'operator');
    },
    enabled: !!currentUser,
  });
  const moldsQ = useQuery<Mold[]>({ queryKey: ['molds', 'active'], queryFn: () => apiService.getMolds() });
  const shiftsQ = useQuery<Shift[]>({ queryKey: ['shifts'], queryFn: () => apiService.getShifts() });
  const availableOperators = operatorsQ.data ?? [];
  const availableMolds = moldsQ.data ?? [];

  // Timeline data
  const timelineQ = useQuery<{ timeline: ProductionTimelineDay[] }>({
    queryKey: ['production-timeline', machineId, timeframe, appliedCustomDates.start, appliedCustomDates.end],
    queryFn: () => apiService.getProductionTimeline(
      machineId,
      timeframe === 'custom' ? { timeframe, startDate: appliedCustomDates.start, endDate: appliedCustomDates.end } : { timeframe },
    ),
    enabled: timeframe !== 'custom' || (!!appliedCustomDates.start && !!appliedCustomDates.end),
  });

  useEffect(() => {
    // Only sync when a result actually arrives — switching to "custom" before
    // dates are applied disables the query, and we must not blank the view.
    if (!timelineQ.data) return;
    const tl = timelineQ.data.timeline ?? [];
    setData(tl);
    if (tl.length > 0) {
      const todayIndex = tl.findIndex((d) => isToday(parseISO(d.date)));
      setSelectedDayIndex(todayIndex >= 0 ? todayIndex : 0);
    }
  }, [timelineQ.data]);

  // Join realtime room
  useEffect(() => {
    socketService.connect();
    socketService.joinMachine(machineId);
    return () => socketService.leaveMachine(machineId);
  }, [machineId]);

  // Helper: mutate one hour within a day
  const patchHour = (dt: string, hr: number, fn: (h: ProductionHour) => ProductionHour) =>
    setData((prev) => prev.map((day) => (day.date !== dt ? day : { ...day, hours: day.hours.map((h) => (h.hour === hr ? fn(h) : h)) })));

  useSocketEvent('production-update', (u) => {
    if (u.machineId !== machineId) return;
    patchHour(u.date, u.hour, (h) => ({ ...h, unitsProduced: u.unitsProduced, status: u.status as ProductionHour['status'], runningMinutes: u.runningMinutes ?? h.runningMinutes, stoppageMinutes: u.stoppageMinutes ?? h.stoppageMinutes }));
  });
  useSocketEvent('running-time-update', (u) => {
    if (u.machineId !== machineId) return;
    patchHour(u.date, u.hour, (h) => ({ ...h, runningMinutes: u.runningMinutes, status: 'running' }));
  });
  useSocketEvent('unclassified-stoppage-detected', (u) => {
    if (u.machineId !== machineId) return;
    patchHour(u.date, u.hour, (h) => {
      const exists = h.stoppages.some((s) => s._id === u.pendingStoppageId || s.reason === 'unclassified');
      const stoppages = exists ? h.stoppages : [...h.stoppages, {
        _id: u.pendingStoppageId || `unclassified_${u.timestamp}`,
        reason: 'unclassified' as StoppageRecord['reason'],
        description: 'Automatic stoppage detection - awaiting categorization',
        startTime: u.stoppageStart, endTime: null, duration: 0,
      }];
      return { ...h, stoppages, status: 'stoppage' };
    });
    toast.warning('The machine stopped. Record the reason when you can.');
  });
  useSocketEvent('stoppage-added', (u) => {
    if (u.machineId !== machineId) return;
    const incoming = u.stoppage as { reason: string; description?: string; duration: number };
    patchHour(u.date, u.hour, (h) => {
      const stoppages = h.stoppages.filter((s) => s.reason !== 'unclassified');
      stoppages.push({ _id: `stoppage_${u.timestamp}`, reason: incoming.reason as StoppageRecord['reason'], description: incoming.description, startTime: u.timestamp, endTime: null, duration: incoming.duration });
      return { ...h, status: 'stoppage', stoppages, stoppageMinutes: stoppages.reduce((s, x) => s + (x.duration || 0), 0) };
    });
  });
  useSocketEvent('stoppage-updated', (u) => {
    if (u.machineId !== machineId) return;
    patchHour(u.date, u.hour, (h) => {
      const stoppages = h.stoppages.map((s) => (s._id === u.stoppageId ? { ...s, duration: u.duration } : s));
      return { ...h, stoppages, stoppageMinutes: stoppages.reduce((sum, x) => sum + (x.duration || 0), 0) };
    });
  });
  useSocketEvent('production-assignment-updated', (u) => {
    if (u.machineId !== machineId) return;
    setData((prev) => prev.map((day) => {
      if (day.date !== u.date) return day;
      const hours = [...day.hours];
      u.hours.forEach((targetHour) => {
        let idx = hours.findIndex((h) => h.hour === targetHour);
        if (idx === -1) { hours.push({ hour: targetHour, unitsProduced: 0, defectiveUnits: 0, status: 'inactive', operator: undefined, mold: undefined, stoppages: [], runningMinutes: 0, stoppageMinutes: 0 }); idx = hours.length - 1; }
        const operator = u.operatorId ? availableOperators.find((op) => op._id === u.operatorId) : undefined;
        const mold = u.moldId ? availableMolds.find((m) => m._id === u.moldId) : undefined;
        hours[idx] = { ...hours[idx], operator, mold, ...(targetHour === u.originalHour && u.defectiveUnits !== undefined ? { defectiveUnits: u.defectiveUnits } : {}) };
      });
      return { ...day, hours };
    }));
  });

  const handleApplyCustomDates = () => {
    if (!customStartDate || !customEndDate) return toast.error('Choose a start date and an end date');
    if (customStartDate > customEndDate) return toast.error('The start date must be on or before the end date');
    setAppliedCustomDates({ start: customStartDate, end: customEndDate });
    setTimeframe('custom');
  };
  const hasUnappliedChanges = timeframe === 'custom'
    && (customStartDate !== appliedCustomDates.start || customEndDate !== appliedCustomDates.end)
    && !!customStartDate && !!customEndDate;

  const currentDay = data[selectedDayIndex] || data[0];
  const needDates = timeframe === 'custom' && (!appliedCustomDates.start || !appliedCustomDates.end);
  const dayUnits = currentDay ? currentDay.hours.reduce((s, h) => s + h.unitsProduced, 0) : 0;
  const dayDefects = currentDay ? currentDay.hours.reduce((s, h) => s + h.defectiveUnits, 0) : 0;
  const dayRunning = currentDay ? Math.round(currentDay.hours.reduce((s, h) => s + (h.runningMinutes || 0), 0) / 60 * 10) / 10 : 0;
  const dayStoppages = currentDay ? currentDay.hours.reduce((s, h) => s + h.stoppages.length, 0) : 0;

  const hours = currentDay?.hours ?? [];
  const pendingHours = hours.filter((h) => h.stoppages.some(isPending));
  const scaleMax = Math.max(1, ...hours.map((h) => Math.max(h.unitsProduced, h.mold?.productionCapacityPerHour ?? 0)));
  const dayTarget = hours.reduce((s, h) => s + ((h.runningMinutes || 0) > 0 || h.unitsProduced > 0 ? h.mold?.productionCapacityPerHour ?? 0 : 0), 0);
  const viewingToday = currentDay ? isToday(parseISO(currentDay.date)) : false;
  const nowHour = new Date().getHours();

  return (
    <div className="space-y-4">
      <div className={cn('flex flex-wrap items-center gap-3', period ? 'justify-end' : 'justify-between')}>
        <div className={cn('flex flex-wrap items-center gap-3', period && 'hidden')}>
          <Segmented<Timeframe>
            ariaLabel="Days to show"
            value={timeframe}
            onChange={(p) => { setTimeframe(p); if (p !== 'custom') setSelectedDayIndex(0); }}
            options={TIMEFRAMES}
          />
          {timeframe === 'custom' && (
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); handleApplyCustomDates(); }}>
              <Input type="date" aria-label="Start date" className="w-40" value={customStartDate} max={customEndDate || undefined} onChange={(e) => setCustomStartDate(e.target.value)} />
              <span className="text-[13px] text-muted-foreground">to</span>
              <Input type="date" aria-label="End date" className="w-40" value={customEndDate} min={customStartDate || undefined} onChange={(e) => setCustomEndDate(e.target.value)} />
              <Button type="submit" variant={hasUnappliedChanges || !appliedCustomDates.start ? 'primary' : 'outline'} disabled={!customStartDate || !customEndDate || (!hasUnappliedChanges && !!appliedCustomDates.start)}>
                {hasUnappliedChanges || !appliedCustomDates.start ? 'Show' : 'Showing'}
              </Button>
            </form>
          )}
        </div>

        {currentDay && data.length > 1 && (
          <div className="flex items-center gap-1">
            <IconButton label="Previous day" disabled={selectedDayIndex === 0} onClick={() => setSelectedDayIndex(Math.max(0, selectedDayIndex - 1))}>
              <ChevronLeft className="h-4 w-4" />
            </IconButton>
            <span className="min-w-[9.5rem] text-center text-[13px] font-medium text-foreground">
              {viewingToday ? 'Today' : format(parseISO(currentDay.date), 'EEE d MMM yyyy')}
            </span>
            <IconButton label="Next day" disabled={selectedDayIndex === data.length - 1} onClick={() => setSelectedDayIndex(Math.min(data.length - 1, selectedDayIndex + 1))}>
              <ChevronRight className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>

      {timelineQ.isLoading ? (
        <div className="flex items-center justify-center gap-3 py-16 text-[13px] text-muted-foreground"><Spinner className="h-4 w-4" /> Loading hours…</div>
      ) : needDates ? (
        <p className="py-10 text-center text-[13px] text-muted-foreground">Choose a start date and an end date, then select Show.</p>
      ) : !currentDay ? (
        <p className="py-10 text-center text-[13px] text-muted-foreground">Nothing was recorded in this period.</p>
      ) : (
        <>
          {pendingHours.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/[0.05] px-4 py-2.5">
              <p className="text-[13px] text-foreground">
                <span className="font-medium text-destructive">
                  {pendingHours.length === 1 ? 'One stoppage has no reason yet' : `${pendingHours.length} hours have a stoppage with no reason yet`}
                </span>
                <span className="text-muted-foreground"> · {pendingHours.map((h) => fmtHour(h.hour)).join(', ')}</span>
              </p>
              <Button size="sm" onClick={() => setSelectedHour({ hour: pendingHours[0], date: currentDay.date, tab: 'stoppage' })}>Add reason</Button>
            </div>
          )}

          <div>
            {/* One column per hour: bar height is units made, the tick is what the
                mold should make, and the strip underneath is how the hour was spent. */}
            <div className="flex items-end gap-[3px]" style={{ height: CHART_HEIGHT + 22 }}>
              {hours.map((hour) => {
                const run = Math.min(60, hour.runningMinutes || 0);
                const stop = Math.min(60 - run, hour.stoppageMinutes || 0);
                const pending = hour.stoppages.some(isPending);
                const target = hour.mold?.productionCapacityPerHour ?? 0;
                const barHeight = hour.unitsProduced > 0 ? Math.max(3, (hour.unitsProduced / scaleMax) * CHART_HEIGHT) : 0;
                const isNow = viewingToday && hour.hour === nowHour;
                const summary = `${fmtHour(hour.hour)}: ${hour.unitsProduced} units${target ? ` of ${target} expected` : ''}, running ${run} min, stopped ${stop} min${pending ? ', stoppage needs a reason' : ''}`;
                return (
                  <button
                    key={hour.hour}
                    type="button"
                    aria-label={summary}
                    onClick={() => setSelectedHour({ hour, date: currentDay.date })}
                    className="group relative flex h-full min-w-0 flex-1 flex-col justify-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className={cn('absolute inset-0 rounded-sm transition-colors duration-150 group-hover:bg-foreground/[0.05]', isNow && 'bg-foreground/[0.03]')} aria-hidden />
                    {pending && <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-destructive" aria-hidden />}
                    <span className="relative mx-auto block w-full" style={{ height: CHART_HEIGHT }}>
                      {target > 0 && (
                        <span className="absolute inset-x-0 h-px bg-foreground/40" style={{ bottom: (target / scaleMax) * CHART_HEIGHT }} aria-hidden />
                      )}
                      <span
                        className={cn('absolute inset-x-[15%] bottom-0 rounded-t-[2px]', target > 0 && hour.unitsProduced >= target ? 'bg-foreground/80' : 'bg-foreground/45')}
                        style={{ height: barHeight }}
                        aria-hidden
                      />
                    </span>
                    <span className="relative mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                      <span className="bg-success" style={{ width: `${(run / 60) * 100}%` }} />
                      <span className="bg-destructive" style={{ width: `${(stop / 60) * 100}%` }} />
                    </span>

                    <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-3 py-2 text-left text-xs shadow-md group-hover:block group-focus-visible:block">
                      <span className="block font-medium text-foreground">{fmtHour(hour.hour)}</span>
                      <span className="block text-muted-foreground">
                        {formatNumber(hour.unitsProduced)} units{target ? ` of ${formatNumber(target)} expected` : ''}
                      </span>
                      <span className="block text-muted-foreground">Running {run} min · Stopped {stop} min</span>
                      {hour.defectiveUnits > 0 && <span className="block text-muted-foreground">{hour.defectiveUnits} defective</span>}
                      {(hour.operator || hour.mold) && (
                        <span className="block text-muted-foreground">{[hour.operator?.username, hour.mold?.name].filter(Boolean).join(' · ')}</span>
                      )}
                      {pending && <span className="block text-destructive">Stoppage needs a reason</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-1 flex gap-[3px] text-[11px] text-muted-foreground" aria-hidden>
              {hours.map((h) => (
                <span key={h.hour} className="min-w-0 flex-1 text-center">{h.hour % 3 === 0 ? h.hour.toString().padStart(2, '0') : ''}</span>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border pt-3">
            <p className="text-[13px] text-muted-foreground">
              <span className="font-medium text-foreground">{formatNumber(dayUnits)} units</span>
              {dayTarget > 0 && <> of {formatNumber(dayTarget)} expected</>}
              {' · '}{dayDefects} defective · {dayRunning} h running · {dayStoppages} {dayStoppages === 1 ? 'stoppage' : 'stoppages'}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-foreground/45" /> Units made</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-px w-3 bg-foreground/40" /> Expected</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-3 rounded-full bg-success" /> Running</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-3 rounded-full bg-destructive" /> Stopped</span>
            </div>
          </div>

          {timeframe !== 'today' && data.length > 1 && (
            <div className="overflow-hidden rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">Day</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Units</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Defective</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Running</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Stoppages</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.map((day, index) => {
                    const selected = index === selectedDayIndex;
                    return (
                      <tr
                        key={day.date}
                        tabIndex={0}
                        aria-selected={selected}
                        onClick={() => setSelectedDayIndex(index)}
                        onKeyDown={(e) => { if (e.key === 'Enter') setSelectedDayIndex(index); }}
                        className={cn('cursor-pointer transition-colors duration-150 focus-visible:ring-inset', selected ? 'bg-foreground/[0.05]' : 'hover:bg-foreground/[0.03]')}
                      >
                        <td className="px-4 py-2 text-foreground">
                          <span className={cn(selected && 'font-medium')}>{format(parseISO(day.date), 'EEE d MMM')}</span>
                          {isToday(parseISO(day.date)) && <span className="ml-2 text-xs text-muted-foreground">Today</span>}
                        </td>
                        <td className="px-4 py-2 text-right">{formatNumber(day.hours.reduce((sum, h) => sum + h.unitsProduced, 0))}</td>
                        <td className="px-4 py-2 text-right">{formatNumber(day.hours.reduce((sum, h) => sum + h.defectiveUnits, 0))}</td>
                        <td className="px-4 py-2 text-right">{Math.round(day.hours.reduce((sum, h) => sum + (h.runningMinutes || 0), 0) / 60 * 10) / 10} h</td>
                        <td className="px-4 py-2 text-right">{day.hours.reduce((sum, h) => sum + h.stoppages.length, 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {selectedHour && (
        <ProductionModal
          key={`${selectedHour.date}-${selectedHour.hour.hour}-${selectedHour.tab ?? ''}`}
          open
          onClose={() => setSelectedHour(null)}
          hour={selectedHour.hour}
          date={selectedHour.date}
          machineId={machineId}
          availableOperators={availableOperators}
          availableMolds={availableMolds}
          shifts={shiftsQ.data ?? []}
          initialTab={selectedHour.tab}
        />
      )}
    </div>
  );
};

export default ProductionTimeline;
