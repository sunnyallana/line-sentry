import React, { useEffect, useRef, useState } from 'react';
import { useForm, useFieldArray, Controller, type FieldPath } from 'react-hook-form';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Network, Mail, Save, Clock, BarChart2, Plus, Trash2, Link as LinkIcon } from 'lucide-react';
import apiService from '../services/api';
import { Button, Input, Label, Select, Card, CardHeader, CardTitle, CardContent, Badge, PageLoader } from './ui';
import { cn } from '../lib/cn';

/* Per-section schemas — each tab validates and saves independently, so an
   incomplete section (e.g. no email recipients yet) never blocks another. */
const levelSchema = z.object({ excellent: z.number().min(0), good: z.number().min(0), fair: z.number().min(0) });
const plcSchema = z.object({ ip: z.string().min(1, 'IP is required'), rack: z.number().int().min(0), slot: z.number().int().min(0) });
const timeoutsSchema = z.object({ powerSignalTimeout: z.number().int().min(1).max(60), cycleSignalTimeout: z.number().int().min(1).max(60) });
const emailSchema = z.object({
  senderEmail: z.string().email('Invalid email format'),
  senderPassword: z.string().min(1, 'Password is required'),
  recipients: z.array(z.string().email('Invalid recipient email')).min(1, 'Add at least one recipient'),
});
const shiftSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  startTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'HH:MM'),
  endTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'HH:MM'),
  isActive: z.boolean(),
});
const shiftsSchema = z.array(shiftSchema);
const thresholdsSchema = z.object({
  oee: levelSchema, availability: levelSchema, quality: levelSchema, performance: levelSchema,
  mtbf: levelSchema, mttr: levelSchema, reliability: levelSchema,
});

type FormData = {
  plc: z.infer<typeof plcSchema>;
  signalTimeouts: z.infer<typeof timeoutsSchema>;
  email: z.infer<typeof emailSchema>;
  shifts: z.infer<typeof shiftsSchema>;
  metricsThresholds: z.infer<typeof thresholdsSchema>;
};

const METRICS = ['oee', 'availability', 'quality', 'performance', 'mtbf', 'mttr', 'reliability'] as const;
const LEVELS = ['excellent', 'good', 'fair'] as const;
const PINS = Array.from({ length: 8 }, (_, i) => `DQ.${i}`);
const TABS = [
  { id: 'plc', label: 'PLC', icon: Network },
  { id: 'signalTimeouts', label: 'Signal Timeouts', icon: Clock },
  { id: 'shifts', label: 'Shifts', icon: Clock },
  { id: 'email', label: 'Email', icon: Mail },
  { id: 'metricsThresholds', label: 'Thresholds', icon: BarChart2 },
  { id: 'pins', label: 'Pin Mappings', icon: LinkIcon },
] as const;
type TabId = (typeof TABS)[number]['id'];

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const defaults: FormData = {
  plc: { ip: '', rack: 0, slot: 1 },
  signalTimeouts: { powerSignalTimeout: 5, cycleSignalTimeout: 2 },
  email: { senderEmail: '', senderPassword: '', recipients: [] },
  shifts: [],
  metricsThresholds: {
    oee: { excellent: 85, good: 70, fair: 50 },
    availability: { excellent: 90, good: 80, fair: 70 },
    quality: { excellent: 95, good: 90, fair: 85 },
    performance: { excellent: 90, good: 80, fair: 70 },
    mtbf: { excellent: 500, good: 300, fair: 150 },
    mttr: { excellent: 20, good: 40, fair: 60 },
    reliability: { excellent: 10, good: 5, fair: 2 },
  },
};

interface PinMapping { _id: string; pinId: string; sensorId?: { name?: string } }
interface SensorLite { _id: string; name: string }

