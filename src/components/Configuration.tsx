import React, { useEffect, useRef, useState } from 'react';
import { useForm, useFieldArray, Controller, get, type FieldPath } from 'react-hook-form';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Plus, Trash2 } from 'lucide-react';
import apiService from '../services/api';
import { Button, Field, IconButton, Input, PageHeader, PageLoader, Section, Select, Tabs } from './ui';
import { cn } from '../lib/cn';
import StoppageReasonsSettings from './StoppageReasonsSettings';
import AlertsSettings from './AlertsSettings';

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
const reportScheduleSchema = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  email: z.boolean(),
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
  reportSchedule: z.infer<typeof reportScheduleSchema>;
  shifts: z.infer<typeof shiftsSchema>;
  metricsThresholds: z.infer<typeof thresholdsSchema>;
};

const METRICS = [
  { key: 'oee', label: 'OEE', unit: '%' },
  { key: 'availability', label: 'Availability', unit: '%' },
  { key: 'quality', label: 'Quality', unit: '%' },
  { key: 'performance', label: 'Performance', unit: '%' },
  { key: 'mtbf', label: 'MTBF', unit: 'min' },
  { key: 'mttr', label: 'MTTR', unit: 'min' },
  { key: 'reliability', label: 'Reliability', unit: '' },
] as const;
const LEVELS = [
  { key: 'excellent', label: 'Excellent' },
  { key: 'good', label: 'Good' },
  { key: 'fair', label: 'Fair' },
] as const;
const PINS = Array.from({ length: 8 }, (_, i) => `DQ.${i}`);
const TABS = [
  { id: 'plc', label: 'PLC' },
  { id: 'signalTimeouts', label: 'Signal timeouts' },
  { id: 'shifts', label: 'Shifts' },
  { id: 'reasons', label: 'Stoppage reasons' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'email', label: 'Email and daily report' },
  { id: 'metricsThresholds', label: 'Thresholds' },
  { id: 'pins', label: 'Pin mappings' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const TAB_OPTIONS = TABS.map((t) => ({ value: t.id as TabId, label: t.label }));

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const defaults: FormData = {
  plc: { ip: '', rack: 0, slot: 1 },
  signalTimeouts: { powerSignalTimeout: 5, cycleSignalTimeout: 2 },
  email: { senderEmail: '', senderPassword: '', recipients: [] },
  reportSchedule: { enabled: false, hour: 6, email: true },
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

const invalidInput = 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20';
const checkbox = 'h-4 w-4 shrink-0 accent-[hsl(var(--primary))]';
const th = 'whitespace-nowrap px-5 py-2 font-medium';

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
      reportSchedule: { ...defaults.reportSchedule, ...configQ.data.reportSchedule },
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

  if (configQ.isLoading) return <PageLoader label="Loading settings…" />;

  const errorOf = (name: string): string | undefined => get(errors, name)?.message;

  const numberField = (name: FieldPath<FormData>, label: string, opts?: { min?: number; max?: number; hint?: string }) => (
    <Field label={label} hint={opts?.hint} error={errorOf(name)}>
      <Input type="number" min={opts?.min} max={opts?.max} {...register(name, { valueAsNumber: true })} />
    </Field>
  );
  const saveBar = (onSave: () => void) => (
    <div className="flex justify-end border-t border-border px-5 py-3">
      <Button type="button" loading={saveMut.isPending} onClick={onSave}>Save changes</Button>
    </div>
  );

  const pinMappings = pinsQ.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Each section saves on its own." />

      <Tabs value={tab} onChange={setTab} tabs={TAB_OPTIONS} ariaLabel="Settings sections" />

      {tab === 'plc' && (
        <Section flush title="PLC connection" description="The network address of the main PLC that LineSentry reads signals from.">
          <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <Field label="IP address" error={errors.plc?.ip?.message}>
              <Input placeholder="192.168.0.1" {...register('plc.ip')} />
            </Field>
            {numberField('plc.rack', 'Rack', { min: 0, hint: 'Usually 0.' })}
            {numberField('plc.slot', 'Slot', { min: 0, hint: 'Usually 1.' })}
          </div>
          {saveBar(() => saveSection('plc', plcSchema))}
        </Section>
      )}

      {tab === 'signalTimeouts' && (
        <Section flush title="Signal timeouts" description="How long LineSentry waits for a signal before it changes a machine's state.">
          <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
            {numberField('signalTimeouts.powerSignalTimeout', 'Power signal timeout (minutes)', {
              min: 1,
              max: 60,
              hint: 'A machine counts as powered if a power signal arrived within this many minutes. From 1 to 60.',
            })}
            {numberField('signalTimeouts.cycleSignalTimeout', 'Unit-cycle signal timeout (minutes)', {
              min: 1,
              max: 60,
              hint: 'A machine counts as producing if a unit-cycle signal arrived within this many minutes. From 1 to 60.',
            })}
          </div>
          {saveBar(() => saveSection('signalTimeouts', timeoutsSchema))}
        </Section>
      )}

      {tab === 'shifts' && (
        <Section
          flush
          title="Shifts"
          description="Shifts let you assign an operator or a mold to a whole shift on the timeline."
          actions={
            <Button type="button" variant="outline" size="sm" onClick={() => shifts.append({ name: '', startTime: '06:00', endTime: '14:00', isActive: true })}>
              <Plus className="h-4 w-4" /> Add shift
            </Button>
          }
        >
          {shifts.fields.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">No shifts yet. Add one, then save.</p>
          ) : (
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className={th}>Name</th>
                    <th scope="col" className={th}>Start</th>
                    <th scope="col" className={th}>End</th>
                    <th scope="col" className={th}>Active</th>
                    <th scope="col" className={th}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shifts.fields.map((f, i) => {
                    const rowErrors = errors.shifts?.[i];
                    return (
                      <tr key={f.id}>
                        <td className="min-w-[12rem] px-5 py-2 align-top">
                          <Input
                            aria-label="Shift name"
                            placeholder="Morning"
                            className={cn(rowErrors?.name && invalidInput)}
                            aria-invalid={rowErrors?.name ? true : undefined}
                            {...register(`shifts.${i}.name`)}
                          />
                          {rowErrors?.name && <p className="mt-1 text-xs text-destructive">{rowErrors.name.message}</p>}
                        </td>
                        <td className="w-36 px-5 py-2 align-top">
                          <Input
                            type="time"
                            aria-label="Start time"
                            className={cn(rowErrors?.startTime && invalidInput)}
                            aria-invalid={rowErrors?.startTime ? true : undefined}
                            {...register(`shifts.${i}.startTime`)}
                          />
                          {rowErrors?.startTime && <p className="mt-1 text-xs text-destructive">Enter a start time.</p>}
                        </td>
                        <td className="w-36 px-5 py-2 align-top">
                          <Input
                            type="time"
                            aria-label="End time"
                            className={cn(rowErrors?.endTime && invalidInput)}
                            aria-invalid={rowErrors?.endTime ? true : undefined}
                            {...register(`shifts.${i}.endTime`)}
                          />
                          {rowErrors?.endTime && <p className="mt-1 text-xs text-destructive">Enter an end time.</p>}
                        </td>
                        <td className="w-20 px-5 py-2 align-top">
                          <span className="flex h-9 items-center">
                            <input type="checkbox" aria-label="Active" className={checkbox} {...register(`shifts.${i}.isActive`)} />
                          </span>
                        </td>
                        <td className="w-16 px-5 py-2 text-right align-top">
                          <IconButton label="Remove shift" danger className="mt-0.5" onClick={() => shifts.remove(i)}>
                            <Trash2 className="h-4 w-4" />
                          </IconButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {saveBar(() => saveSection('shifts', shiftsSchema))}
        </Section>
      )}

      {tab === 'email' && (
        <Section flush title="Email" description="The account reports are sent from, and who receives them.">
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Sender email" error={errors.email?.senderEmail?.message}>
                <Input type="email" {...register('email.senderEmail')} />
              </Field>
              <Field
                label="Sender app password"
                hint="A password created for this app in the email account's security settings, not the normal sign-in password."
                error={errors.email?.senderPassword?.message}
              >
                <Input type="password" autoComplete="off" {...register('email.senderPassword')} />
              </Field>
            </div>
            <Field
              label="Recipients"
              hint="One email address per line."
              error={errors.email?.recipients ? get(errors, 'email.recipients.message') || get(errors, 'email.recipients.root.message') || 'Check the recipient addresses.' : undefined}
            >
              <Controller
                control={control}
                name="email.recipients"
                render={({ field }) => (
                  <textarea
                    rows={4}
                    className={cn(
                      'flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground',
                      'transition-[border-color,box-shadow] duration-150 ease-out hover:border-foreground/30',
                      'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20',
                    )}
                    value={(field.value ?? []).join('\n')}
                    onChange={(e) => field.onChange(e.target.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))}
                  />
                )}
              />
            </Field>
          </div>
          {saveBar(() => saveSection('email', emailSchema))}
        </Section>
      )}

      {tab === 'email' && (
        <Section
          flush
          title="Daily report"
          description="Saves a report for the previous day once the factory clock reaches the chosen hour."
        >
          <div className="space-y-4 p-5">
            <label className="flex items-start gap-3">
              <input type="checkbox" className={cn(checkbox, 'mt-0.5')} {...register('reportSchedule.enabled')} />
              <span>
                <span className="block text-sm text-foreground">Generate a report every day</span>
                <span className="block text-xs text-muted-foreground">It appears on the Reports page.</span>
              </span>
            </label>
            <Field label="Time" hint="Factory time." className="max-w-[12rem]" error={errorOf('reportSchedule.hour')}>
              <Select {...register('reportSchedule.hour', { valueAsNumber: true })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                ))}
              </Select>
            </Field>
            <label className="flex items-start gap-3">
              <input type="checkbox" className={cn(checkbox, 'mt-0.5')} {...register('reportSchedule.email')} />
              <span>
                <span className="block text-sm text-foreground">Email it to the recipients</span>
                <span className="block text-xs text-muted-foreground">Uses the sender and recipients in the Email section above.</span>
              </span>
            </label>
          </div>
          {saveBar(() => saveSection('reportSchedule', reportScheduleSchema))}
        </Section>
      )}

      {tab === 'metricsThresholds' && (
        <Section
          flush
          title="Thresholds"
          description="The values at which each figure is rated excellent, good or fair across the app."
        >
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className={th}>Metric</th>
                  {LEVELS.map((l) => <th key={l.key} scope="col" className={th}>{l.label}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {METRICS.map((m) => (
                  <tr key={m.key}>
                    <th scope="row" className="whitespace-nowrap px-5 py-2 text-left font-medium text-foreground">
                      {m.label}
                      {m.unit && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{m.unit}</span>}
                    </th>
                    {LEVELS.map((l) => {
                      const invalid = Boolean(errors.metricsThresholds?.[m.key]?.[l.key]);
                      return (
                        <td key={l.key} className="px-5 py-1.5">
                          <Input
                            type="number"
                            min={0}
                            aria-label={`${m.label}, ${l.label.toLowerCase()}`}
                            aria-invalid={invalid ? true : undefined}
                            className={cn('tabular h-8 w-24', invalid && invalidInput)}
                            {...register(`metricsThresholds.${m.key}.${l.key}`, { valueAsNumber: true })}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {saveBar(() => saveSection('metricsThresholds', thresholdsSchema))}
        </Section>
      )}

      {tab === 'reasons' && <StoppageReasonsSettings />}

      {tab === 'alerts' && <AlertsSettings />}

      {tab === 'pins' && (
        <Section flush title="Pin mappings" description="Which PLC output pin each sensor is read from.">
          <div className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-4">
            <Field label="Sensor" className="min-w-[180px] flex-1 sm:max-w-xs">
              <Select value={pinForm.sensorId} onChange={(e) => setPinForm({ ...pinForm, sensorId: e.target.value })}>
                <option value="">Select a sensor</option>
                {(sensorsQ.data ?? []).map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Pin" className="w-36">
              <Select value={pinForm.pinId} onChange={(e) => setPinForm({ ...pinForm, pinId: e.target.value })}>
                <option value="">Select a pin</option>
                {freePins.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </Field>
            <Button type="button" disabled={!pinForm.sensorId || !pinForm.pinId} loading={addPinMut.isPending} onClick={() => addPinMut.mutate(pinForm, { onSuccess: () => setPinForm({ sensorId: '', pinId: '' }) })}>
              Add mapping
            </Button>
          </div>

          {pinMappings.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">No pin mappings yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {pinMappings.map((m) => (
                <li key={m._id} className="flex items-center gap-4 px-5 py-1.5">
                  <span className="w-16 shrink-0 font-mono text-[13px] text-foreground">{m.pinId}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{m.sensorId?.name ?? 'Unknown sensor'}</span>
                  <IconButton label="Remove mapping" danger onClick={() => delPinMut.mutate(m._id)}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
};

export default Configuration;
