import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Check, ChevronDown, ChevronRight, Circle, Trash2 } from 'lucide-react';
import apiService from '../services/api';
import {
  Button, DataTable, EmptyState, Field, IconButton, Input, PageHeader, PageLoader, Section, Select, Spinner,
  type Column,
} from './ui';
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
interface Plc { _id: string; plcId: string; name: string; ip?: string; rack: number; slot: number; byteCount: number; lastSeenAt?: string }

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** All Siemens byte.bit pin addresses a PLC exposes given its byte count. */
const pinsForPlc = (byteCount: number): string[] => {
  const out: string[] = [];
  for (let b = 0; b < Math.max(1, byteCount); b++) for (let i = 0; i < 8; i++) out.push(`Q${b}.${i}`);
  return out;
};

const STALE_AFTER_MIN = 5;

const ago = (minutes: number) => {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
};

/** When a PLC last sent anything, and whether it has gone quiet. */
const plcSignal = (lastSeenAt?: string): { text: string; stale: boolean } => {
  const seen = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
  if (Number.isNaN(seen)) return { text: 'No signal yet', stale: false };
  const minutes = Math.max(0, Math.floor((Date.now() - seen) / 60000));
  return minutes > STALE_AFTER_MIN
    ? { text: `Not sending. Last signal ${ago(minutes)}`, stale: true }
    : { text: `Last signal ${ago(minutes)}`, stale: false };
};

const signalLabel = (role: string) =>
  role === 'power' ? 'Power signal' : role === 'unit-cycle' ? 'Unit-cycle signal' : role.replace('-', ' ');

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
  const quiet = plcs.filter((p) => plcSignal(p.lastSeenAt).stale).length;

  const columns: Column<Plc>[] = [
    { key: 'name', header: 'Name', render: (p) => {
      const signal = plcSignal(p.lastSeenAt);
      return (
        <div className="min-w-0">
          <p className="font-medium text-foreground">{p.name}</p>
          <p className={cn('text-xs', signal.stale ? 'text-warning' : 'text-muted-foreground')}>{signal.text}</p>
        </div>
      );
    } },
    { key: 'plcId', header: 'ID', className: 'whitespace-nowrap font-mono text-[13px]', render: (p) => p.plcId },
    { key: 'ip', header: 'Address', className: 'tabular whitespace-nowrap', render: (p) => p.ip || '–' },
    { key: 'pins', header: 'Pins', className: 'tabular text-right', render: (p) => p.byteCount * 8 },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (p) => (
      <div className="flex justify-end">
        <IconButton label="Remove PLC" danger onClick={() => delMut.mutate(p._id)}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>
    ) },
  ];

  return (
    <Section
      flush
      title="PLCs"
      description="The controllers that send machine signals to LineSentry."
      actions={
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Manage'}
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Button>
      }
    >
      {!open ? (
        <p className="px-5 py-3 text-[13px] text-muted-foreground">
          {plcs.length === 0 ? 'No PLCs yet. Add one before wiring signals.' : `${plcs.length} ${plcs.length === 1 ? 'PLC' : 'PLCs'} registered.`}
          {quiet > 0 && <span className="text-warning"> {quiet} not sending.</span>}
        </p>
      ) : (
        <>
          {plcs.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">No PLCs yet. Add the first one below.</p>
          ) : (
            <DataTable columns={columns} rows={plcs} rowKey={(p) => p._id} />
          )}

          <div className="border-t border-border px-5 py-4">
            <h3 className="text-[13px] font-semibold text-foreground">Add a PLC</h3>
            <div className="mt-3 grid grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_5.5rem_auto]">
              <Field label="ID">
                <Input placeholder="line-1" value={form.plcId} onChange={(e) => setForm({ ...form, plcId: e.target.value })} />
              </Field>
              <Field label="Name">
                <Input placeholder="Injection line 1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="IP address">
                <Input placeholder="192.168.0.1" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} />
              </Field>
              <Field label="Bytes">
                <Input type="number" min={1} value={form.byteCount} onChange={(e) => setForm({ ...form, byteCount: parseInt(e.target.value) || 1 })} />
              </Field>
              <Button
                className="col-span-2 sm:col-span-1"
                disabled={!form.plcId.trim() || !form.name.trim()}
                loading={addMut.isPending}
                onClick={() => addMut.mutate()}
              >
                Add PLC
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Each byte gives 8 output pins (Q0.0 to Q0.7, then Q1.0 and so on). Add one entry per device, or one entry with
              more bytes for a gateway PLC that collects signals from others. The data collector for each PLC must run with{' '}
              <code className="rounded bg-muted px-1">PLC_ID</code> set to the ID above and{' '}
              <code className="rounded bg-muted px-1">BYTE_COUNT</code> set to the same number of bytes.
            </p>
          </div>
        </>
      )}
    </Section>
  );
};

const Step: React.FC<{ done: boolean; label: string }> = ({ done, label }) => (
  <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-xs', done ? 'text-foreground' : 'text-muted-foreground')}>
    {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Circle className="h-3.5 w-3.5 text-muted-foreground/60" aria-hidden />}
    {label}
    <span className="sr-only">{done ? ' (done)' : ' (not done)'}</span>
  </span>
);

