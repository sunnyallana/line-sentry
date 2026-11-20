import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { LayoutGrid, List, Move, Plus, Trash2, Wrench } from 'lucide-react';
import { Department, Machine, MachineStats, MachineStatus } from '../types';
import apiService from '../services/api';
import { useAuth } from '../context/auth-context';
import { useSocketEvent } from '../hooks/useSocketEvent';
import {
  Button, EmptyState, Field, IconButton, Input, Modal, PageHeader, PageLoader, Section, Segmented, Stat, StatStrip,
  StatusDot, formatNumber, machineStatusLabel,
} from './ui';
import { cn } from '../lib/cn';

const DEFAULT_W = 154;
const DEFAULT_H = 152;
const GRID = 8; // snap-to-grid step (px) for the layout editor
const toSnakeCase = (str: string) => str.toLowerCase().replace(/\s+/g, '_');
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/* The edge of a machine tile carries its state, so the floor reads at a glance. */
const statusEdge = (s?: string) =>
  s === 'running' ? 'bg-success' : s === 'stoppage' ? 'bg-destructive' : s === 'stopped_yet_producing' ? 'bg-warning' : 'bg-muted-foreground/40';

const ytdRange = () => {
  const now = new Date();
  return { startDate: new Date(now.getFullYear(), 0, 1).toISOString(), endDate: now.toISOString() };
};

