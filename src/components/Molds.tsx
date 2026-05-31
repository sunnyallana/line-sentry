import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { PackageOpen, Plus, Edit, Trash2, Power, PowerOff, Search } from 'lucide-react';
import apiService from '../services/api';
import type { Mold, Department } from '../types';
import { useDataTable } from '../hooks/useDataTable';
import {
  Button, Input, Label, Select, Badge, Card, Modal, DataTable, Pagination, EmptyState, type Column,
} from './ui';

const schema = z.object({
  name: z.string().min(3, 'Name must be at least 3 characters').max(50, 'Name cannot exceed 50 characters'),
  description: z.string().max(200, 'Description cannot exceed 200 characters').optional(),
  productionCapacityPerHour: z.number().positive('Capacity must be a positive number'),
  departmentId: z.string().nonempty('Department is required'),
});
type FormData = z.infer<typeof schema>;

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
type Pop = { _id: string; name: string };
const deptOf = (m: Mold): Pop | null =>
  m.departmentId && typeof m.departmentId === 'object' ? (m.departmentId as unknown as Pop) : null;

const Molds: React.FC = () => {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['molds'] });

  const table = useDataTable<Mold>({
    queryKey: 'molds',
    listKey: 'molds',
    fetcher: (params) => apiService.getMoldsAdmin(params),
    initialSort: { by: 'name', order: 'asc' },
  });

  const departments = useQuery<Department[]>({
    queryKey: ['departments', 'options'],
    queryFn: () => apiService.getDepartments(),
  });

  const [editing, setEditing] = useState<Mold | 'new' | null>(null);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '', productionCapacityPerHour: undefined, departmentId: '' },
  });

  const openCreate = () => {
    reset({ name: '', description: '', productionCapacityPerHour: undefined, departmentId: '' });
    setEditing('new');
  };
  const openEdit = (m: Mold) => {
    reset({
      name: m.name,
      description: m.description || '',
      productionCapacityPerHour: m.productionCapacityPerHour,
      departmentId: deptOf(m)?._id ?? String(m.departmentId ?? ''),
    });
    setEditing(m);
  };

  const saveMut = useMutation({
    mutationFn: (data: FormData) =>
      editing === 'new' ? apiService.createMold(data) : apiService.updateMold((editing as Mold)._id, data),
    onSuccess: () => {
      toast.success(editing === 'new' ? 'Mold created' : 'Mold updated');
      invalidate();
      setEditing(null);
    },
    onError: (e) => toast.error(errMsg(e, 'Save failed')),
  });
  const toggleMut = useMutation({
    mutationFn: (m: Mold) => apiService.toggleMoldStatus(m._id),
    onSuccess: () => { toast.success('Status updated'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Update failed')),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.deleteMold(id),
    onSuccess: () => { toast.success('Mold deleted'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Delete failed')),
  });
  const onDelete = (m: Mold) => {
    if (window.confirm('Delete this mold? This cannot be undone.')) deleteMut.mutate(m._id);
  };

  const columns: Column<Mold>[] = [
    { key: 'name', header: 'Mold', render: (m) => (
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <PackageOpen className="h-5 w-5" />
        </div>
        <span className="font-medium text-foreground">{m.name}</span>
      </div>
    ) },
    { key: 'department', header: 'Department', render: (m) => deptOf(m)?.name ?? '—' },
    { key: 'productionCapacityPerHour', header: 'Capacity', sortable: true, render: (m) =>
      `${m.productionCapacityPerHour} /hr` },
    { key: 'status', header: 'Status', render: (m) => (
      <Badge variant={m.isActive ? 'success' : 'muted'}>{m.isActive ? 'Active' : 'Inactive'}</Badge>
    ) },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (m) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => openEdit(m)}><Edit className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" aria-label={m.isActive ? 'Deactivate' : 'Activate'} onClick={() => toggleMut.mutate(m)}>
            {m.isActive ? <PowerOff className="h-4 w-4 text-warning" /> : <Power className="h-4 w-4 text-success" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => onDelete(m)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Molds</h1>
          <p className="text-muted-foreground">Define molds and their ideal production capacity</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            className="w-full sm:w-64" placeholder="Search molds…" icon={<Search className="h-4 w-4" />}
            value={table.searchInput} onChange={(e) => table.setSearch(e.target.value)}
          />
          <Select className="w-44" value={table.filters.department ?? ''} onChange={(e) => table.setFilter('department', e.target.value)}>
            <option value="">All departments</option>
            {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </Select>
          <Select className="w-36" value={table.filters.isActive ?? ''} onChange={(e) => table.setFilter('isActive', e.target.value)}>
            <option value="">All status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
          <Button onClick={openCreate}><Plus className="h-4 w-4" /> New Mold</Button>
        </div>
      </div>

      <Card className="p-4">
        <DataTable
          columns={columns}
          rows={table.items}
          rowKey={(m) => m._id}
          onSort={table.toggleSort}
          empty={<EmptyState icon={<PackageOpen className="h-8 w-8" />} title="No molds found" description="Create a mold to enable performance/OEE calculations." action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New Mold</Button>} />}
        />
        <Pagination page={table.pagination?.currentPage ?? 1} totalPages={table.pagination?.totalPages ?? 1} onPage={table.setPage} />
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Create mold' : 'Edit mold'}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button form="mold-form" type="submit" loading={isSubmitting || saveMut.isPending}>{editing === 'new' ? 'Create' : 'Save'}</Button>
          </>
        }
      >
        <form id="mold-form" className="space-y-4" onSubmit={handleSubmit((d) => saveMut.mutate(d))}>
          <div>
            <Label htmlFor="name">Mold name *</Label>
            <Input id="name" {...register('name')} />
            {errors.name && <p className="mt-1 text-sm text-destructive">{errors.name.message}</p>}
          </div>
          <div>
            <Label htmlFor="capacity">Production capacity (units/hour) *</Label>
            <Input id="capacity" type="number" min={1} {...register('productionCapacityPerHour', { valueAsNumber: true })} />
            {errors.productionCapacityPerHour && <p className="mt-1 text-sm text-destructive">{errors.productionCapacityPerHour.message}</p>}
          </div>
          <div>
            <Label htmlFor="departmentId">Department *</Label>
            <Select id="departmentId" {...register('departmentId')}>
              <option value="">Select a department…</option>
              {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
            </Select>
            {errors.departmentId && <p className="mt-1 text-sm text-destructive">{errors.departmentId.message}</p>}
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

export default Molds;
