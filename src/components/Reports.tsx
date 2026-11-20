import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Download, Mail, Trash2 } from 'lucide-react';
import apiService from '../services/api';
import type { Department, Machine } from '../types';
import {
  Button, DataTable, EmptyState, Field, IconButton, Input, Modal, PageHeader, PageLoader, Section, Select, Toolbar,
  type Column,
} from './ui';

type ReportType = 'daily' | 'weekly' | 'monthly' | 'yearly';

interface Report {
  _id: string;
  type: ReportType;
  period: { start: string; end: string };
  departmentId?: { name: string };
  machineId?: { name: string };
  metrics: { oee: number; mtbf: number; mttr: number };
  generatedBy?: { username?: string };
  emailSent: boolean;
  createdAt: string;
}

const TYPES: { value: ReportType; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];
const GENERATE_FORM_ID = 'generate-report-form';

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const today = () => new Date().toISOString().split('T')[0];
const typeLabel = (t: string) => TYPES.find((x) => x.value === t)?.label ?? t;

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
// A report period is stored as factory days, so it is read back without
// shifting it into the viewer's time zone (which would turn one day into two).
const periodFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const formatPeriodDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : periodFormat.format(d);
};
const formatDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : dateFormat.format(d);
};
const formatPeriod = (p: Report['period']) => {
  const start = formatPeriodDate(p.start);
  const end = formatPeriodDate(p.end);
  return start === end ? start : `${start} to ${end}`;
};
const formatMetric = (value: number | undefined | null, unit: string) =>
  value ? `${value}${unit}` : '–';