type ViewMode = 'floor' | 'list';
const VIEW_KEY = 'department-view';
const savedView = (): ViewMode => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'floor';
  } catch {
    return 'floor';
  }
};

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
  const [view, setViewState] = useState<ViewMode>(savedView);
  const setView = (next: ViewMode) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* the choice just won't be remembered */
    }
  };
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
      if (machine.status === 'running') running++; else if (machine.status === 'stoppage') stopped++;
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
      toast.success(`${created.name} added. Wire its signals in Setup to start collecting data.`);
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
  if (!department) {
    return (
      <EmptyState
        title="Department not found"
        description="It may have been removed."
        action={<Button variant="outline" onClick={() => navigate('/dashboard')}>Back to overview</Button>}
      />
    );
  }

  const cancelLayoutEdit = () => {
    // Put the tiles back where the server has them.
    const pos: typeof positions = {};
    const dim: typeof dimensions = {};
    machines.forEach((m) => {
      pos[m._id] = { ...m.position };
      dim[m._id] = { width: m.dimensions?.width || DEFAULT_W, height: m.dimensions?.height || DEFAULT_H };
    });
    setPositions(pos);
    setDimensions(dim);
    setEditLayoutMode(false);
    departmentQ.refetch();
  };

  const idle = machines.length - departmentStats.running - departmentStats.stopped;
  const oeeOf = (m: Machine) => machineStats[m._id]?.oee;
  const unitsOf = (m: Machine) => machineStats[m._id]?.totalUnitsProduced;

  return (
    <div className="space-y-6">
      <PageHeader
        title={department.name}
        description={department.description}
        onBack={() => navigate('/dashboard')}
        backLabel="Back to overview"
        actions={
          isAdmin && !editLayoutMode ? (
            <>
              {view === 'floor' && machines.length > 0 && (
                <Button variant="outline" onClick={() => setEditLayoutMode(true)}>
                  <Move className="h-4 w-4" /> Arrange floor plan
                </Button>
              )}
              <Button onClick={() => setIsAddingMachine(true)}><Plus className="h-4 w-4" /> Add machine</Button>
            </>
          ) : undefined
        }
      />

      <StatStrip>
        <Stat label="Running now" value={departmentStats.running} unit={`of ${machines.length}`} hint={`${idle} idle`} />
        <Stat label="Stopped" value={departmentStats.stopped} tone={departmentStats.stopped > 0 ? 'bad' : 'neutral'} />
        <Stat label="OEE" value={departmentStats.avgOEE} unit="%" hint="Year to date" />
        <Stat label="Units" value={formatNumber(departmentStats.totalUnits)} hint="Year to date" />
      </StatStrip>

      <Section
        flush
        title="Machines"
        actions={
          editLayoutMode ? (
            <>
              <span className="mr-1 hidden text-[13px] text-muted-foreground md:inline">
                Drag a machine to move it. Drag its corner to resize.
              </span>
              <Button variant="outline" size="sm" onClick={cancelLayoutEdit}>Cancel</Button>
              <Button size="sm" onClick={handleSaveLayout}>Save floor plan</Button>
            </>
          ) : (
            <Segmented<ViewMode>
              ariaLabel="How to show machines"
              value={view}
              onChange={setView}
              options={[
                { value: 'floor', label: <><LayoutGrid className="h-3.5 w-3.5" /> Floor plan</> },
                { value: 'list', label: <><List className="h-3.5 w-3.5" /> List</> },
              ]}
            />
          )
        }
      >
        {machines.length === 0 ? (
          <EmptyState
            title="No machines in this department"
            description={isAdmin ? 'Add the first machine, then wire its signals in Setup.' : 'An administrator has not added machines here yet.'}
            action={isAdmin ? <Button onClick={() => setIsAddingMachine(true)}><Plus className="h-4 w-4" /> Add machine</Button> : undefined}
          />
        ) : view === 'list' && !editLayoutMode ? (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-5 py-2 font-medium">Machine</th>
                  <th scope="col" className="px-5 py-2 font-medium">State</th>
                  <th scope="col" className="px-5 py-2 text-right font-medium">OEE (year to date)</th>
                  <th scope="col" className="px-5 py-2 text-right font-medium">Units (year to date)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {machines.map((machine) => (
                  <tr
                    key={machine._id}
                    tabIndex={0}
                    role="link"
                    onClick={() => navigate(`/machine/${machine._id}`)}
                    onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/machine/${machine._id}`); }}
                    className="cursor-pointer transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:ring-inset"
                  >
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{machine.name}</span>
                        {isAdmin && readyMap.get(machine._id) === false && (
                          <span className="inline-flex items-center gap-1 text-xs text-warning" title="Signals are not wired yet. Finish this machine in Setup.">
                            <Wrench className="h-3 w-3" /> Setup needed
                          </span>
                        )}
                      </div>
                      {machine.description && <p className="text-xs text-muted-foreground">{machine.description}</p>}
                    </td>
                    <td className="px-5 py-2.5"><StatusDot status={liveStatus(machine)} /></td>
                    <td className="px-5 py-2.5 text-right">{oeeOf(machine) != null ? `${oeeOf(machine)}%` : '–'}</td>
                    <td className="px-5 py-2.5 text-right">{formatNumber(unitsOf(machine))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
              {(['running', 'stoppage', 'stopped_yet_producing', 'inactive'] as const).map((s) => (
                <StatusDot key={s} status={s} className="text-xs text-muted-foreground" />
              ))}
            </div>
            <div
              ref={layoutContainerRef}
              className={cn(
                'scrollbar-thin relative min-h-[640px] w-full overflow-auto rounded-md bg-muted/40',
                editLayoutMode && 'bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:16px_16px]',
              )}
              style={bgImageExists ? { backgroundImage: `url(/${toSnakeCase(department.name)}.png)`, backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' } : {}}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              {machines.map((machine) => {
                const width = dimensions[machine._id]?.width || DEFAULT_W;
                const height = dimensions[machine._id]?.height || DEFAULT_H;
                const isSmall = width < 110 || height < 96;
                const active = draggingMachineId === machine._id || resizingMachineId === machine._id;
                const status = liveStatus(machine);
                const needsSetup = isAdmin && readyMap.get(machine._id) === false;
                return (
                  <div
                    key={machine._id}
                    role={editLayoutMode ? undefined : 'link'}
                    tabIndex={editLayoutMode ? undefined : 0}
                    aria-label={`${machine.name}, ${machineStatusLabel(status)}`}
                    title={isSmall ? `${machine.name} · ${machineStatusLabel(status)}` : undefined}
                    onClick={() => handleMachineClick(machine._id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleMachineClick(machine._id); }}
                    onMouseDown={(e) => handleMouseDown(machine._id, e)}
                    className={cn(
                      'absolute flex overflow-hidden rounded-md border bg-card',
                      editLayoutMode
                        ? 'cursor-move border-primary/60'
                        : 'cursor-pointer border-border hover:border-foreground/30 hover:shadow-md',
                      active ? 'z-10 shadow-md' : 'z-[1] transition-[box-shadow,border-color] duration-150',
                    )}
                    style={{
                      left: `${positions[machine._id]?.x || 0}px`,
                      top: `${positions[machine._id]?.y || 0}px`,
                      width: `${width}px`,
                      height: `${height}px`,
                    }}
                  >
                    <span className={cn('w-1 shrink-0', statusEdge(status))} aria-hidden />
                    <div className={cn('flex min-w-0 flex-1 flex-col', isSmall ? 'p-1.5' : 'p-3')}>
                      <div className="flex items-start justify-between gap-1">
                        <h3 className={cn('truncate font-medium text-foreground', isSmall ? 'text-[11px]' : 'text-[13px]')}>{machine.name}</h3>
                        {needsSetup && !isSmall && (
                          <span title="Signals are not wired yet. Finish this machine in Setup."><Wrench className="h-3.5 w-3.5 text-warning" /></span>
                        )}
                      </div>
                      <p className={cn('truncate text-muted-foreground', isSmall ? 'text-[10px]' : 'text-xs')}>{machineStatusLabel(status)}</p>

                      {!isSmall && (
                        <dl className="mt-auto grid grid-cols-2 gap-2 pt-2">
                          <div>
                            <dt className="text-[11px] text-muted-foreground">OEE</dt>
                            <dd className="text-sm font-semibold text-foreground">{oeeOf(machine) != null ? `${oeeOf(machine)}%` : '–'}</dd>
                          </div>
                          <div>
                            <dt className="text-[11px] text-muted-foreground">Units</dt>
                            <dd className="text-sm font-semibold text-foreground">{formatNumber(unitsOf(machine))}</dd>
                          </div>
                        </dl>
                      )}
                    </div>

                    {editLayoutMode && (
                      <>
                        <IconButton
                          label={`Delete ${machine.name}`}
                          danger
                          className="absolute right-0.5 top-0.5 h-6 w-6 bg-card"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => handleDeleteMachine(machine._id, e)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconButton>
                        <div
                          className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
                          onMouseDown={(e) => handleResizeMouseDown(machine._id, e)}
                          aria-hidden
                        >
                          <div className="absolute bottom-1 right-1 h-2 w-2 border-b-2 border-r-2 border-muted-foreground" />
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Section>

      <Modal
        open={isAddingMachine}
        onClose={() => setIsAddingMachine(false)}
        title="Add machine"
        description={`It will be added to ${department.name}.`}
        footer={
          <>
            <Button variant="outline" onClick={() => setIsAddingMachine(false)}>Cancel</Button>
            <Button onClick={handleAddMachine} disabled={!newMachine.name.trim()}>Add machine</Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); if (newMachine.name.trim()) handleAddMachine(); }}
        >
          <Field label="Name">
            <Input value={newMachine.name} placeholder="e.g. Injection press 4" onChange={(e) => setNewMachine({ ...newMachine, name: e.target.value })} />
          </Field>
          <Field label="Description" hint="Optional. Shown under the name.">
            <Input value={newMachine.description} onChange={(e) => setNewMachine({ ...newMachine, description: e.target.value })} />
          </Field>
        </form>
      </Modal>
    </div>
  );
};

export default DepartmentView;
