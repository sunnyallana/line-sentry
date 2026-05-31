import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowLeft, Settings, Activity, Plus, Edit, Power, Gauge, Trash2, Save, Wrench } from 'lucide-react';
import { Department, Machine, MachineStats, MachineStatus } from '../types';
import apiService from '../services/api';
import { useAuth } from '../context/auth-context';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { Button, Input, Label, Card, CardContent, Modal, PageLoader } from './ui';
import { cn } from '../lib/cn';

const DEFAULT_W = 154;
const DEFAULT_H = 152;
const GRID = 8; // snap-to-grid step (px) for the layout editor
const toSnakeCase = (str: string) => str.toLowerCase().replace(/\s+/g, '_');
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const statusDot = (s?: string) =>
  s === 'running' ? 'bg-success' : s === 'stoppage' ? 'bg-destructive animate-pulse' : s === 'stopped_yet_producing' ? 'bg-warning' : 'bg-muted-foreground';
const statusTextClass = (s?: string) =>
  s === 'running' ? 'text-success' : s === 'stoppage' ? 'text-destructive' : s === 'stopped_yet_producing' ? 'text-warning' : 'text-muted-foreground';
const statusLabel = (s?: string) =>
  s === 'running' ? 'Running' : s === 'stoppage' ? 'Stoppage' : s === 'stopped_yet_producing' ? 'Stopped Yet Producing' : s === 'inactive' ? 'Inactive' : (s ?? '');

const ytdRange = () => {
  const now = new Date();
  return { startDate: new Date(now.getFullYear(), 0, 1).toISOString(), endDate: now.toISOString() };
};

const StatCard: React.FC<{ label: string; value: React.ReactNode; icon: React.ReactNode; valueClass?: string }> = ({ label, value, icon, valueClass }) => (
  <Card>
    <CardContent className="flex items-center justify-between p-4">
      <div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={cn('text-xl font-semibold text-foreground', valueClass)}>{value}</p>
      </div>
      {icon}
    </CardContent>
  </Card>
);