const Reports: React.FC = () => {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['reports'] });

  const [filters, setFilters] = useState({ type: '', departmentId: '' });
  const [form, setForm] = useState({ type: 'daily' as ReportType, startDate: today(), endDate: today(), departmentId: '', machineId: '' });
  const [generateOpen, setGenerateOpen] = useState(false);

  const reports = useQuery<Report[]>({ queryKey: ['reports', filters], queryFn: () => apiService.getReports(filters) });
  const departments = useQuery<Department[]>({ queryKey: ['departments', 'options'], queryFn: () => apiService.getDepartments() });
  const machines = useQuery<Machine[]>({ queryKey: ['machines', 'options'], queryFn: () => apiService.getMachines() });

  const generateMut = useMutation({
    mutationFn: () => apiService.generateReport(form),
    onSuccess: () => {
      toast.success('Report generated');
      invalidate();
      setForm({ type: 'daily', startDate: today(), endDate: today(), departmentId: '', machineId: '' });
      setGenerateOpen(false);
    },
    onError: (e) => toast.error(errMsg(e, 'Failed to generate report')),
  });
  const emailMut = useMutation({
    mutationFn: (id: string) => apiService.emailReport(id),
    onSuccess: () => { toast.success('Report emailed'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Failed to email report')),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.request(`/reports/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.success('Report deleted'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Failed to delete report')),
  });

  const datesInvalid = new Date(form.startDate) > new Date(form.endDate);

  const onGenerate = (e: React.FormEvent) => {
    e.preventDefault();
    if (datesInvalid) {
      toast.error('Start date cannot be after end date');
      return;
    }
    generateMut.mutate();
  };

  const download = (r: Report) =>
    apiService
      .downloadReportPDF(r._id, r.type, r.period.start.split('T')[0])
      .then(() => toast.success('PDF downloaded'))
      .catch((e) => toast.error(errMsg(e, 'Download failed')));

  const columns: Column<Report>[] = [
    { key: 'report', header: 'Report', render: (r) => (
      <div className="min-w-0">
        <p className="font-medium text-foreground">{typeLabel(r.type)}</p>
        <p className="text-xs text-muted-foreground">
          {r.departmentId?.name || 'All departments'} · {r.machineId?.name || 'All machines'}
        </p>
      </div>
    ) },
    { key: 'period', header: 'Period', className: 'whitespace-nowrap', render: (r) => formatPeriod(r.period) },
    { key: 'oee', header: 'OEE', className: 'tabular whitespace-nowrap text-right', render: (r) => formatMetric(r.metrics?.oee, '%') },
    { key: 'mtbf', header: 'MTBF', className: 'tabular whitespace-nowrap text-right', render: (r) => formatMetric(r.metrics?.mtbf, ' min') },
    { key: 'mttr', header: 'MTTR', className: 'tabular whitespace-nowrap text-right', render: (r) => formatMetric(r.metrics?.mttr, ' min') },
    { key: 'generated', header: 'Generated', className: 'whitespace-nowrap', render: (r) => (
      <div>
        <p className="text-foreground">{formatDate(r.createdAt)}</p>
        <p className="text-xs text-muted-foreground">
          {r.generatedBy?.username ? `by ${r.generatedBy.username}` : 'Automatic'}
          {r.emailSent && ' · emailed'}
        </p>
      </div>
    ) },
    { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (r) => (
      <div className="flex justify-end gap-0.5">
        <IconButton label="Download PDF" onClick={() => download(r)}>
          <Download className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={r.emailSent ? 'Email again' : 'Email report'}
          disabled={emailMut.isPending && emailMut.variables === r._id}
          onClick={() => emailMut.mutate(r._id)}
        >
          <Mail className="h-4 w-4" />
        </IconButton>
        <IconButton label="Delete report" danger onClick={() => window.confirm('Delete this report?') && deleteMut.mutate(r._id)}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>
    ) },
  ];

  const rows = reports.data ?? [];
  const filtered = Boolean(filters.type || filters.departmentId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Generate OEE, MTBF and MTTR reports as PDF, and email them."
        actions={<Button onClick={() => setGenerateOpen(true)}>Generate report</Button>}
      />

      <Section flush>
        <Toolbar className="border-b border-border px-5 py-3">
          <Select
            aria-label="Filter by type"
            className="w-40"
            value={filters.type}
            onChange={(e) => setFilters({ ...filters, type: e.target.value })}
          >
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          <Select
            aria-label="Filter by department"
            className="w-48"
            value={filters.departmentId}
            onChange={(e) => setFilters({ ...filters, departmentId: e.target.value })}
          >
            <option value="">All departments</option>
            {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </Select>
        </Toolbar>

        {reports.isLoading ? (
          <PageLoader label="Loading reports…" />
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState title="No reports match these filters" description="Change the type or department above to see more." />
          ) : (
            <EmptyState
              title="No reports yet"
              description="Generate a report, or switch on the daily report in Settings."
              action={<Button onClick={() => setGenerateOpen(true)}>Generate report</Button>}
            />
          )
        ) : (
          <DataTable columns={columns} rows={rows} rowKey={(r) => r._id} />
        )}
      </Section>

      <Modal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        title="Generate report"
        description="The report is saved to this list. You can then download it or email it."
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setGenerateOpen(false)}>Cancel</Button>
            <Button type="submit" form={GENERATE_FORM_ID} loading={generateMut.isPending}>Generate report</Button>
          </>
        }
      >
        <form id={GENERATE_FORM_ID} onSubmit={onGenerate} className="space-y-4">
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ReportType })}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Start date">
              <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </Field>
            <Field label="End date" error={datesInvalid ? 'Must be on or after the start date.' : undefined}>
              <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </Field>
          </div>
          <Field label="Department (optional)">
            <Select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
              <option value="">All departments</option>
              {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label="Machine (optional)">
            <Select value={form.machineId} onChange={(e) => setForm({ ...form, machineId: e.target.value })}>
              <option value="">All machines</option>
              {(machines.data ?? []).map((m) => <option key={m._id} value={m._id}>{m.name}</option>)}
            </Select>
          </Field>
        </form>
      </Modal>
    </div>
  );
};

export default Reports;
