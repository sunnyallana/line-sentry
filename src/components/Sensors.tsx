import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Plus, Edit, Trash2, Power, PowerOff, Search } from 'lucide-react';
import apiService from '../services/api';
import { useDataTable } from '../hooks/useDataTable';
import {
  Button, Input, Select, Modal, DataTable, Pagination, EmptyState, PageHeader, PageLoader, Section, Toolbar,
  StatusDot, IconButton, Field, type Column,
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

const textareaClass = [
  'flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground',
  'transition-[border-color,box-shadow] duration-150 ease-out hover:border-foreground/30',
  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20',
].join(' ');

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const machineOf = (s: SensorRow) =>
  s.machineId && typeof s.machineId === 'object' ? s.machineId : null;

/** 'unit-cycle' -> 'Unit cycle' */
const typeLabel = (type: string) => {
  const words = type.replace(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const dash = <span className="text-muted-foreground">–</span>;

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
    onError: (e) => toast.error(errMsg(e, 'Could not save sensor')),
  });
  const toggleMut = useMutation({
    mutationFn: (s: SensorRow) => apiService.updateSensor(s._id, { isActive: !s.isActive }),
    onSuccess: (_data, s) => { toast.success(s.isActive ? 'Sensor deactivated' : 'Sensor activated'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Could not update sensor')),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.deleteSensor(id),
    onSuccess: () => { toast.success('Sensor deleted'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Could not delete sensor')),
  });

  const onDelete = (s: SensorRow) => {
    const machine = machineOf(s)?.name;
    const where = machine ? ` from ${machine}` : '';
    if (window.confirm(`Delete sensor "${s.name}"${where}? Its configuration is removed and cannot be recovered.`)) {
      deleteMut.mutate(s._id);
    }
  };

  const hasFilters = Boolean(
    table.searchInput || table.filters.department || table.filters.sensorType || table.filters.status,
  );
  const clearFilters = () => {
    table.setSearch('');
    table.setFilter('department', '');
    table.setFilter('sensorType', '');
    table.setFilter('status', '');
  };

  const columns: Column<SensorRow>[] = [
    { key: 'name', header: 'Sensor', sortable: true, render: (s) => (
      <div className="min-w-0">
        <div className="font-medium">{s.name}</div>
        {s.description && <div className="max-w-xs truncate text-[13px] text-muted-foreground">{s.description}</div>}
      </div>
    ) },
    { key: 'machine', header: 'Machine', render: (s) => machineOf(s)?.name ?? dash },
    { key: 'department', header: 'Department', render: (s) => machineOf(s)?.departmentId?.name ?? dash },
    { key: 'sensorType', header: 'Type', render: (s) => typeLabel(s.sensorType) },
    { key: 'status', header: 'Status', render: (s) => (
      <StatusDot status={s.isActive ? 'running' : 'inactive'} label={s.isActive ? 'Active' : 'Inactive'} />
    ) },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right',
      render: (s) => (
        <div className="flex justify-end gap-1">
          <IconButton label={`Edit ${s.name}`} onClick={() => openEdit(s)}><Edit className="h-4 w-4" /></IconButton>
          <IconButton
            label={`${s.isActive ? 'Deactivate' : 'Activate'} ${s.name}`}
            disabled={toggleMut.isPending && toggleMut.variables?._id === s._id}
            onClick={() => toggleMut.mutate(s)}
          >
            {s.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
          </IconButton>
          <IconButton label={`Delete ${s.name}`} danger onClick={() => onDelete(s)}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sensors"
        description="The signals each machine reports, such as power and unit cycles."
        actions={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New sensor</Button>}
      />

      <Section flush>
        <div className="border-b border-border px-5 py-3">
          <Toolbar>
            <Input
              className="w-64"
              aria-label="Search sensors"
              placeholder="Search sensors"
              icon={<Search className="h-4 w-4" />}
              value={table.searchInput}
              onChange={(e) => table.setSearch(e.target.value)}
            />
            <Select className="w-44" aria-label="Filter by department" value={table.filters.department ?? ''} onChange={(e) => table.setFilter('department', e.target.value)}>
              <option value="">All departments</option>
              {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
            </Select>
            <Select className="w-40" aria-label="Filter by type" value={table.filters.sensorType ?? ''} onChange={(e) => table.setFilter('sensorType', e.target.value)}>
              <option value="">All types</option>
              {SENSOR_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
            </Select>
            <Select className="w-40" aria-label="Filter by status" value={table.filters.status ?? ''} onChange={(e) => table.setFilter('status', e.target.value)}>
              <option value="">All statuses</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </Select>
          </Toolbar>
        </div>

        {table.isLoading ? (
          <PageLoader />
        ) : table.isError ? (
          <EmptyState
            title="Sensors could not be loaded"
            description="Check your connection and try again."
            action={<Button variant="outline" onClick={() => table.refetch()}>Try again</Button>}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={table.items}
            rowKey={(s) => s._id}
            onSort={table.toggleSort}
            empty={hasFilters ? (
              <EmptyState
                title="No sensors match these filters."
                action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
              />
            ) : (
              <EmptyState
                title="No sensors yet"
                description="Wire a machine's signals in Setup to create its sensors."
                action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New sensor</Button>}
              />
            )}
          />
        )}
        <Pagination page={table.pagination?.currentPage ?? 1} totalPages={table.pagination?.totalPages ?? 1} onPage={table.setPage} />
      </Section>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New sensor' : 'Edit sensor'}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button form="sensor-form" type="submit" loading={isSubmitting || saveMut.isPending}>
              {editing === 'new' ? 'Create sensor' : 'Save changes'}
            </Button>
          </>
        }
      >
        <form id="sensor-form" className="space-y-4" onSubmit={handleSubmit((d) => saveMut.mutate(d))}>
          <Field label="Name" error={errors.name?.message}>
            <Input placeholder="e.g. Press 4 power" {...register('name')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Department">
              <Select
                value={formDept}
                onChange={(e) => { setFormDept(e.target.value); setValue('machineId', ''); }}
              >
                <option value="">Select a department</option>
                {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
              </Select>
            </Field>
            <Field
              label="Machine"
              hint={!formDept ? 'Choose a department first.' : undefined}
              error={errors.machineId?.message}
            >
              <Select disabled={!formDept} {...register('machineId')}>
                <option value="">Select a machine</option>
                {machineOptions.map((m) => <option key={m._id} value={m._id}>{m.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Type">
            <Select {...register('sensorType')}>
              {SENSOR_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
            </Select>
          </Field>
          <Field label="Description" hint="Optional. Up to 200 characters." error={errors.description?.message}>
            <textarea rows={3} className={textareaClass} {...register('description')} />
          </Field>
        </form>
      </Modal>
    </div>
  );
};

export default Sensors;
