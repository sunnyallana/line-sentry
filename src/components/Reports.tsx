import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { FileText, Download, Mail, Trash2, RefreshCw } from 'lucide-react';
import apiService from '../services/api';
import type { Department, Machine } from '../types';
import {
  Button, Input, Label, Select, Badge, Card, CardHeader, CardTitle, DataTable, PageLoader, type Column,
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

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const typeVariant = (t: string) =>
  t === 'daily' ? 'info' : t === 'weekly' ? 'success' : t === 'monthly' ? 'warning' : 'default';
const today = () => new Date().toISOString().split('T')[0];

const Reports: React.FC = () => {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['reports'] });

  const [filters, setFilters] = useState({ type: '', departmentId: '' });
  const [form, setForm] = useState({ type: 'daily' as ReportType, startDate: today(), endDate: today(), departmentId: '', machineId: '' });

  const reports = useQuery<Report[]>({ queryKey: ['reports', filters], queryFn: () => apiService.getReports(filters) });
  const departments = useQuery<Department[]>({ queryKey: ['departments', 'options'], queryFn: () => apiService.getDepartments() });
  const machines = useQuery<Machine[]>({ queryKey: ['machines', 'options'], queryFn: () => apiService.getMachines() });

  const generateMut = useMutation({
    mutationFn: () => apiService.generateReport(form),
    onSuccess: () => {
      toast.success('Report generated');
      invalidate();
      setForm({ type: 'daily', startDate: today(), endDate: today(), departmentId: '', machineId: '' });
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

  const onGenerate = (e: React.FormEvent) => {
    e.preventDefault();
    if (new Date(form.startDate) > new Date(form.endDate)) {
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
      <div className="flex items-center gap-3">
        <FileText className="h-7 w-7 shrink-0 text-primary" />
        <div>
          <div className="flex items-center gap-2">
            <Badge variant={typeVariant(r.type)} className="uppercase">{r.type}</Badge>
            {r.emailSent && <Badge variant="success">Emailed</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {r.departmentId?.name || 'All departments'} · {r.machineId?.name || 'All machines'}
          </p>
        </div>
      </div>
    ) },
    { key: 'period', header: 'Period', render: (r) =>
      `${new Date(r.period.start).toLocaleDateString()} – ${new Date(r.period.end).toLocaleDateString()}` },
    { key: 'metrics', header: 'Key metrics', render: (r) => (
      <div className="flex gap-4 text-xs">
        <div className="text-center"><div className="font-semibold text-warning">{r.metrics.oee}%</div><div className="text-muted-foreground">OEE</div></div>
        <div className="text-center"><div className="font-semibold text-info">{r.metrics.mtbf}m</div><div className="text-muted-foreground">MTBF</div></div>
        <div className="text-center"><div className="font-semibold text-primary">{r.metrics.mttr}m</div><div className="text-muted-foreground">MTTR</div></div>
      </div>
    ) },
    { key: 'generated', header: 'Generated', render: (r) => (
      <div>
        <div className="text-foreground">{new Date(r.createdAt).toLocaleDateString()}</div>
        <div className="text-xs text-muted-foreground">by {r.generatedBy?.username || 'System'}</div>
      </div>
    ) },
    { key: 'actions', header: '', className: 'text-right', render: (r) => (
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="icon" aria-label="Download PDF" onClick={() => download(r)}><Download className="h-4 w-4 text-info" /></Button>
        <Button variant="ghost" size="icon" aria-label="Email report" loading={emailMut.isPending && emailMut.variables === r._id} onClick={() => emailMut.mutate(r._id)}><Mail className="h-4 w-4 text-success" /></Button>
        <Button variant="ghost" size="icon" aria-label="Delete report" onClick={() => window.confirm('Delete this report?') && deleteMut.mutate(r._id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
      </div>
    ) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Production Reports</h1>
        <p className="text-muted-foreground">Generate and manage OEE, MTTR, and MTBF reports</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Generate new report</CardTitle></CardHeader>
        <form onSubmit={onGenerate} className="space-y-4 p-6 pt-0">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
            <div>
              <Label>Type</Label>
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ReportType })}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </Select>
            </div>
            <div><Label>Start date</Label><Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></div>
            <div><Label>End date</Label><Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></div>
            <div>
              <Label>Department (optional)</Label>
              <Select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                <option value="">All departments</option>
                {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>Machine (optional)</Label>
              <Select value={form.machineId} onChange={(e) => setForm({ ...form, machineId: e.target.value })}>
                <option value="">All machines</option>
                {(machines.data ?? []).map((m) => <option key={m._id} value={m._id}>{m.name}</option>)}
              </Select>
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={generateMut.isPending}>
              {generateMut.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Generate report
            </Button>
          </div>
        </form>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Select className="w-40" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
          <option value="">All types</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </Select>
        <Select className="w-48" value={filters.departmentId} onChange={(e) => setFilters({ ...filters, departmentId: e.target.value })}>
          <option value="">All departments</option>
          {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
        </Select>
      </div>

      <Card className="p-4">
        {reports.isLoading ? (
          <PageLoader label="Loading reports…" />
        ) : (
          <DataTable
            columns={columns}
            rows={reports.data ?? []}
            rowKey={(r) => r._id}
            empty="No reports yet — generate your first one above."
          />
        )}
      </Card>
    </div>
  );
};

export default Reports;
