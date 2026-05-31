import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO, isToday } from 'date-fns';
import { toast } from 'react-toastify';
import {
  Clock, User as UserIcon, Wrench, AlertTriangle, X, Plus, Play, TrendingUp, TrendingDown,
  Activity, ChevronLeft, ChevronRight, Zap, ZapOff, Calendar, Check,
} from 'lucide-react';
import { ProductionTimelineDay, ProductionHour, StoppageRecord, User, Mold } from '../types';
import socketService from '../services/socket';
import apiService from '../services/api';
import { useAuth } from '../context/auth-context';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { Button, Input, Label, Select, Modal, Spinner } from './ui';
import { cn } from '../lib/cn';

interface ProductionTimelineProps {
  machineId: string;
  onAddStoppage?: (stoppage: Partial<StoppageRecord>) => void;
  onUpdateProduction?: (machineId: string, hour: number, date: string, data: Record<string, unknown>) => void;
}

interface Shift { name: string; startTime: string; endTime: string; isActive?: boolean }

const INPUT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const STOPPAGE_REASONS = [
  { value: 'planned', label: 'Planned Maintenance' },
  { value: 'mold_change', label: 'Mold Change' },
  { value: 'breakdown', label: 'Breakdown' },
  { value: 'maintenance', label: 'Unplanned Maintenance' },
  { value: 'material_shortage', label: 'Material Shortage' },
  { value: 'other', label: 'Other' },
];

const statusColor = (s: string) =>
  s === 'running' ? 'text-success' : s === 'stoppage' ? 'text-destructive' : s === 'stopped_yet_producing' ? 'text-warning' : 'text-muted-foreground';
// Background tint so an hour cell shows its state even before minute-level
// running/stoppage accounting accumulates.
const cellTint = (s: string) =>
  s === 'running' ? 'bg-success/15' : s === 'stoppage' ? 'bg-destructive/20' : s === 'stopped_yet_producing' ? 'bg-warning/20' : 'bg-muted/40';
const statusIcon = (s: string) =>
  s === 'running' ? <Play className="h-4 w-4" /> : s === 'stoppage' ? <AlertTriangle className="h-4 w-4" /> : s === 'stopped_yet_producing' ? <ZapOff className="h-4 w-4" /> : <Activity className="h-4 w-4" />;
const fmtHour = (h: number) => `${h.toString().padStart(2, '0')}:00`;

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
}

