import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { format, startOfYear, startOfMonth, startOfWeek, startOfDay } from 'date-fns';
import { ArrowLeft, Activity, AlertTriangle, Clock, Gauge, Zap, ZapOff, Edit, Info, Calendar, Check } from 'lucide-react';
import { Machine, MachineStats, MachineStatus } from '../types';
import apiService from '../services/api';
import socketService from '../services/socket';
import { useSocketEvent } from '../hooks/useSocketEvent';
import ProductionTimeline from './ProductionTimeline';
import { Button, Input, Label, Card, CardContent, PageLoader, Spinner } from './ui';
import { cn } from '../lib/cn';

type Period = 'today' | 'week' | 'month' | 'year' | 'custom';
const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'Month to Date' },
  { value: 'year', label: 'Year to Date' },
  { value: 'custom', label: 'Custom Range' },
];
const fmt = (d: Date) => format(d, 'yyyy-MM-dd');
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const statusStyle = (s?: string) =>
  s === 'running' ? 'text-success bg-success/10 border-success/20'
    : s === 'stoppage' ? 'text-destructive bg-destructive/10 border-destructive/20 animate-pulse'
    : s === 'stopped_yet_producing' ? 'text-warning bg-warning/10 border-warning/20'
    : 'text-muted-foreground bg-muted border-border';
const statusIcon = (s?: string) =>
  s === 'running' ? <Zap className="h-4 w-4" /> : s === 'stoppage' ? <AlertTriangle className="h-4 w-4" /> : s === 'stopped_yet_producing' ? <ZapOff className="h-4 w-4" /> : <Activity className="h-4 w-4" />;

const MetricBar: React.FC<{ label: string; value: number; barClass: string; title: string }> = ({ label, value, barClass, title }) => (
  <div className="flex items-center justify-between" title={title}>
    <span className="flex items-center gap-1 text-muted-foreground">{label}<Info className="h-3 w-3" /></span>
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 rounded-full bg-muted"><div className={cn('h-2 rounded-full', barClass)} style={{ width: `${value}%` }} /></div>
      <span className="font-medium text-foreground">{value}%</span>
    </div>
  </div>
);

