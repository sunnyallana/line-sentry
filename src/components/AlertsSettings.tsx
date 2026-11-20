import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import apiService from '../services/api';
import { Button, Field, Input, Section } from './ui';

/* Who hears about a machine that has stopped, and when. The first alert goes
   to the people on the floor; if the machine is still stopped later, the same
   alert goes to the escalation list as well. */

interface AlertsForm {
  enabled: boolean;
  stoppageMinutes: number;
  escalateMinutes: number;
  recipients: string[];
  escalationRecipients: string[];
  webhookUrl: string;
}

const DEFAULTS: AlertsForm = {
  enabled: false,
  stoppageMinutes: 10,
  escalateMinutes: 30,
  recipients: [],
  escalationRecipients: [],
  webhookUrl: '',
};

const TEXTAREA_CLASS =
  'flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-[border-color,box-shadow] duration-150 ease-out hover:border-foreground/30 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20 focus-visible:ring-offset-0';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const toList = (text: string) => text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const AlertsSettings: React.FC = () => {
  const queryClient = useQueryClient();
  const configQ = useQuery({ queryKey: ['config'], queryFn: () => apiService.getConfig() });
  const [form, setForm] = useState<AlertsForm>(DEFAULTS);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty || !configQ.data) return;
    setForm({ ...DEFAULTS, ...(configQ.data.alerts ?? {}) });
  }, [configQ.data, dirty]);

  const edit = (patch: Partial<AlertsForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  const emailRecipients: string[] = configQ.data?.email?.recipients ?? [];
  const hasSender = !!configQ.data?.email?.senderEmail;
  const badAddress = [...form.recipients, ...form.escalationRecipients].find((a) => !EMAIL.test(a));
  const badWebhook = form.webhookUrl.trim() !== '' && !/^https?:\/\/\S+$/.test(form.webhookUrl.trim());
  const noChannel =
    form.enabled &&
    !form.webhookUrl.trim() &&
    !(hasSender && (form.recipients.length > 0 || emailRecipients.length > 0));
  const escalationOff = form.escalateMinutes <= form.stoppageMinutes;
  const problem = badAddress
    ? `"${badAddress}" is not an email address.`
    : badWebhook
      ? 'The webhook address must start with http:// or https://.'
      : form.stoppageMinutes < 1
        ? 'The first alert needs at least 1 minute.'
        : null;

  const save = useMutation({
    mutationFn: () => apiService.updateConfig({ alerts: { ...form, webhookUrl: form.webhookUrl.trim() } }),
    onSuccess: () => {
      toast.success('Alert settings saved');
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (e) => toast.error(errMsg(e, 'Could not save the alert settings')),
  });

  return (
    <Section title="Stoppage alerts" description="Tell people when a machine has been stopped for too long with no reason recorded.">
      <div className="space-y-5">
        <label className="flex items-center gap-3 text-sm text-foreground">
          <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={form.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />
          Send alerts
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="First alert after" hint="Minutes a machine may stay stopped before anyone is told.">
            <Input type="number" min={1} max={720} value={form.stoppageMinutes} onChange={(e) => edit({ stoppageMinutes: parseInt(e.target.value) || 0 })} />
          </Field>
          <Field
            label="Escalate after"
            hint={escalationOff ? 'Escalation is off: set this higher than the first alert to turn it on.' : 'Minutes before the escalation list is told as well.'}
          >
            <Input type="number" min={0} max={1440} value={form.escalateMinutes} onChange={(e) => edit({ escalateMinutes: parseInt(e.target.value) || 0 })} />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Email the first alert to"
            hint={
              form.recipients.length === 0 && emailRecipients.length > 0
                ? `Empty: uses the report recipients (${emailRecipients.length}).`
                : 'One address per line.'
            }
          >
            <textarea className={TEXTAREA_CLASS} rows={3} value={form.recipients.join('\n')} onChange={(e) => edit({ recipients: toList(e.target.value) })} />
          </Field>
          <Field label="Also email escalations to" hint="One address per line. They are added to the first list.">
            <textarea className={TEXTAREA_CLASS} rows={3} value={form.escalationRecipients.join('\n')} onChange={(e) => edit({ escalationRecipients: toList(e.target.value) })} />
          </Field>
        </div>

        <Field
          label="Webhook address"
          hint="Optional. Each alert is posted here as JSON with a text field, which chat tools with incoming webhooks show as a message."
        >
          <Input type="url" placeholder="https://" value={form.webhookUrl} onChange={(e) => edit({ webhookUrl: e.target.value })} />
        </Field>

        {!hasSender && (form.recipients.length > 0 || form.escalationRecipients.length > 0) && (
          <p className="text-[13px] text-warning">No sender email is set under Email, so emails cannot be sent yet.</p>
        )}
        {noChannel && (
          <p className="text-[13px] text-warning">Alerts are on but have nowhere to go. Add recipients (with a sender under Email) or a webhook address.</p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-xs text-destructive">{problem}</p>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || !!problem}>Save changes</Button>
      </div>
    </Section>
  );
};

export default AlertsSettings;
