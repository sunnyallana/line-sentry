import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  CheckCircle2, Circle, Zap, Activity, Plus, Trash2, ChevronDown, ChevronRight,
  Package, ArrowRight, Cpu, Server,
} from 'lucide-react';
import apiService from '../services/api';
import { Button, Input, Label, Select, Card, CardContent, CardHeader, CardTitle, Badge, PageLoader, EmptyState, Spinner } from './ui';
import { cn } from '../lib/cn';

interface SetupMachine {
  machineId: string;
  name: string;
  status: string;
  departmentId: string;
  departmentName: string;
  powerMapped: boolean;
  cycleMapped: boolean;
  departmentHasMold: boolean;
  ready: boolean;
}
interface Signal { sensorId: string; name: string; role: string; plcId: string | null; pinId: string | null }
interface PinMapping { _id: string; plcId?: string; pinId: string }
interface Plc { _id: string; plcId: string; name: string; ip?: string; rack: number; slot: number; byteCount: number }

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** All Siemens byte.bit pin addresses a PLC exposes given its byte count. */
const pinsForPlc = (byteCount: number): string[] => {
  const out: string[] = [];
  for (let b = 0; b < Math.max(1, byteCount); b++) for (let i = 0; i < 8; i++) out.push(`Q${b}.${i}`);
  return out;
};

/* --------------------------------------------------------------- PLC registry */