const DepartmentView: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();

  const [machines, setMachines] = useState<Machine[]>([]);
  const [isAddingMachine, setIsAddingMachine] = useState(false);
  const [newMachine, setNewMachine] = useState({ name: '', description: '' });
  const [editLayoutMode, setEditLayoutMode] = useState(false);
  const [positions, setPositions] = useState<{ [key: string]: { x: number; y: number } }>({});
  const [dimensions, setDimensions] = useState<{ [key: string]: { width: number; height: number } }>({});
  const [draggingMachineId, setDraggingMachineId] = useState<string | null>(null);
  const [resizingMachineId, setResizingMachineId] = useState<string | null>(null);
  const [machineStatuses, setMachineStatuses] = useState<{ [key: string]: string }>({});
  const [machineStats, setMachineStats] = useState<{ [machineId: string]: MachineStats }>({});
  const [bgImageExists, setBgImageExists] = useState(false);
  const layoutContainerRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizeInitial = useRef({ width: 0, height: 0, x: 0, y: 0 });

  const departmentQ = useQuery<Department>({
    queryKey: ['department', id],
    queryFn: () => apiService.getDepartment(id!),
    enabled: !!id,
  });
  const department = departmentQ.data ?? null;

  // Per-machine setup readiness (so we can flag machines that aren't wired yet).
  const setupQ = useQuery<{ machineId: string; ready: boolean }[]>({
    queryKey: ['setup-status'],
    queryFn: () => apiService.getSetupStatus(),
    enabled: isAdmin,
  });
  const readyMap = new Map((setupQ.data ?? []).map((s) => [s.machineId, s.ready]));

  // Seed editable layout state from the fetched department
  useEffect(() => {
    if (!departmentQ.data) return;
    const m = departmentQ.data.machines || [];
    setMachines(m);
    const pos: typeof positions = {};
    const dim: typeof dimensions = {};
    m.forEach((machine) => {
      pos[machine._id] = { ...machine.position };
      dim[machine._id] = { width: machine.dimensions?.width || DEFAULT_W, height: machine.dimensions?.height || DEFAULT_H };
    });
    setPositions(pos);
    setDimensions(dim);
  }, [departmentQ.data]);

  // Per-department background image (optional)
  useEffect(() => {
    if (!department) return;
    const img = new Image();
    img.src = `/${toSnakeCase(department.name)}.png`;
    img.onload = () => setBgImageExists(true);
    img.onerror = () => setBgImageExists(false);
  }, [department]);

  const fetchMachineStatsForMachine = async (machineId: string) => {
    try {
      const stats = await apiService.getMachineStats(machineId, ytdRange());
      setMachineStats((prev) => ({ ...prev, [machineId]: stats }));
    } catch (error) {
      console.error(`Failed to fetch YTD stats for machine ${machineId}:`, error);
    }
  };

  // Fetch YTD stats for all machines whenever the machine set changes
  useEffect(() => {
    if (machines.length === 0) return;
    const range = ytdRange();
    Promise.all(
      machines.map((m) =>
        apiService.getMachineStats(m._id, range).then((s) => ({ id: m._id, s })).catch(() => null)),
    ).then((results) => {
      const next: { [id: string]: MachineStats } = {};
      results.forEach((r) => { if (r) next[r.id] = r.s; });
      setMachineStats(next);
    });
  }, [machines]);

  // Real-time updates (leak-free subscriptions)
  useSocketEvent('machine-state-update', (update) => {
    setMachineStatuses((prev) => ({ ...prev, [update.machineId]: update.status }));
    setMachines((prev) => prev.map((m) => (m._id === update.machineId ? { ...m, status: update.dbStatus as MachineStatus } : m)));
  });
  useSocketEvent('production-update', (u) => fetchMachineStatsForMachine(u.machineId));
  useSocketEvent('stoppage-added', (u) => fetchMachineStatsForMachine(u.machineId));
  useSocketEvent('unclassified-stoppage-detected', (u) => fetchMachineStatsForMachine(u.machineId));

  const departmentStats = useMemo(() => {
    let totalUnits = 0, totalOEE = 0, running = 0, stopped = 0, withStats = 0;
    machines.forEach((machine) => {
      if (machine.status === 'running') running++; else stopped++;
      const s = machineStats[machine._id];
      if (s) { totalUnits += s.totalUnitsProduced || 0; totalOEE += s.oee || 0; withStats++; }
    });
    return { totalUnits, avgOEE: withStats > 0 ? Math.round(totalOEE / withStats) : 0, running, stopped };
  }, [machines, machineStats]);

  const liveStatus = (m: Machine) => (machineStatuses[m._id] as MachineStatus) || (m.status as MachineStatus);

  const handleMachineClick = (machineId: string) => {
    if (!editLayoutMode) navigate(`/machine/${machineId}`);
  };

  const handleAddMachine = async () => {
    try {
      const created = await apiService.createMachine({ ...newMachine, departmentId: id });
      setMachines([...machines, created]);
      setPositions({ ...positions, [created._id]: created.position });
      setDimensions({ ...dimensions, [created._id]: { width: created.dimensions?.width || DEFAULT_W, height: created.dimensions?.height || DEFAULT_H } });
      setIsAddingMachine(false);
      setNewMachine({ name: '', description: '' });
      toast.success('Machine added successfully');
    } catch (err) {
      toast.error(errMsg(err, 'Failed to add machine'));
    }
  };

  const handleDeleteMachine = async (machineId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Permanently delete this machine? All associated data will be lost.')) return;
    try {
      await apiService.deleteMachine(machineId);
      setMachines(machines.filter((m) => m._id !== machineId));
      const p = { ...positions }; delete p[machineId]; setPositions(p);
      const d = { ...dimensions }; delete d[machineId]; setDimensions(d);
      if (draggingMachineId === machineId) setDraggingMachineId(null);
      if (resizingMachineId === machineId) setResizingMachineId(null);
      toast.success('Machine deleted successfully');
    } catch (err) {
      toast.error(errMsg(err, 'Failed to delete machine'));
    }
  };

  const handleMouseDown = (machineId: string, e: React.MouseEvent) => {
    if (!editLayoutMode || !layoutContainerRef.current) return;
    e.stopPropagation();
    const rect = layoutContainerRef.current.getBoundingClientRect();
    dragOffset.current = {
      x: e.clientX - rect.left - (positions[machineId]?.x || 0),
      y: e.clientY - rect.top - (positions[machineId]?.y || 0),
    };
    setDraggingMachineId(machineId);
  };

  const handleResizeMouseDown = (machineId: string, e: React.MouseEvent) => {
    if (!editLayoutMode || !layoutContainerRef.current) return;
    e.stopPropagation();
    setResizingMachineId(machineId);
    resizeInitial.current = {
      width: dimensions[machineId]?.width || DEFAULT_W,
      height: dimensions[machineId]?.height || DEFAULT_H,
      x: e.clientX, y: e.clientY,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!editLayoutMode || !layoutContainerRef.current) return;
    if (draggingMachineId) {
      const rect = layoutContainerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left - dragOffset.current.x;
      const y = e.clientY - rect.top - dragOffset.current.y;
      const snap = (n: number) => Math.round(n / GRID) * GRID;
      const boundedX = snap(Math.max(10, Math.min(x, rect.width - (dimensions[draggingMachineId]?.width || DEFAULT_W))));
      const boundedY = snap(Math.max(10, Math.min(y, rect.height - (dimensions[draggingMachineId]?.height || DEFAULT_H))));
      setPositions((prev) => ({ ...prev, [draggingMachineId]: { x: boundedX, y: boundedY } }));
    }
    if (resizingMachineId) {
      const deltaX = e.clientX - resizeInitial.current.x;
      const deltaY = e.clientY - resizeInitial.current.y;
      setDimensions((prev) => ({
        ...prev,
        [resizingMachineId]: {
          width: Math.max(50, resizeInitial.current.width + deltaX),
          height: Math.max(50, resizeInitial.current.height + deltaY),
        },
      }));
    }
  };

  const persistLayout = async (machineId: string, successMsg: string) => {
    if (!machines.some((m) => m._id === machineId)) return;
    try {
      await apiService.updateMachinePosition(machineId, positions[machineId], dimensions[machineId]);
      toast.success(successMsg);
    } catch (err) {
      toast.error(errMsg(err, 'Failed to update layout'));
    }
  };

  const handleMouseUp = async () => {
    if (!editLayoutMode) return;
    if (draggingMachineId) { await persistLayout(draggingMachineId, 'Machine position updated'); setDraggingMachineId(null); }
    if (resizingMachineId) { await persistLayout(resizingMachineId, 'Machine size updated'); setResizingMachineId(null); }
  };

  const handleSaveLayout = async () => {
    try {
      const ids = Object.keys(positions).filter((mid) => machines.some((m) => m._id === mid));
      await Promise.all(ids.map((mid) => apiService.updateMachinePosition(mid, positions[mid], dimensions[mid])));
      setEditLayoutMode(false);
      toast.success('Layout saved successfully');
    } catch (err) {
      toast.error(errMsg(err, 'Failed to save layout'));
    }
  };

  if (departmentQ.isLoading) return <PageLoader label="Loading department…" />;
  if (!department) return <div className="py-12 text-center text-muted-foreground">Department not found</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="Back to dashboard" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{department.name}</h1>
            <p className="text-muted-foreground">{department.description}</p>
          </div>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Button onClick={() => setIsAddingMachine(true)}><Plus className="h-4 w-4" /> Add Machine</Button>
            <Button variant="ghost" size="icon" aria-label={editLayoutMode ? 'Save layout' : 'Edit layout'} onClick={() => (editLayoutMode ? handleSaveLayout() : setEditLayoutMode(true))}>
              {editLayoutMode ? <Save className="h-5 w-5" /> : <Settings className="h-5 w-5" />}
            </Button>
          </div>
        )}
      </div>

      {/* Department stats */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <StatCard label="Total Machines" value={machines.length} icon={<Activity className="h-8 w-8 text-primary" />} />
        <StatCard label="Running" value={departmentStats.running} valueClass="text-success" icon={<Power className="h-8 w-8 text-success" />} />
        <StatCard label="Stopped" value={departmentStats.stopped} valueClass="text-destructive" icon={<Activity className="h-8 w-8 text-destructive" />} />
        <StatCard label="Department OEE (YTD)" value={`${departmentStats.avgOEE}%`} valueClass="text-warning" icon={<Gauge className="h-8 w-8 text-warning" />} />
      </div>

      {/* Machine layout */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-6">
          <div className="flex flex-wrap items-center gap-4">
            <h2 className="text-lg font-semibold text-foreground">Machine Layout</h2>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success" /> Running</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-destructive" /> Stoppage</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warning" /> Stopped/producing</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-muted-foreground" /> Inactive</span>
            </div>
          </div>
          {isAdmin && (
            <button
              onClick={() => (editLayoutMode ? handleSaveLayout() : setEditLayoutMode(true))}
              className="flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <Edit className="h-4 w-4" /> {editLayoutMode ? 'Save Layout' : 'Edit Layout'}
            </button>
          )}
        </div>

        <div className="p-6">
          {machines.length > 0 ? (
            <div
              ref={layoutContainerRef}
              className="relative min-h-[700px] w-full rounded-lg border border-dashed border-border bg-muted/40"
              style={bgImageExists ? { backgroundImage: `url(/${toSnakeCase(department.name)}.png)`, backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' } : {}}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              {machines.map((machine) => {
                const width = dimensions[machine._id]?.width || DEFAULT_W;
                const height = dimensions[machine._id]?.height || DEFAULT_H;
                const isSmall = width < 100 || height < 100;
                const active = draggingMachineId === machine._id || resizingMachineId === machine._id;
                const status = liveStatus(machine);
                return (
                  <div
                    key={machine._id}
                    onClick={() => handleMachineClick(machine._id)}
                    onMouseDown={(e) => handleMouseDown(machine._id, e)}
                    className={cn(
                      'absolute flex flex-col rounded-lg border bg-card transition-all duration-200',
                      editLayoutMode ? 'cursor-move border-primary' : 'border-border hover:border-primary hover:shadow-md',
                    )}
                    style={{
                      left: `${positions[machine._id]?.x || 0}px`,
                      top: `${positions[machine._id]?.y || 0}px`,
                      width: `${width}px`,
                      height: `${height}px`,
                      zIndex: active ? 10 : 1,
                      transform: active ? 'scale(1.02)' : 'none',
                      transition: active ? 'none' : 'all 0.2s ease',
                      padding: isSmall ? '0.25rem' : '0.75rem',
                    }}
                  >
                    <div className="flex w-full items-center justify-between">
                      <h3 className="truncate font-medium text-foreground" style={{ fontSize: isSmall ? '0.65rem' : '0.875rem', maxWidth: isSmall ? `${width - 30}px` : '100%' }}>
                        {machine.name}
                      </h3>
                      <div className="flex items-center gap-1">
                        {isAdmin && readyMap.get(machine._id) === false && !isSmall && (
                          <span title="Setup incomplete — wire this machine's signals"><Wrench className="h-3 w-3 text-warning" /></span>
                        )}
                        <div className={cn('rounded-full', statusDot(status))} style={{ width: isSmall ? '0.5rem' : '0.75rem', height: isSmall ? '0.5rem' : '0.75rem', minWidth: isSmall ? '0.5rem' : '0.75rem' }} />
                        {editLayoutMode && !isSmall && (
                          <button onClick={(e) => handleDeleteMachine(machine._id, e)} className="rounded-md p-1 text-destructive hover:bg-muted">
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="mt-1 w-full">
                      <span className="block truncate text-muted-foreground" style={{ fontSize: isSmall ? '0.65rem' : '0.75rem' }}>
                        {machine.description || 'No description'}
                      </span>
                    </div>

                    <div className="mt-1 w-full">
                      <span className={cn('font-medium', statusTextClass(status))} style={{ fontSize: isSmall ? '0.65rem' : '0.75rem' }}>
                        {statusLabel(status)}
                      </span>
                    </div>

                    {!isSmall && (
                      <div className="mt-auto space-y-1">
                        <div className="flex w-full items-center justify-between" style={{ fontSize: '0.7rem' }}>
                          <span className="text-muted-foreground">OEE (YTD)</span>
                          <span className="font-medium text-foreground">{machineStats[machine._id]?.oee ?? 'N/A'}%</span>
                        </div>
                        <div className="flex w-full items-center justify-between" style={{ fontSize: '0.7rem' }}>
                          <span className="text-muted-foreground">Units</span>
                          <span className="font-medium text-foreground">{machineStats[machine._id]?.totalUnitsProduced ?? 'N/A'}</span>
                        </div>
                      </div>
                    )}

                    {editLayoutMode && (
                      <div className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize text-foreground" onMouseDown={(e) => handleResizeMouseDown(machine._id, e)}>
                        <div className="h-full w-full" style={{ borderBottom: '2px solid currentColor', borderRight: '2px solid currentColor', borderBottomRightRadius: '0.25rem' }} />
                      </div>
                    )}
                    {editLayoutMode && isSmall && (
                      <button onClick={(e) => handleDeleteMachine(machine._id, e)} className="absolute right-0 top-0 rounded-md p-1 text-destructive hover:bg-muted" style={{ zIndex: 20 }}>
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-12 text-center">
              <Activity className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
              <h3 className="mb-2 text-lg font-medium text-foreground">No machines found</h3>
              <p className="mb-4 text-muted-foreground">This department doesn't have any machines configured yet.</p>
              {isAdmin && <Button onClick={() => setIsAddingMachine(true)}><Plus className="h-4 w-4" /> Add First Machine</Button>}
            </div>
          )}
        </div>
      </Card>

      {/* Edit layout controls */}
      {editLayoutMode && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="flex items-center gap-2 text-sm text-warning">
              <Edit className="h-4 w-4" />
              Layout Edit Mode: drag to reposition, resize with the bottom-right handle, or delete with the trash icon.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditLayoutMode(false)}>Cancel</Button>
              <Button onClick={handleSaveLayout}><Save className="h-4 w-4" /> Save Layout</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Add machine modal */}
      <Modal
        open={isAddingMachine}
        onClose={() => setIsAddingMachine(false)}
        title="Add new machine"
        footer={
          <>
            <Button variant="outline" onClick={() => setIsAddingMachine(false)}>Cancel</Button>
            <Button onClick={handleAddMachine} disabled={!newMachine.name.trim()}>Add Machine</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="machine-name">Machine name *</Label>
            <Input id="machine-name" value={newMachine.name} onChange={(e) => setNewMachine({ ...newMachine, name: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="machine-desc">Description</Label>
            <textarea
              id="machine-desc"
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={newMachine.description}
              onChange={(e) => setNewMachine({ ...newMachine, description: e.target.value })}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default DepartmentView;
