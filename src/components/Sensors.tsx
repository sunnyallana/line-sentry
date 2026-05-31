import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Cpu, Plus, Edit, Trash2, Power, PowerOff, Search } from 'lucide-react';
import apiService from '../services/api';
import { useDataTable } from '../hooks/useDataTable';
import {
  Button, Input, Label, Select, Badge, Card, Modal, DataTable, Pagination, EmptyState, type Column,
} from './ui';

const SENSOR_TYPES = ['power', 'unit-cycle', 'temperature', 'pressure', 'vibration'] as const;

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(50, 'Name cannot exceed 50 characters'),
  description: z.string().max(200, 'Description cannot exceed 200 characters').optional(),
  machineId: z.string().min(1, 'Machine is required'),
  sensorType: z.enum(SENSOR_TYPES),
});
type FormData = z.infer<typeof schema>;

interface MachineLite { _id: string; name: string }
interface DeptWithMachines { _id: string; name: string; machines?: MachineLite[] }
interface SensorRow {
  _id: string;
  name: string;
  description?: string;
  sensorType: string;
  isActive: boolean;
  machineId?: { _id: string; name: string; departmentId?: { _id: string; name: string } } | string;
}

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const machineOf = (s: SensorRow) =>
  s.machineId && typeof s.machineId === 'object' ? s.machineId : null;