const PlcRegistry: React.FC = () => {
  const queryClient = useQueryClient();
  const plcsQ = useQuery<Plc[]>({ queryKey: ['plcs'], queryFn: () => apiService.getPlcs() });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ plcId: '', name: '', ip: '', rack: 0, slot: 1, byteCount: 2 });

  const invalidate = () => { queryClient.invalidateQueries({ queryKey: ['plcs'] }); queryClient.invalidateQueries({ queryKey: ['pin-mappings'] }); };
  const addMut = useMutation({
    mutationFn: () => apiService.createPlc({ ...form, plcId: form.plcId.trim() }),
    onSuccess: () => { toast.success('PLC added'); setForm({ plcId: '', name: '', ip: '', rack: 0, slot: 1, byteCount: 2 }); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Could not add PLC')),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => apiService.deletePlc(id),
    onSuccess: () => { toast.success('PLC removed'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Could not remove PLC')),
  });

  const plcs = plcsQ.data ?? [];

  return (
    <Card>
      <CardHeader className="cursor-pointer" onClick={() => setOpen((o) => !o)}>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2"><Server className="h-5 w-5 text-primary" /> PLCs <span className="text-sm font-normal text-muted-foreground">({plcs.length})</span></span>
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Each PLC exposes <span className="text-foreground">8 × bytes</span> output pins (Q0.0…). Add one entry per device, or a single
            entry with more bytes for a head/gateway PLC that aggregates others.
          </p>

          <div className="divide-y divide-border rounded-md border border-border">
            {plcs.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">No PLCs yet.</p>
            ) : plcs.map((p) => (
              <div key={p._id} className="flex items-center justify-between px-4 py-2">
                <div className="flex items-center gap-3">
                  <Badge variant="outline">{p.plcId}</Badge>
                  <span className="text-foreground">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{p.ip ? `${p.ip} · ` : ''}{p.byteCount * 8} pins</span>
                </div>
                <Button variant="ghost" size="icon" aria-label="Remove PLC" onClick={() => delMut.mutate(p._id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 items-end gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-6">
            <div><Label>PLC id</Label><Input placeholder="line-1" value={form.plcId} onChange={(e) => setForm({ ...form, plcId: e.target.value })} /></div>
            <div className="sm:col-span-2"><Label>Name</Label><Input placeholder="Injection line 1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><Label>IP</Label><Input placeholder="192.168.0.1" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} /></div>
            <div><Label>Bytes</Label><Input type="number" min={1} value={form.byteCount} onChange={(e) => setForm({ ...form, byteCount: parseInt(e.target.value) || 1 })} /></div>
            <Button disabled={!form.plcId.trim() || !form.name.trim()} loading={addMut.isPending} onClick={() => addMut.mutate()}><Plus className="h-4 w-4" /> Add</Button>
          </div>
          <p className="text-xs text-muted-foreground">Run one daemon per PLC with <code className="rounded bg-muted px-1">PLC_ID</code> set to its id and <code className="rounded bg-muted px-1">BYTE_COUNT</code> matching the bytes above.</p>
        </CardContent>
      )}
    </Card>
  );
};

/* ----------------------------------------------------------- per-machine card */

const MachineSetupCard: React.FC<{ machine: SetupMachine; plcs: Plc[] }> = ({ machine, plcs }) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(!machine.ready);
  const [form, setForm] = useState({ plcId: plcs[0]?.plcId ?? '', role: 'power', pinId: '' });

  const signalsQ = useQuery<Signal[]>({
    queryKey: ['machine-signals', machine.machineId],
    queryFn: () => apiService.getMachineSignals(machine.machineId),
    enabled: open,
  });
  const pinsQ = useQuery<PinMapping[]>({ queryKey: ['pin-mappings'], queryFn: () => apiService.getPinMappings(), enabled: open });

  const selectedPlc = plcs.find((p) => p.plcId === form.plcId) ?? plcs[0];
  const usedOnPlc = new Set((pinsQ.data ?? []).filter((m) => (m.plcId ?? 'default') === selectedPlc?.plcId).map((m) => m.pinId));
  const freePins = selectedPlc ? pinsForPlc(selectedPlc.byteCount).filter((p) => !usedOnPlc.has(p)) : [];

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['machine-signals', machine.machineId] });
    queryClient.invalidateQueries({ queryKey: ['pin-mappings'] });
    queryClient.invalidateQueries({ queryKey: ['setup-status'] });
  };
  const addMut = useMutation({
    mutationFn: () => apiService.createMachineSignal(machine.machineId, { plcId: form.plcId || selectedPlc?.plcId || 'default', pinId: form.pinId, role: form.role }),
    onSuccess: () => { toast.success('Signal wired'); setForm((f) => ({ ...f, pinId: '' })); refresh(); },
    onError: (e) => toast.error(errMsg(e, 'Could not wire signal')),
  });
  const delMut = useMutation({
    mutationFn: (sensorId: string) => apiService.deleteMachineSignal(machine.machineId, sensorId),
    onSuccess: () => { toast.success('Signal removed'); refresh(); },
    onError: (e) => toast.error(errMsg(e, 'Could not remove signal')),
  });

  const steps = [machine.powerMapped, machine.cycleMapped, machine.departmentHasMold].filter(Boolean).length;

  return (
    <Card>
      <CardContent className="p-4">
        <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen((o) => !o)}>
          <div className="flex items-center gap-3">
            {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <Cpu className="h-5 w-5 text-primary" />
            <div>
              <div className="font-medium text-foreground">{machine.name}</div>
              <div className="text-xs text-muted-foreground">{machine.departmentName}</div>
            </div>
          </div>
          {machine.ready ? <Badge variant="success">Ready</Badge> : <Badge variant="warning">{3 - steps} step{3 - steps === 1 ? '' : 's'} left</Badge>}
        </button>

        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Check ok={machine.powerMapped} label="Power signal wired" />
          <Check ok={machine.cycleMapped} label="Cycle signal wired" />
          <Check ok={machine.departmentHasMold} label="Mold defined">
            <Link to="/molds" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">Add <ArrowRight className="h-3 w-3" /></Link>
          </Check>
        </div>

        {open && (
          <div className="mt-4 space-y-3 border-t border-border pt-4">
            <h4 className="text-sm font-medium text-foreground">Wired signals</h4>
            {signalsQ.isLoading ? <Spinner /> : (signalsQ.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No signals yet — wire a power and a cycle signal below.</p>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {(signalsQ.data ?? []).map((s) => (
                  <div key={s.sensorId} className="flex items-center justify-between px-3 py-2">
                    <div className="flex items-center gap-3">
                      {s.role === 'power' ? <Zap className="h-4 w-4 text-warning" /> : <Activity className="h-4 w-4 text-info" />}
                      <span className="text-sm capitalize text-foreground">{s.role.replace('-', ' ')}</span>
                      {s.pinId ? <Badge variant="outline">{s.plcId ?? 'default'} · {s.pinId}</Badge> : <Badge variant="muted">no pin</Badge>}
                    </div>
                    <Button variant="ghost" size="icon" aria-label="Remove signal" onClick={() => delMut.mutate(s.sensorId)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                ))}
              </div>
            )}

            {plcs.length === 0 ? (
              <p className="rounded-md bg-warning/10 p-3 text-sm text-warning">Add a PLC above before wiring signals.</p>
            ) : (
              <div className="flex flex-wrap items-end gap-3 rounded-md bg-muted/40 p-3">
                <div>
                  <Label>PLC</Label>
                  <Select className="w-40" value={form.plcId} onChange={(e) => setForm({ ...form, plcId: e.target.value, pinId: '' })}>
                    {plcs.map((p) => <option key={p._id} value={p.plcId}>{p.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>Role</Label>
                  <Select className="w-36" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                    <option value="power">Power</option>
                    <option value="unit-cycle">Unit-cycle</option>
                  </Select>
                </div>
                <div>
                  <Label>Pin</Label>
                  <Select className="w-28" value={form.pinId} onChange={(e) => setForm({ ...form, pinId: e.target.value })}>
                    <option value="">Select…</option>
                    {freePins.map((p) => <option key={p} value={p}>{p}</option>)}
                  </Select>
                </div>
                <Button disabled={!form.pinId} loading={addMut.isPending} onClick={() => addMut.mutate()}><Plus className="h-4 w-4" /> Wire</Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const Check: React.FC<{ ok: boolean; label: string; children?: React.ReactNode }> = ({ ok, label, children }) => (
  <div className="flex items-center gap-2 text-sm">
    {ok ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
    <span className={ok ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
    {!ok && children}
  </div>
);

/* ------------------------------------------------------------------- page */

const Setup: React.FC = () => {
  const statusQ = useQuery<SetupMachine[]>({ queryKey: ['setup-status'], queryFn: () => apiService.getSetupStatus() });
  const plcsQ = useQuery<Plc[]>({ queryKey: ['plcs'], queryFn: () => apiService.getPlcs() });

  if (statusQ.isLoading) return <PageLoader label="Checking setup…" />;
  const machines = statusQ.data ?? [];
  const plcs = plcsQ.data ?? [];
  const ready = machines.filter((m) => m.ready).length;
  const allReady = ready === machines.length && machines.length > 0;

  const byDept = machines.reduce<Record<string, SetupMachine[]>>((acc, m) => {
    (acc[m.departmentName || 'Unassigned'] ??= []).push(m);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Setup</h1>
        <p className="text-muted-foreground">Register your PLCs and wire each machine's signals so its OEE, MTTR &amp; MTBF go live.</p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          <div className={cn('flex h-11 w-11 items-center justify-center rounded-lg', allReady ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>
            {allReady ? <CheckCircle2 className="h-6 w-6" /> : <Activity className="h-6 w-6" />}
          </div>
          <div>
            <div className="text-lg font-semibold text-foreground">{ready} of {machines.length} machines ready</div>
            <div className="text-sm text-muted-foreground">Ready = power signal + cycle signal wired, and a mold defined in the department.</div>
          </div>
        </CardContent>
      </Card>

      <PlcRegistry />

      <div className="rounded-lg border border-info/30 bg-info/10 p-4 text-sm text-foreground">
        <p className="mb-1 flex items-center gap-2 font-medium"><Package className="h-4 w-4 text-info" /> How metrics come alive</p>
        <ol className="ml-6 list-decimal space-y-0.5 text-muted-foreground">
          <li><span className="text-foreground">Power signal</span> → when the machine is on (availability &amp; running time).</li>
          <li><span className="text-foreground">Cycle signal</span> → counts produced units (quality &amp; throughput).</li>
          <li><span className="text-foreground">A mold</span> assigned on the timeline → ideal rate (performance, completing OEE).</li>
        </ol>
      </div>

      {machines.length === 0 ? (
        <EmptyState icon={<Cpu className="h-8 w-8" />} title="No machines yet" description="Create a department and add machines, then return here to wire their signals." action={<Link to="/departments"><Button>Go to Departments</Button></Link>} />
      ) : (
        Object.entries(byDept).map(([dept, list]) => (
          <div key={dept} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{dept}</h2>
            {list.map((m) => <MachineSetupCard key={m.machineId} machine={m} plcs={plcs} />)}
          </div>
        ))
      )}
    </div>
  );
};

export default Setup;