const MachineView: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
  const ytdRange = () => { const now = new Date(); return { startDate: fmt(startOfYear(now)), endDate: fmt(now) }; };

  const machineQ = useQuery<Machine>({ queryKey: ['machine', id], queryFn: () => apiService.getMachine(id!), enabled: !!id });
  const statsQ = useQuery<MachineStats>({
    queryKey: ['machine-stats', id, selectedPeriod, appliedCustomDates.start, appliedCustomDates.end],
    queryFn: () => apiService.getMachineStats(id!, range()),
    enabled: !!id && (selectedPeriod !== 'custom' || (!!appliedCustomDates.start && !!appliedCustomDates.end)),
  });
  const ytdQ = useQuery<MachineStats>({ queryKey: ['machine-stats-ytd', id], queryFn: () => apiService.getMachineStats(id!, ytdRange()), enabled: !!id });

  const machine = machineQ.data ?? null;
  const stats = statsQ.data ?? null;
  const ytdStats = ytdQ.data ?? null;

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
    queryClient.invalidateQueries({ queryKey: ['machine-stats-ytd', id] });
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
    if (!customStartDate || !customEndDate) return toast.error('Please select both start and end dates');
    if (customStartDate > customEndDate) return toast.error('Start date must be before end date');
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
      toast.success('Machine details updated');
    } catch (err) {
      toast.error(errMsg(err, 'Failed to update machine'));
    }
  };

  const handleAddStoppage = async (stoppage: Record<string, unknown>) => {
    try {
      await apiService.addStoppageRecord({ ...stoppage, machineId: id });
      toast.success('Stoppage recorded successfully');
      refresh();
    } catch (err) {
      toast.error(errMsg(err, 'Failed to record stoppage'));
    }
  };
  const handleUpdateProduction = async (machineId: string, hour: number, date: string, data: Record<string, unknown>) => {
    try {
      await apiService.updateProductionAssignment({ machineId, hour, date, ...data });
      toast.success('Production data updated');
      refresh();
    } catch (err) {
      toast.error(errMsg(err, 'Failed to update production data'));
    }
  };

  if (machineQ.isLoading) return <PageLoader label="Loading machine…" />;
  if (!machine) return <div className="py-12 text-center text-muted-foreground">Machine not found</div>;

  const displayStatus = machineStatus || machine.status;
  const needDates = selectedPeriod === 'custom' && (!appliedCustomDates.start || !appliedCustomDates.end);
  const mtbfDays = ytdStats && ytdStats.mtbf > 0 ? (ytdStats.mtbf / 1440).toFixed(1) : 0;
  const defectRate = stats && stats.totalUnitsProduced > 0 ? ((stats.totalDefectiveUnits / stats.totalUnitsProduced) * 100).toFixed(1) : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-1 items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="Back" onClick={() => navigate(-1)}><ArrowLeft className="h-5 w-5" /></Button>
          {isEditing ? (
            <div className="flex-1 space-y-2">
              <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="text-lg font-bold" />
              <Input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} placeholder="Description" />
            </div>
          ) : (
            <div>
              <h1 className="text-2xl font-bold text-foreground">{machine.name}</h1>
              <p className="text-muted-foreground">{machine.description}</p>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className={cn('flex items-center gap-2 rounded-md border px-3 py-2', statusStyle(displayStatus))}>
            {statusIcon(displayStatus)}
            <span className="font-medium capitalize">{displayStatus.replace(/_/g, ' ')}</span>
          </div>
          {isEditing ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setIsEditing(false)}>Cancel</Button>
              <Button onClick={handleSaveEdit}>Save</Button>
            </div>
          ) : (
            <Button variant="ghost" size="icon" aria-label="Edit machine" onClick={() => setIsEditing(true)}><Edit className="h-5 w-5" /></Button>
          )}
        </div>
      </div>

      {/* YTD key metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card><CardContent className="flex items-center gap-3 p-4" title="Overall Equipment Effectiveness (Year to Date)">
          <Gauge className="h-6 w-6 text-warning" />
          <div><p className="flex items-center gap-1 text-xs text-muted-foreground">OEE (YTD)<Info className="h-3 w-3" /></p><p className="text-lg font-semibold text-warning">{ytdStats?.oee ?? '—'}%</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 p-4" title="Mean Time Between Failures in days (Year to Date)">
          <Clock className="h-6 w-6 text-info" />
          <div><p className="flex items-center gap-1 text-xs text-muted-foreground">MTBF (YTD)<Info className="h-3 w-3" /></p><p className="text-lg font-semibold text-info">{mtbfDays} days</p></div>
        </CardContent></Card>
        <Card><CardContent className="flex items-center gap-3 p-4" title="Mean Time To Repair in minutes (Year to Date)">
          <Activity className="h-6 w-6 text-primary" />
          <div><p className="flex items-center gap-1 text-xs text-muted-foreground">MTTR (YTD)<Info className="h-3 w-3" /></p><p className="text-lg font-semibold text-primary">{ytdStats?.mttr ?? '—'} min</p></div>
        </CardContent></Card>
      </div>

      {/* Period selector */}
      <div className="space-y-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
          <span className="text-sm font-medium text-muted-foreground">View Analytics For:</span>
          <div className="flex flex-wrap gap-2">
            {PERIODS.map((p) => (
              <Button key={p.value} size="sm" variant={selectedPeriod === p.value ? 'primary' : 'outline'} onClick={() => setSelectedPeriod(p.value)}>
                {p.value === 'custom' && <Calendar className="h-4 w-4" />} {p.label}
              </Button>
            ))}
          </div>
        </div>

        {selectedPeriod === 'custom' && (
          <Card className="border-dashed">
            <CardContent className="space-y-4 p-6">
              <div className="flex items-center gap-3"><Calendar className="h-5 w-5 text-primary" /><h3 className="text-lg font-semibold text-foreground">Custom Date Range</h3></div>
              <div className="grid grid-cols-1 items-end gap-4 md:grid-cols-3">
                <div><Label>Start date</Label><Input type="date" value={customStartDate} onChange={(e) => setCustomStartDate(e.target.value)} /></div>
                <div><Label>End date</Label><Input type="date" value={customEndDate} onChange={(e) => setCustomEndDate(e.target.value)} /></div>
                <Button onClick={handleApplyCustomDates} disabled={!customStartDate || !customEndDate} className={cn(hasUnappliedChanges && 'animate-pulse')}>
                  <Check className="h-4 w-4" /> {hasUnappliedChanges ? 'Apply Changes' : 'Applied'}
                </Button>
              </div>
              {customStartDate && customEndDate && (
                <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                  Selected range: <span className="font-medium text-foreground">{new Date(customStartDate).toLocaleDateString()} – {new Date(customEndDate).toLocaleDateString()}</span>
                  {appliedCustomDates.start && (customStartDate === appliedCustomDates.start && customEndDate === appliedCustomDates.end
                    ? <span className="ml-2 text-success">✓ Applied</span>
                    : <span className="ml-2 text-warning">⚠ Click Apply to update</span>)}
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Detailed metrics — header/selector above always stay visible */}
      {statsQ.isLoading ? (
        <div className="py-10 text-center"><Spinner className="mx-auto" /><p className="mt-2 text-muted-foreground">Loading metrics…</p></div>
      ) : needDates ? (
        <div className="rounded-lg border border-dashed border-border py-10 text-center">
          <Calendar className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-muted-foreground">Pick a start and end date above, then click <span className="font-medium text-foreground">Apply</span>.</p>
        </div>
      ) : !stats ? (
        <div className="py-10 text-center text-muted-foreground">No metrics for this period.</div>
      ) : (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card><CardContent className="p-6">
          <h3 className="mb-4 text-lg font-semibold text-foreground">Performance Metrics</h3>
          <div className="space-y-4">
            <MetricBar label="OEE" value={stats.oee} barClass="bg-primary" title="Availability × Performance × Quality" />
            <MetricBar label="Availability" value={stats.availability} barClass="bg-success" title="Percentage of time the machine was available for production" />
            <MetricBar label="Performance" value={stats.performance} barClass="bg-warning" title="Actual production rate vs. maximum possible rate" />
            <MetricBar label="Quality" value={stats.quality} barClass="bg-info" title="Percentage of units meeting quality standards" />
          </div>
        </CardContent></Card>

        <Card><CardContent className="p-6">
          <h3 className="mb-4 text-lg font-semibold text-foreground">Quality Metrics</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between" title="Units that passed quality inspection">
              <span className="flex items-center gap-1 text-muted-foreground">Good Units<Info className="h-3 w-3" /></span>
              <span className="font-medium text-success">{stats.totalUnitsProduced - stats.totalDefectiveUnits}</span>
            </div>
            <div className="flex items-center justify-between" title="Units that failed quality inspection">
              <span className="flex items-center gap-1 text-muted-foreground">Defective Units<Info className="h-3 w-3" /></span>
              <span className="font-medium text-destructive">{stats.totalDefectiveUnits}</span>
            </div>
            <div className="flex items-center justify-between" title="Percentage of units that were defective">
              <span className="flex items-center gap-1 text-muted-foreground">Defect Rate<Info className="h-3 w-3" /></span>
              <span className="font-medium text-warning">{defectRate}%</span>
            </div>
          </div>
        </CardContent></Card>

        <Card><CardContent className="p-6">
          <h3 className="mb-4 text-lg font-semibold text-foreground">Reliability</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between" title="Current operational status of the machine">
              <span className="flex items-center gap-1 text-muted-foreground">Current Status<Info className="h-3 w-3" /></span>
              <span className={cn('font-medium capitalize', statusStyle(machine.status).split(' ')[0])}>{machine.status.replace(/_/g, ' ')}</span>
            </div>
            <div className="flex items-center justify-between" title="Mean Time Between Failures (selected period)">
              <span className="flex items-center gap-1 text-muted-foreground">MTBF<Info className="h-3 w-3" /></span>
              <span className="font-medium text-info">{stats.mtbf > 0 ? (stats.mtbf / 1440).toFixed(1) : 0} days</span>
            </div>
            <div className="flex items-center justify-between" title="Mean Time To Repair (selected period)">
              <span className="flex items-center gap-1 text-muted-foreground">MTTR<Info className="h-3 w-3" /></span>
              <span className="font-medium text-primary">{stats.mttr} minutes</span>
            </div>
            <div className="flex items-center justify-between" title="Total running time in the selected period">
              <span className="flex items-center gap-1 text-muted-foreground">Running Time<Info className="h-3 w-3" /></span>
              <span className="font-medium text-success">{Math.round((stats.totalRunningMinutes || 0) / 60 * 10) / 10}h</span>
            </div>
          </div>
        </CardContent></Card>
      </div>
      )}

      {/* Production timeline */}
      <Card>
        <div className="border-b border-border p-6">
          <h2 className="text-lg font-semibold text-foreground">Real-time Production Timeline</h2>
          <p className="mt-1 text-sm text-muted-foreground">Live production data with operator and mold information</p>
        </div>
        <div className="p-6">
          <ProductionTimeline machineId={id!} onAddStoppage={handleAddStoppage} onUpdateProduction={handleUpdateProduction} />
        </div>
      </Card>
    </div>
  );
};

export default MachineView;