const Sensors: React.FC = () => {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['sensors'] });

  const table = useDataTable<SensorRow>({
    queryKey: 'sensors',
    listKey: 'sensors',
    fetcher: (params) => apiService.getSensorsAdmin(params),
    initialSort: { by: 'name', order: 'asc' },
  });
  const departments = useQuery<DeptWithMachines[]>({
    queryKey: ['departments', 'with-machines'],
    queryFn: () => apiService.getDepartments(),
  });

  const [editing, setEditing] = useState<SensorRow | 'new' | null>(null);
  const [formDept, setFormDept] = useState('');
  const { register, handleSubmit, reset, setValue, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '', machineId: '', sensorType: 'power' },
  });

  const machineOptions = departments.data?.find((d) => d._id === formDept)?.machines ?? [];

  const openCreate = () => {
    setFormDept('');
    reset({ name: '', description: '', machineId: '', sensorType: 'power' });
    setEditing('new');
  };
  const openEdit = (s: SensorRow) => {
    const m = machineOf(s);
    setFormDept(m?.departmentId?._id ?? '');
    reset({
      name: s.name,
      description: s.description || '',
      machineId: m?._id ?? (typeof s.machineId === 'string' ? s.machineId : ''),
      sensorType: (SENSOR_TYPES as readonly string[]).includes(s.sensorType) ? (s.sensorType as FormData['sensorType']) : 'power',
    });
    setEditing(s);
  };

  const saveMut = useMutation({
    mutationFn: (data: FormData) =>
      editing === 'new' ? apiService.createSensor(data) : apiService.updateSensor((editing as SensorRow)._id, data),
    onSuccess: () => {
      toast.success(editing === 'new' ? 'Sensor created' : 'Sensor updated');
      invalidate();
      setEditing(null);
    },
    onError: (e) => toast.error(errMsg(e, 'Save failed')),
  });
  const toggleMut = useMutation({
    mutationFn: (s: SensorRow) => apiService.updateSensor(s._id, { isActive: !s.isActive }),
    onSuccess: () => { toast.success('Status updated'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Update failed')),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.deleteSensor(id),
    onSuccess: () => { toast.success('Sensor deleted'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Delete failed')),
  });

  const columns: Column<SensorRow>[] = [
    { key: 'name', header: 'Sensor', sortable: true, render: (s) => (
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Cpu className="h-5 w-5" />
        </div>
        <span className="font-medium text-foreground">{s.name}</span>
      </div>
    ) },
    { key: 'machine', header: 'Machine', render: (s) => machineOf(s)?.name ?? '—' },
    { key: 'department', header: 'Department', render: (s) => machineOf(s)?.departmentId?.name ?? '—' },
    { key: 'sensorType', header: 'Type', render: (s) => (
      <Badge variant={s.sensorType === 'power' ? 'info' : s.sensorType === 'unit-cycle' ? 'success' : 'muted'}>
        {s.sensorType}
      </Badge>
    ) },
    { key: 'status', header: 'Status', render: (s) => (
      <Badge variant={s.isActive ? 'success' : 'muted'}>{s.isActive ? 'Active' : 'Inactive'}</Badge>
    ) },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (s) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => openEdit(s)}><Edit className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" aria-label={s.isActive ? 'Deactivate' : 'Activate'} onClick={() => toggleMut.mutate(s)}>
            {s.isActive ? <PowerOff className="h-4 w-4 text-warning" /> : <Power className="h-4 w-4 text-success" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => window.confirm('Delete this sensor?') && deleteMut.mutate(s._id)}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sensors</h1>
          <p className="text-muted-foreground">Configure machine sensors (power / unit-cycle)</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input className="w-full sm:w-64" placeholder="Search sensors…" icon={<Search className="h-4 w-4" />} value={table.searchInput} onChange={(e) => table.setSearch(e.target.value)} />
          <Select className="w-44" value={table.filters.department ?? ''} onChange={(e) => table.setFilter('department', e.target.value)}>
            <option value="">All departments</option>
            {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </Select>
          <Select className="w-36" value={table.filters.sensorType ?? ''} onChange={(e) => table.setFilter('sensorType', e.target.value)}>
            <option value="">All types</option>
            {SENSOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
          <Select className="w-32" value={table.filters.status ?? ''} onChange={(e) => table.setFilter('status', e.target.value)}>
            <option value="">All status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
          <Button onClick={openCreate}><Plus className="h-4 w-4" /> New Sensor</Button>
        </div>
      </div>

      <Card className="p-4">
        <DataTable
          columns={columns}
          rows={table.items}
          rowKey={(s) => s._id}
          onSort={table.toggleSort}
          empty={<EmptyState icon={<Cpu className="h-8 w-8" />} title="No sensors found" action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New Sensor</Button>} />}
        />
        <Pagination page={table.pagination?.currentPage ?? 1} totalPages={table.pagination?.totalPages ?? 1} onPage={table.setPage} />
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Create sensor' : 'Edit sensor'}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button form="sensor-form" type="submit" loading={isSubmitting || saveMut.isPending}>{editing === 'new' ? 'Create' : 'Save'}</Button>
          </>
        }
      >
        <form id="sensor-form" className="space-y-4" onSubmit={handleSubmit((d) => saveMut.mutate(d))}>
          <div>
            <Label htmlFor="name">Sensor name *</Label>
            <Input id="name" {...register('name')} />
            {errors.name && <p className="mt-1 text-sm text-destructive">{errors.name.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="dept">Department *</Label>
              <Select
                id="dept"
                value={formDept}
                onChange={(e) => { setFormDept(e.target.value); setValue('machineId', ''); }}
              >
                <option value="">Select…</option>
                {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="machineId">Machine *</Label>
              <Select id="machineId" disabled={!formDept} {...register('machineId')}>
                <option value="">Select…</option>
                {machineOptions.map((m) => <option key={m._id} value={m._id}>{m.name}</option>)}
              </Select>
              {errors.machineId && <p className="mt-1 text-sm text-destructive">{errors.machineId.message}</p>}
            </div>
          </div>
          <div>
            <Label htmlFor="sensorType">Sensor type *</Label>
            <Select id="sensorType" {...register('sensorType')}>
              {SENSOR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <textarea id="description" rows={3} className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" {...register('description')} />
            {errors.description && <p className="mt-1 text-sm text-destructive">{errors.description.message}</p>}
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default Sensors;