const ProductionModal: React.FC<ProductionModalProps> = ({
  open, onClose, hour, date, machineId, availableOperators = [], availableMolds = [], shifts = [],
}) => {
  const { user: currentUser } = useAuth();
  const [activeTab, setActiveTab] = useState<'details' | 'assignment' | 'stoppage'>('details');
  const [stoppageForm, setStoppageForm] = useState({ reason: '', description: '', duration: 5, sapNotificationNumber: '' });
  const [assignmentForm, setAssignmentForm] = useState({
    operatorId: currentUser?.role === 'operator' ? (currentUser._id || '') : (hour.operator?._id || ''),
    moldId: hour.mold?._id || '',
    defectiveUnits: hour.defectiveUnits || 0,
  });
  const [applyToShift, setApplyToShift] = useState(false);
  const [shiftInfo, setShiftInfo] = useState<{ name: string; hours: number[] } | null>(null);
  const [operatorSearch, setOperatorSearch] = useState('');
  const [moldSearch, setMoldSearch] = useState('');
  const [showOperatorResults, setShowOperatorResults] = useState(false);
  const [showMoldResults, setShowMoldResults] = useState(false);

  const pendingStoppage = hour.stoppages.find((s) => s.reason === 'unclassified' || (s as { isPending?: boolean }).isPending);
  const filteredOperators = availableOperators.filter((op) => op.username.toLowerCase().includes(operatorSearch.toLowerCase()));
  const filteredMolds = availableMolds.filter((m) => m.name.toLowerCase().includes(moldSearch.toLowerCase()));

  useEffect(() => {
    setOperatorSearch(hour.operator?.username || '');
    setMoldSearch(hour.mold?.name || '');
  }, [hour]);

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

  const handleStoppageSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stoppageForm.reason.trim()) return;
    if (stoppageForm.reason === 'breakdown') {
      if (!stoppageForm.sapNotificationNumber.trim()) return toast.error('SAP notification number is required for breakdown stoppages');
      if (!/^\d+$/.test(stoppageForm.sapNotificationNumber.trim())) return toast.error('SAP notification number must contain only numbers');
    }
    try {
      await apiService.addStoppageRecord({
        machineId, hour: hour.hour, date,
        reason: stoppageForm.reason,
        description: stoppageForm.description.trim(),
        duration: stoppageForm.duration,
        ...(stoppageForm.reason === 'breakdown' && { sapNotificationNumber: stoppageForm.sapNotificationNumber }),
        ...(pendingStoppage && { pendingStoppageId: (pendingStoppage as { _id?: string })._id }),
      });
      setStoppageForm({ reason: '', description: '', duration: 5, sapNotificationNumber: '' });
      toast.success('Stoppage recorded successfully');
      onClose();
    } catch {
      toast.error('Failed to record stoppage');
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
      toast.success(applyToShift && shiftInfo ? `Assignment updated for entire ${shiftInfo.name} shift` : 'Assignment updated successfully');
      onClose();
    } catch {
      toast.error('Failed to update assignment');
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

  const tabs = [
    { id: 'details', label: 'Details', icon: Activity },
    { id: 'assignment', label: 'Assignment', icon: UserIcon },
    { id: 'stoppage', label: pendingStoppage ? 'Categorize Stoppage' : 'Add Stoppage', icon: pendingStoppage ? AlertTriangle : Plus },
  ] as const;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span>
          Production Details — {format(new Date(date), 'MMM dd')}, {fmtHour(hour.hour)}
          {pendingStoppage && <span className="ml-2 animate-pulse text-sm text-destructive">(Unclassified — needs categorization)</span>}
        </span>
      }
    >
      {/* Tabs */}
      <div className="mb-5 border-b border-border">
        <nav className="flex gap-6">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={cn(
                'flex items-center gap-2 border-b-2 py-3 text-sm font-medium transition-colors',
                activeTab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
                pendingStoppage && t.id === 'stoppage' && 'animate-pulse text-destructive',
              )}
            >
              <t.icon className="h-4 w-4" /> {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Details */}
      {activeTab === 'details' && (
        <div className="space-y-6">
          <div className="rounded-lg bg-muted p-4">
            <h4 className="mb-3 text-sm font-medium text-foreground">Production Summary</h4>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="text-center">
                <TrendingUp className="mx-auto mb-2 h-5 w-5 text-success" />
                <div className="text-2xl font-bold text-foreground">{hour.unitsProduced}</div>
                <div className="text-xs text-muted-foreground">Units Produced</div>
              </div>
              <div className="text-center">
                <TrendingDown className="mx-auto mb-2 h-5 w-5 text-destructive" />
                <div className="text-2xl font-bold text-destructive">{hour.defectiveUnits}</div>
                <div className="text-xs text-muted-foreground">Defective Units</div>
              </div>
              <div className="text-center">
                <div className={cn('mx-auto mb-2 flex justify-center', statusColor(hour.status))}>{statusIcon(hour.status)}</div>
                <div className={cn('text-sm font-medium capitalize', statusColor(hour.status))}>{hour.status.replace(/_/g, ' ')}</div>
                <div className="text-xs text-muted-foreground">Status</div>
              </div>
              <div className="text-center">
                <Activity className="mx-auto mb-2 h-5 w-5 text-info" />
                <div className="text-2xl font-bold text-info">{hour.unitsProduced > 0 ? ((hour.unitsProduced - hour.defectiveUnits) / hour.unitsProduced * 100).toFixed(1) : 0}%</div>
                <div className="text-xs text-muted-foreground">Quality Rate</div>
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-muted p-4">
            <h4 className="mb-3 text-sm font-medium text-foreground">Time Distribution</h4>
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center"><div className="text-lg font-bold text-success">{runningMinutes}m</div><div className="text-xs text-muted-foreground">Running</div></div>
              <div className="text-center"><div className="text-lg font-bold text-destructive">{stoppageMinutes}m</div><div className="text-xs text-muted-foreground">Stoppage</div></div>
              <div className="text-center"><div className="text-lg font-bold text-muted-foreground">{inactiveMinutes}m</div><div className="text-xs text-muted-foreground">Inactive</div></div>
            </div>
            <div className="mt-3 flex h-4 overflow-hidden rounded-full bg-muted-foreground/20">
              <div className="bg-success" style={{ width: `${(runningMinutes / 60) * 100}%` }} />
              <div className="bg-destructive" style={{ width: `${(stoppageMinutes / 60) * 100}%` }} />
              <div className="bg-muted-foreground/40" style={{ width: `${(inactiveMinutes / 60) * 100}%` }} />
            </div>
          </div>

          <div className="rounded-lg bg-muted p-4">
            <h4 className="mb-3 text-sm font-medium text-foreground">Assignment Information</h4>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex items-center gap-3">
                <UserIcon className="h-5 w-5 text-info" />
                <div><div className="text-sm text-muted-foreground">Operator</div><div className="font-medium text-foreground">{hour.operator?.username || 'Not assigned'}</div></div>
              </div>
              <div className="flex items-center gap-3">
                <Wrench className="h-5 w-5 text-primary" />
                <div><div className="text-sm text-muted-foreground">Mold</div><div className="font-medium text-foreground">{hour.mold?.name || 'Not assigned'}</div></div>
              </div>
            </div>
          </div>

          {hour.stoppages.length > 0 && (
            <div className="rounded-lg bg-muted p-4">
              <h4 className="mb-3 text-sm font-medium text-foreground">Stoppages</h4>
              <div className="space-y-3">
                {hour.stoppages.map((s, i) => {
                  const pending = s.reason === 'unclassified' || (s as { isPending?: boolean }).isPending;
                  return (
                    <div key={i} className={cn('rounded-lg p-3', pending ? 'border border-destructive bg-destructive/10' : 'bg-card')}>
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-destructive" />
                          <span className="text-sm font-medium capitalize text-foreground">{s.reason === 'unclassified' ? 'Pending Categorization' : s.reason.replace(/_/g, ' ')}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">{s.duration || 0} min</span>
                      </div>
                      {s.description && <p className="ml-6 text-xs text-muted-foreground">{s.description}</p>}
                      {pending && <p className="ml-6 mt-1 text-xs text-destructive">Use the "Categorize Stoppage" tab to assign a reason.</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Assignment */}
      {activeTab === 'assignment' && (
        <form onSubmit={handleAssignmentSubmit} className="space-y-4">
          <div>
            <Label>Operator</Label>
            <div className="relative">
              <input
                className={INPUT_CLASS}
                placeholder="Search operators…"
                value={operatorSearch}
                onChange={(e) => { setOperatorSearch(e.target.value); setShowOperatorResults(true); }}
                onFocus={() => setShowOperatorResults(true)}
                onBlur={() => setTimeout(() => setShowOperatorResults(false), 200)}
              />
              {operatorSearch && (
                <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => { setOperatorSearch(''); setAssignmentForm((p) => ({ ...p, operatorId: '' })); }}>
                  <X className="h-4 w-4" />
                </button>
              )}
              {showOperatorResults && operatorSearch && (
                <div className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-card shadow-lg">
                  {filteredOperators.length > 0 ? filteredOperators.map((op) => (
                    <div
                      key={op._id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setAssignmentForm((p) => ({ ...p, operatorId: op._id || '' })); setOperatorSearch(op.username); setShowOperatorResults(false); }}
                      className="cursor-pointer px-4 py-2 text-foreground hover:bg-muted"
                    >
                      {op.username}
                    </div>
                  )) : <div className="px-4 py-2 text-muted-foreground">No operators found</div>}
                </div>
              )}
            </div>
          </div>

          <div>
            <Label>Mold</Label>
            <div className="relative">
              <input
                className={INPUT_CLASS}
                placeholder="Search molds…"
                value={moldSearch}
                onChange={(e) => { setMoldSearch(e.target.value); setShowMoldResults(true); }}
                onFocus={() => setShowMoldResults(true)}
                onBlur={() => setTimeout(() => setShowMoldResults(false), 200)}
              />
              {moldSearch && (
                <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => { setMoldSearch(''); setAssignmentForm((p) => ({ ...p, moldId: '' })); }}>
                  <X className="h-4 w-4" />
                </button>
              )}
              {showMoldResults && moldSearch && (
                <div className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-card shadow-lg">
                  {filteredMolds.length > 0 ? filteredMolds.map((m) => (
                    <div
                      key={m._id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setAssignmentForm((p) => ({ ...p, moldId: m._id })); setMoldSearch(m.name); setShowMoldResults(false); }}
                      className="cursor-pointer px-4 py-2 text-foreground hover:bg-muted"
                    >
                      {m.name}
                    </div>
                  )) : <div className="px-4 py-2 text-muted-foreground">No molds found</div>}
                </div>
              )}
            </div>
          </div>

          <div>
            <Label>Defective Units</Label>
            <Input type="number" min={0} value={assignmentForm.defectiveUnits} onChange={(e) => setAssignmentForm({ ...assignmentForm, defectiveUnits: parseInt(e.target.value) || 0 })} />
          </div>

          {shiftInfo && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-primary">
                <input type="checkbox" checked={applyToShift} onChange={(e) => setApplyToShift(e.target.checked)} />
                Apply to entire shift ({shiftInfo.name})
              </label>
              {applyToShift && (
                <div className="mt-2 text-xs text-muted-foreground">
                  <p>This will apply operator and mold to:</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {shiftInfo.hours.map((h) => (
                      <span key={h} className={cn('rounded px-2 py-1', h === hour.hour ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{fmtHour(h)}</span>
                    ))}
                  </div>
                  <p className="mt-2 text-primary">Note: defective units are only updated for the current hour ({fmtHour(hour.hour)}).</p>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button type="submit" className="flex-1">Update Assignment</Button>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      )}

      {/* Stoppage */}
      {activeTab === 'stoppage' && (
        <form onSubmit={handleStoppageSubmit} className="space-y-4">
          {pendingStoppage && (
            <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
              <div className="mb-2 flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-destructive" /><h4 className="font-medium text-destructive">Unclassified Stoppage Detected</h4></div>
              <p className="text-sm text-destructive/90">An unclassified stoppage of {pendingStoppage.duration} minutes was detected automatically. Please categorize its reason.</p>
            </div>
          )}
          <div>
            <Label>Stoppage Reason *</Label>
            <Select required value={stoppageForm.reason} onChange={(e) => setStoppageForm({ ...stoppageForm, reason: e.target.value })}>
              <option value="">Select reason…</option>
              {STOPPAGE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
          </div>
          {!pendingStoppage && (
            <div>
              <Label>Duration (minutes) *</Label>
              <Input type="number" required min={1} max={60} value={stoppageForm.duration} onChange={(e) => setStoppageForm({ ...stoppageForm, duration: parseInt(e.target.value) || 5 })} />
            </div>
          )}
          <div>
            <Label>Description</Label>
            <textarea className={INPUT_CLASS} rows={3} placeholder="Additional details about the stoppage…" value={stoppageForm.description} onChange={(e) => setStoppageForm({ ...stoppageForm, description: e.target.value })} />
          </div>
          {stoppageForm.reason === 'breakdown' && (
            <div>
              <Label>SAP Notification Number *</Label>
              <Input required inputMode="numeric" pattern="[0-9]*" placeholder="Numbers only" value={stoppageForm.sapNotificationNumber} onChange={(e) => setStoppageForm({ ...stoppageForm, sapNotificationNumber: e.target.value })} />
              <p className="mt-1 text-xs text-muted-foreground">Required for breakdown stoppages. Numbers only.</p>
            </div>
          )}
          <div className="flex gap-3 pt-2">
            <Button type="submit" variant="destructive" className="flex-1" disabled={!stoppageForm.reason.trim()}>{pendingStoppage ? 'Categorize Stoppage' : 'Add Stoppage'}</Button>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      )}
    </Modal>
  );
};

/* ------------------------------------------------------------- timeline --- */

const ProductionTimeline: React.FC<ProductionTimelineProps> = ({ machineId }) => {
  const { user: currentUser } = useAuth();
  const [data, setData] = useState<ProductionTimelineDay[]>([]);
  const [selectedHour, setSelectedHour] = useState<{ hour: ProductionHour; date: string } | null>(null);
  const [timeframe, setTimeframe] = useState<'today' | 'week' | 'month' | 'custom'>('today');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [appliedCustomDates, setAppliedCustomDates] = useState({ start: '', end: '' });
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const [machineStatus, setMachineStatus] = useState('inactive');
  const [machineColor, setMachineColor] = useState('gray');

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
  useSocketEvent('machine-state-update', (u) => {
    if (u.machineId !== machineId) return;
    setMachineStatus(u.status);
    setMachineColor(u.color);
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
    toast.warning('Unclassified stoppage detected — requires categorization');
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
    if (!customStartDate || !customEndDate) return toast.error('Please select both start and end dates');
    if (customStartDate > customEndDate) return toast.error('Start date must be before end date');
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

  return (
    <div className="space-y-4">
      {/* Timeframe selector */}
      <div className="space-y-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <span className="text-sm font-medium text-muted-foreground">View Analytics For:</span>
          <div className="flex flex-wrap gap-2">
            {(['today', 'week', 'month', 'custom'] as const).map((p) => (
              <Button key={p} size="sm" variant={timeframe === p ? 'primary' : 'outline'} onClick={() => { setTimeframe(p); if (p !== 'custom') setSelectedDayIndex(0); }}>
                {p === 'custom' && <Calendar className="h-4 w-4" />} {p === 'today' ? 'Today' : p === 'week' ? 'This Week' : p === 'month' ? 'Month to Date' : 'Custom Range'}
              </Button>
            ))}
          </div>
        </div>

        {timeframe === 'custom' && (
          <div className="rounded-xl border-2 border-dashed border-border bg-muted/40 p-6">
            <div className="mb-4 flex items-center gap-3"><Calendar className="h-5 w-5 text-primary" /><h3 className="text-lg font-semibold text-foreground">Custom Date Range</h3></div>
            <div className="grid grid-cols-1 items-end gap-4 md:grid-cols-3">
              <div><Label>Start date</Label><Input type="date" value={customStartDate} onChange={(e) => setCustomStartDate(e.target.value)} /></div>
              <div><Label>End date</Label><Input type="date" value={customEndDate} onChange={(e) => setCustomEndDate(e.target.value)} /></div>
              <Button onClick={handleApplyCustomDates} disabled={!customStartDate || !customEndDate} className={cn(hasUnappliedChanges && 'animate-pulse')}><Check className="h-4 w-4" /> {hasUnappliedChanges ? 'Apply Changes' : 'Applied'}</Button>
            </div>
            {customStartDate && customEndDate && (
              <p className="mt-4 rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                Selected range: <span className="font-medium text-foreground">{new Date(customStartDate).toLocaleDateString()} – {new Date(customEndDate).toLocaleDateString()}</span>
                {appliedCustomDates.start && (customStartDate === appliedCustomDates.start && customEndDate === appliedCustomDates.end ? <span className="ml-2 text-success">✓ Applied</span> : <span className="ml-2 text-warning">⚠ Click Apply to update</span>)}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Machine status */}
      <div className={cn('inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm',
        machineColor === 'green' ? 'bg-success/15 text-success' : machineColor === 'red' ? 'bg-destructive/15 text-destructive' : machineColor === 'orange' ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground')}>
        {machineColor === 'green' ? <Zap className="h-4 w-4" /> : <ZapOff className="h-4 w-4" />}
        <span className="capitalize">{machineStatus.replace(/_/g, ' ')}</span>
      </div>

      {/* Timeline body — selector/picker above always stay visible */}
      {timelineQ.isLoading ? (
        <div className="py-10 text-center"><Spinner className="mx-auto" /><p className="mt-2 text-muted-foreground">Loading production data…</p></div>
      ) : needDates ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center">
          <Calendar className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-muted-foreground">Pick a start and end date above, then click <span className="font-medium text-foreground">Apply</span>.</p>
        </div>
      ) : !currentDay ? (
        <div className="py-10 text-center"><Clock className="mx-auto mb-2 h-8 w-8 text-muted-foreground" /><p className="text-muted-foreground">No production data for this period.</p></div>
      ) : (
      <>
      {/* Day navigation */}
      {data.length > 1 && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
          <Button variant="ghost" size="icon" aria-label="Previous day" disabled={selectedDayIndex === 0} onClick={() => setSelectedDayIndex(Math.max(0, selectedDayIndex - 1))}><ChevronLeft className="h-5 w-5" /></Button>
          <div className="text-center">
            <h3 className="text-lg font-semibold text-foreground">{format(parseISO(currentDay.date), 'EEEE, MMMM dd, yyyy')}</h3>
            <p className="text-sm text-muted-foreground">Total: {dayUnits} units • Defects: {dayDefects}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Next day" disabled={selectedDayIndex === data.length - 1} onClick={() => setSelectedDayIndex(Math.min(data.length - 1, selectedDayIndex + 1))}><ChevronRight className="h-5 w-5" /></Button>
        </div>
      )}

      {/* Hourly timeline */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex text-xs text-muted-foreground">
          {currentDay.hours.map((h) => <div key={h.hour} className="min-w-0 flex-1 text-center">{fmtHour(h.hour)}</div>)}
        </div>
        <div className="mb-3 flex gap-1">
          {currentDay.hours.map((hour) => {
            const unclassified = hour.stoppages.some((s) => s.reason === 'unclassified');
            const run = hour.runningMinutes || 0;
            const stop = hour.stoppageMinutes || 0;
            const inactive = Math.max(0, 60 - run - stop);
            return (
              <div key={hour.hour} className="group relative min-w-0 flex-1 cursor-pointer" onClick={() => setSelectedHour({ hour, date: currentDay.date })}>
                <div className={cn('relative h-12 overflow-hidden rounded border transition-all duration-200 group-hover:scale-105', cellTint(hour.status), unclassified ? 'border-2 border-destructive' : 'border-border')}>
                  <div className="absolute left-0 top-0 h-full bg-success/80" style={{ width: `${(run / 60) * 100}%` }} />
                  <div className={cn('absolute top-0 h-full', unclassified ? 'animate-pulse bg-destructive' : 'bg-destructive/80')} style={{ width: `${(stop / 60) * 100}%`, left: `${(run / 60) * 100}%` }} />
                  <div className="absolute top-0 h-full bg-muted-foreground/40" style={{ width: `${(inactive / 60) * 100}%`, left: `${((run + stop) / 60) * 100}%` }} />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="rounded bg-black/60 px-1 text-xs font-bold text-white">{hour.unitsProduced}</span>
                  </div>
                  <div className="absolute left-0 right-0 top-0 flex justify-between p-0.5">
                    {hour.operator && <div className="h-2 w-2 rounded-full bg-info" title="Operator assigned" />}
                    {hour.defectiveUnits > 0 && <div className="h-2 w-2 rounded-full bg-destructive" title={`${hour.defectiveUnits} defects`} />}
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 flex justify-between p-0.5">
                    {hour.mold && <div className="h-2 w-2 rounded-full bg-primary" title="Mold assigned" />}
                    {hour.stoppages.length > 0 && <div className={cn('h-2 w-2 rounded-full bg-destructive', unclassified && 'animate-pulse')} title={`${hour.stoppages.length} stoppages`} />}
                  </div>
                  {unclassified && (
                    <div className="absolute inset-0 flex animate-pulse items-center justify-center rounded border-2 border-destructive bg-destructive/20">
                      <AlertTriangle className="h-4 w-4 animate-bounce text-destructive" />
                    </div>
                  )}
                </div>
                {/* Hover tooltip */}
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 opacity-0 transition-opacity group-hover:opacity-100">
                  <div className="whitespace-nowrap rounded-lg border border-border bg-card px-3 py-2 text-foreground shadow-lg">
                    <div className="font-medium">{fmtHour(hour.hour)}</div>
                    <div>Units: <span className="text-success">{hour.unitsProduced}</span></div>
                    {hour.defectiveUnits > 0 && <div>Defects: <span className="text-destructive">{hour.defectiveUnits}</span></div>}
                    <div>Running: <span className="text-success">{run}m</span></div>
                    <div>Stoppage: <span className="text-destructive">{stop}m</span></div>
                    <div>Inactive: <span className="text-muted-foreground">{inactive}m</span></div>
                    {hour.operator && <div>Op: <span className="text-info">{hour.operator.username}</span></div>}
                    {hour.mold && <div>Mold: <span className="text-primary">{hour.mold.name}</span></div>}
                    <div>Status: <span className="capitalize">{hour.status.replace(/_/g, ' ')}</span></div>
                    {hour.stoppages.map((s, idx) => <div key={idx} className="text-destructive">{s.reason === 'unclassified' ? 'Unclassified' : s.reason}: {s.duration} min</div>)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-4 gap-4 border-t border-border pt-3">
          <div className="text-center"><div className="text-lg font-bold text-success">{dayUnits}</div><div className="text-xs text-muted-foreground">Total Units</div></div>
          <div className="text-center"><div className="text-lg font-bold text-destructive">{dayDefects}</div><div className="text-xs text-muted-foreground">Defects</div></div>
          <div className="text-center"><div className="text-lg font-bold text-warning">{dayRunning}h</div><div className="text-xs text-muted-foreground">Running</div></div>
          <div className="text-center"><div className="text-lg font-bold text-info">{dayStoppages}</div><div className="text-xs text-muted-foreground">Stoppages</div></div>
        </div>
      </div>

      {/* Week/month overview */}
      {timeframe !== 'today' && data.length > 1 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h4 className="mb-3 text-sm font-medium text-foreground">{timeframe === 'week' ? 'Week' : 'Month'} Overview</h4>
          <div className="space-y-2">
            {data.map((day, index) => (
              <div key={day.date} onClick={() => setSelectedDayIndex(index)}
                className={cn('flex cursor-pointer items-center justify-between rounded p-2 transition-colors', index === selectedDayIndex ? 'border border-primary/30 bg-primary/10' : 'hover:bg-muted')}>
                <div className="text-sm text-foreground">
                  {format(parseISO(day.date), 'MMM dd')}
                  {isToday(parseISO(day.date)) && <span className="ml-2 rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground">Today</span>}
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-success">{day.hours.reduce((s, h) => s + h.unitsProduced, 0)} units</span>
                  <span className="text-destructive">{day.hours.reduce((s, h) => s + h.defectiveUnits, 0)} defects</span>
                  <span className="text-warning">{Math.round(day.hours.reduce((s, h) => s + (h.runningMinutes || 0), 0) / 60 * 10) / 10}h running</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      </>
      )}

      {selectedHour && (
        <ProductionModal
          key={`${selectedHour.date}-${selectedHour.hour.hour}`}
          open
          onClose={() => setSelectedHour(null)}
          hour={selectedHour.hour}
          date={selectedHour.date}
          machineId={machineId}
          availableOperators={availableOperators}
          availableMolds={availableMolds}
          shifts={shiftsQ.data ?? []}
        />
      )}
    </div>
  );
};

export default ProductionTimeline;