const MachineRow: React.FC<{ machine: SetupMachine; plcs: Plc[] }> = ({ machine, plcs }) => {
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

  const left = 3 - [machine.powerMapped, machine.cycleMapped, machine.departmentHasMold].filter(Boolean).length;
  const signals = signalsQ.data ?? [];
  const plcName = (id: string | null) => plcs.find((p) => p.plcId === (id ?? 'default'))?.name ?? id ?? 'default';

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:ring-inset"
        onClick={() => setOpen((o) => !o)}
      >
        {open
          ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{machine.name}</span>
        <span className="hidden items-center gap-4 md:flex">
          <Step done={machine.powerMapped} label="Power signal" />
          <Step done={machine.cycleMapped} label="Unit-cycle signal" />
          <Step done={machine.departmentHasMold} label="Mold" />
        </span>
        <span className={cn('w-24 shrink-0 text-right text-[13px]', machine.ready ? 'text-muted-foreground' : 'text-warning')}>
          {machine.ready ? 'Ready' : `${left} ${left === 1 ? 'step' : 'steps'} left`}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border bg-muted/20 py-4 pl-12 pr-5">
          <div className="flex flex-wrap gap-x-4 gap-y-1 md:hidden">
            <Step done={machine.powerMapped} label="Power signal" />
            <Step done={machine.cycleMapped} label="Unit-cycle signal" />
            <Step done={machine.departmentHasMold} label="Mold" />
          </div>

          <div>
            <h4 className="text-[13px] font-medium text-foreground">Wired signals</h4>
            {signalsQ.isLoading ? (
              <Spinner className="mt-2 h-4 w-4" />
            ) : signals.length === 0 ? (
              <p className="mt-1 text-[13px] text-muted-foreground">None yet. Wire a power signal and a unit-cycle signal below.</p>
            ) : (
              <ul className="mt-1 divide-y divide-border border-y border-border">
                {signals.map((s) => (
                  <li key={s.sensorId} className="flex items-center gap-3 py-1">
                    <span className="w-36 shrink-0 text-[13px] text-foreground">{signalLabel(s.role)}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                      {s.pinId ? <>{plcName(s.plcId)}, pin <span className="font-mono">{s.pinId}</span></> : 'No pin assigned'}
                    </span>
                    <IconButton label="Remove signal" danger onClick={() => delMut.mutate(s.sensorId)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {plcs.length === 0 ? (
            <p className="text-[13px] text-warning">Add a PLC above before wiring signals.</p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="PLC" className="w-44">
                <Select value={form.plcId} onChange={(e) => setForm({ ...form, plcId: e.target.value, pinId: '' })}>
                  {plcs.map((p) => <option key={p._id} value={p.plcId}>{p.name}</option>)}
                </Select>
              </Field>
              <Field label="Signal" className="w-40">
                <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="power">Power</option>
                  <option value="unit-cycle">Unit cycle</option>
                </Select>
              </Field>
              <Field label="Pin" className="w-32">
                <Select value={form.pinId} onChange={(e) => setForm({ ...form, pinId: e.target.value })}>
                  <option value="">Select a pin</option>
                  {freePins.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              </Field>
              <Button disabled={!form.pinId} loading={addMut.isPending} onClick={() => addMut.mutate()}>Wire</Button>
            </div>
          )}

          {!machine.departmentHasMold && (
            <p className="text-[13px] text-muted-foreground">
              This department has no mold yet.{' '}
              <Link to="/molds" className="font-medium text-foreground underline underline-offset-2">Add a mold</Link>
            </p>
          )}
        </div>
      )}
    </li>
  );
};

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
      <PageHeader title="Setup" description="Connect each machine's two signals so it can be monitored." />

      {machines.length > 0 && (
        <Section>
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <p className="text-sm font-medium text-foreground">
              {allReady ? 'All machines are ready.' : `${ready} of ${machines.length} machines ready`}
            </p>
            <p className="text-xs text-muted-foreground">
              A machine is ready when both signals are wired and its department has a mold.
            </p>
          </div>
          <div
            className="mt-3 h-1 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Machines ready"
            aria-valuemin={0}
            aria-valuemax={machines.length}
            aria-valuenow={ready}
          >
            <div className="h-full rounded-full bg-foreground/70" style={{ width: `${(ready / machines.length) * 100}%` }} />
          </div>
          <details className="mt-4 text-[13px] text-muted-foreground">
            <summary className="w-fit cursor-pointer rounded text-foreground">How this works</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>The power signal shows when the machine is switched on. It gives availability and running time.</li>
              <li>The unit-cycle signal counts each unit the machine produces. It gives output and quality.</li>
              <li>
                A mold assigned on the timeline sets the expected rate. It gives performance, which completes OEE
                (overall equipment effectiveness).
              </li>
            </ul>
          </details>
        </Section>
      )}

      <PlcRegistry />

      <Section flush title="Machines" description="Select a machine to wire its signals.">
        {machines.length === 0 ? (
          <EmptyState
            title="No machines yet"
            description="Create a department and add machines, then return here to wire their signals."
            action={<Link to="/departments"><Button>Go to departments</Button></Link>}
          />
        ) : (
          Object.entries(byDept).map(([dept, list]) => (
            <div key={dept} className="border-b border-border last:border-b-0">
              <h3 className="border-b border-border bg-muted/40 px-5 py-1.5 text-xs font-medium text-muted-foreground">{dept}</h3>
              <ul className="divide-y divide-border">
                {list.map((m) => <MachineRow key={m.machineId} machine={m} plcs={plcs} />)}
              </ul>
            </div>
          ))
        )}
      </Section>
    </div>
  );
};

export default Setup;