const Configuration: React.FC = () => {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabId>('plc');

  const configQ = useQuery({ queryKey: ['config'], queryFn: () => apiService.getConfig() });
  const sensorsQ = useQuery<SensorLite[]>({ queryKey: ['sensors', 'all'], queryFn: () => apiService.getSensors() });
  const pinsQ = useQuery<PinMapping[]>({ queryKey: ['pin-mappings'], queryFn: () => apiService.getPinMappings() });

  const { control, register, getValues, reset, setError, clearErrors, formState: { errors } } = useForm<FormData>({ defaultValues: defaults });
  const shifts = useFieldArray({ control, name: 'shifts' });

  // Seed the form once from the loaded config (don't clobber unsaved edits on refetch).
  const seeded = useRef(false);
  useEffect(() => {
    if (!configQ.data || seeded.current) return;
    reset({
      plc: configQ.data.plc ?? defaults.plc,
      signalTimeouts: configQ.data.signalTimeouts ?? defaults.signalTimeouts,
      email: { ...defaults.email, ...configQ.data.email, recipients: configQ.data.email?.recipients ?? [] },
      shifts: configQ.data.shifts ?? [],
      metricsThresholds: configQ.data.metricsThresholds ?? defaults.metricsThresholds,
    });
    seeded.current = true;
  }, [configQ.data, reset]);

  const saveMut = useMutation({
    mutationFn: (partial: Partial<FormData>) => apiService.updateConfig(partial as Record<string, unknown>),
    onSuccess: (_d, partial) => {
      toast.success(`${Object.keys(partial)[0] === 'metricsThresholds' ? 'Thresholds' : 'Settings'} saved`);
      queryClient.invalidateQueries({ queryKey: ['config'] });
      if ('shifts' in partial) queryClient.invalidateQueries({ queryKey: ['shifts'] });
    },
    onError: (e) => toast.error(errMsg(e, 'Save failed')),
  });

  // Validate a single section and, if valid, persist only that section.
  function saveSection<K extends keyof FormData>(key: K, schema: z.ZodType<FormData[K]>) {
    clearErrors(key as FieldPath<FormData>);
    const result = schema.safeParse(getValues(key));
    if (!result.success) {
      result.error.issues.forEach((i) => setError([key, ...i.path].join('.') as FieldPath<FormData>, { message: i.message }));
      toast.error('Please fix the highlighted fields');
      return;
    }
    saveMut.mutate({ [key]: result.data } as Partial<FormData>);
  }

  const addPinMut = useMutation({
    mutationFn: (m: { sensorId: string; pinId: string }) => apiService.createPinMapping(m),
    onSuccess: () => { toast.success('Pin mapped'); queryClient.invalidateQueries({ queryKey: ['pin-mappings'] }); },
    onError: (e) => toast.error(errMsg(e, 'Mapping failed')),
  });
  const delPinMut = useMutation({
    mutationFn: (id: string) => apiService.deletePinMapping(id),
    onSuccess: () => { toast.success('Mapping removed'); queryClient.invalidateQueries({ queryKey: ['pin-mappings'] }); },
    onError: (e) => toast.error(errMsg(e, 'Remove failed')),
  });

  const [pinForm, setPinForm] = useState({ sensorId: '', pinId: '' });
  const usedPins = new Set((pinsQ.data ?? []).map((p) => p.pinId));
  const freePins = PINS.filter((p) => !usedPins.has(p));

  if (configQ.isLoading) return <PageLoader label="Loading configuration…" />;

  const numberField = (name: FieldPath<FormData>, label: string, opts?: { min?: number; max?: number }) => (
    <div>
      <Label>{label}</Label>
      <Input type="number" min={opts?.min} max={opts?.max} {...register(name, { valueAsNumber: true })} />
    </div>
  );
  const SaveBar: React.FC<{ onSave: () => void }> = ({ onSave }) => (
    <div className="mt-5 flex justify-end border-t border-border pt-4">
      <Button type="button" loading={saveMut.isPending} onClick={onSave}><Save className="h-4 w-4" /> Save changes</Button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Configuration</h1>
        <p className="text-muted-foreground">Each section saves on its own — set up what you need, when you need it.</p>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'plc' && (
        <Card><CardContent className="p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-1"><Label>PLC IP address</Label><Input {...register('plc.ip')} />
              {errors.plc?.ip && <p className="mt-1 text-sm text-destructive">{errors.plc.ip.message}</p>}</div>
            {numberField('plc.rack', 'Rack', { min: 0 })}
            {numberField('plc.slot', 'Slot', { min: 0 })}
          </div>
          <SaveBar onSave={() => saveSection('plc', plcSchema)} />
        </CardContent></Card>
      )}

      {tab === 'signalTimeouts' && (
        <Card><CardContent className="p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {numberField('signalTimeouts.powerSignalTimeout', 'Power signal timeout (min)', { min: 1, max: 60 })}
            {numberField('signalTimeouts.cycleSignalTimeout', 'Cycle signal timeout (min)', { min: 1, max: 60 })}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">How long without a signal before a machine is considered stopped (power) or its cycle has ended (cycle).</p>
          <SaveBar onSave={() => saveSection('signalTimeouts', timeoutsSchema)} />
        </CardContent></Card>
      )}

      {tab === 'shifts' && (
        <Card><CardContent className="p-6">
          <div className="space-y-3">
            {shifts.fields.length === 0 && <p className="text-sm text-muted-foreground">No shifts yet. Add one to enable shift-wide operator/mold assignment on the timeline.</p>}
            {shifts.fields.map((f, i) => (
              <div key={f.id} className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
                <div className="min-w-[140px] flex-1">
                  <Label>Name</Label><Input {...register(`shifts.${i}.name`)} />
                  {errors.shifts?.[i]?.name && <p className="mt-1 text-sm text-destructive">{errors.shifts[i]?.name?.message}</p>}
                </div>
                <div><Label>Start</Label><Input type="time" {...register(`shifts.${i}.startTime`)} /></div>
                <div><Label>End</Label><Input type="time" {...register(`shifts.${i}.endTime`)} /></div>
                <label className="flex items-center gap-2 pb-2 text-sm text-foreground">
                  <input type="checkbox" {...register(`shifts.${i}.isActive`)} /> Active
                </label>
                <Button type="button" variant="ghost" size="icon" aria-label="Remove shift" onClick={() => shifts.remove(i)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" onClick={() => shifts.append({ name: '', startTime: '06:00', endTime: '14:00', isActive: true })}>
              <Plus className="h-4 w-4" /> Add shift
            </Button>
          </div>
          <SaveBar onSave={() => saveSection('shifts', shiftsSchema)} />
        </CardContent></Card>
      )}

      {tab === 'email' && (
        <Card><CardContent className="p-6">
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div><Label>Sender email</Label><Input type="email" {...register('email.senderEmail')} />
                {errors.email?.senderEmail && <p className="mt-1 text-sm text-destructive">{errors.email.senderEmail.message}</p>}</div>
              <div><Label>Sender app password</Label><Input type="password" autoComplete="off" {...register('email.senderPassword')} />
                {errors.email?.senderPassword && <p className="mt-1 text-sm text-destructive">{errors.email.senderPassword.message}</p>}</div>
            </div>
            <div>
              <Label>Recipients (one per line)</Label>
              <Controller
                control={control}
                name="email.recipients"
                render={({ field }) => (
                  <textarea
                    rows={4}
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={(field.value ?? []).join('\n')}
                    onChange={(e) => field.onChange(e.target.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))}
                  />
                )}
              />
              {errors.email?.recipients && <p className="mt-1 text-sm text-destructive">{(errors.email.recipients.message as string) || 'Add at least one recipient'}</p>}
            </div>
          </div>
          <SaveBar onSave={() => saveSection('email', emailSchema)} />
        </CardContent></Card>
      )}

      {tab === 'metricsThresholds' && (
        <Card><CardContent className="p-6">
          <p className="mb-4 text-sm text-muted-foreground">Bands used to color OEE/MTTR/MTBF metrics across the dashboard.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr><th className="py-2 pr-4">Metric</th><th className="py-2 pr-4">Excellent</th><th className="py-2 pr-4">Good</th><th className="py-2">Fair</th></tr>
              </thead>
              <tbody>
                {METRICS.map((m) => (
                  <tr key={m} className="border-t border-border">
                    <td className="py-2 pr-4 font-medium capitalize text-foreground">{m}</td>
                    {LEVELS.map((l) => (
                      <td key={l} className="py-2 pr-4"><Input className="w-24" type="number" {...register(`metricsThresholds.${m}.${l}`, { valueAsNumber: true })} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SaveBar onSave={() => saveSection('metricsThresholds', thresholdsSchema)} />
        </CardContent></Card>
      )}

      {tab === 'pins' && (
        <Card>
          <CardHeader><CardTitle>Sensor → PLC pin mappings</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
              <div className="min-w-[180px] flex-1">
                <Label>Sensor</Label>
                <Select value={pinForm.sensorId} onChange={(e) => setPinForm({ ...pinForm, sensorId: e.target.value })}>
                  <option value="">Select sensor…</option>
                  {(sensorsQ.data ?? []).map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>Pin</Label>
                <Select value={pinForm.pinId} onChange={(e) => setPinForm({ ...pinForm, pinId: e.target.value })}>
                  <option value="">Select pin…</option>
                  {freePins.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              </div>
              <Button type="button" disabled={!pinForm.sensorId || !pinForm.pinId} loading={addPinMut.isPending} onClick={() => addPinMut.mutate(pinForm, { onSuccess: () => setPinForm({ sensorId: '', pinId: '' }) })}>
                <Plus className="h-4 w-4" /> Map
              </Button>
            </div>

            <div className="divide-y divide-border rounded-md border border-border">
              {(pinsQ.data ?? []).length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">No pin mappings yet.</p>
              ) : (
                (pinsQ.data ?? []).map((m) => (
                  <div key={m._id} className="flex items-center justify-between px-4 py-2">
                    <div className="flex items-center gap-3"><Badge variant="outline">{m.pinId}</Badge><span className="text-foreground">{m.sensorId?.name ?? 'Unknown sensor'}</span></div>
                    <Button variant="ghost" size="icon" aria-label="Remove mapping" onClick={() => delPinMut.mutate(m._id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default Configuration;
