import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Plus, Edit, Trash2, Power, PowerOff, Search } from 'lucide-react';
import apiService from '../services/api';
import type { Mold, Department } from '../types';
import { useDataTable } from '../hooks/useDataTable';
import {
  Button, Input, Select, Modal, DataTable, Pagination, EmptyState, PageHeader, PageLoader, Section, Toolbar,
  StatusDot, IconButton, Field, formatNumber, type Column,
} from './ui';

const schema = z.object({
  name: z.string().min(3, 'Name must be at least 3 characters').max(50, 'Name cannot exceed 50 characters'),
  description: z.string().max(200, 'Description cannot exceed 200 characters').optional(),
  productionCapacityPerHour: z.number().positive('Capacity must be a positive number'),
  departmentId: z.string().nonempty('Department is required'),
});
type FormData = z.infer<typeof schema>;

const textareaClass = [
  'flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground',
  'transition-[border-color,box-shadow] duration-150 ease-out hover:border-foreground/30',
  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20',
].join(' ');

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
    onError: (e) => toast.error(errMsg(e, 'Could not save mold')),
  });
  const toggleMut = useMutation({
    mutationFn: (m: Mold) => apiService.toggleMoldStatus(m._id),
    onSuccess: (_data, m) => { toast.success(m.isActive ? 'Mold deactivated' : 'Mold activated'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Could not update mold')),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.deleteMold(id),
    onSuccess: () => { toast.success('Mold deleted'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Could not delete mold')),
  });
  const onDelete = (m: Mold) => {
    if (window.confirm(`Delete mold "${m.name}"? Its capacity setting is removed and cannot be recovered.`)) {
      deleteMut.mutate(m._id);
    }
  };

  const hasFilters = Boolean(table.searchInput || table.filters.department || table.filters.isActive);
  const clearFilters = () => {
    table.setSearch('');
    table.setFilter('department', '');
    table.setFilter('isActive', '');
  };

  const columns: Column<Mold>[] = [
    { key: 'name', header: 'Mold', render: (m) => (
      <div className="min-w-0">
        <div className="font-medium">{m.name}</div>
        {m.description && <div className="max-w-xs truncate text-[13px] text-muted-foreground">{m.description}</div>}
      </div>
    ) },
    { key: 'department', header: 'Department', render: (m) => deptOf(m)?.name ?? <span className="text-muted-foreground">–</span> },
    { key: 'productionCapacityPerHour', header: 'Capacity (units/hour)', sortable: true, className: 'text-right tabular-nums', render: (m) =>
      formatNumber(m.productionCapacityPerHour) },
    { key: 'status', header: 'Status', render: (m) => (
      <StatusDot status={m.isActive ? 'running' : 'inactive'} label={m.isActive ? 'Active' : 'Inactive'} />
    ) },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right',
      render: (m) => (
        <div className="flex justify-end gap-1">
          <IconButton label={`Edit ${m.name}`} onClick={() => openEdit(m)}><Edit className="h-4 w-4" /></IconButton>
          <IconButton
            label={`${m.isActive ? 'Deactivate' : 'Activate'} ${m.name}`}
            disabled={toggleMut.isPending && toggleMut.variables?._id === m._id}
            onClick={() => toggleMut.mutate(m)}
          >
            {m.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
          </IconButton>
          <IconButton label={`Delete ${m.name}`} danger onClick={() => onDelete(m)}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Molds"
        description="Each mold's ideal output per hour, used to measure performance."
        actions={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New mold</Button>}
      />

      <Section flush>
        <div className="border-b border-border px-5 py-3">
          <Toolbar>
            <Input
              className="w-64"
              aria-label="Search molds"
              placeholder="Search molds"
              icon={<Search className="h-4 w-4" />}
              value={table.searchInput}
              onChange={(e) => table.setSearch(e.target.value)}
            />
            <Select className="w-44" aria-label="Filter by department" value={table.filters.department ?? ''} onChange={(e) => table.setFilter('department', e.target.value)}>
              <option value="">All departments</option>
              {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
            </Select>
            <Select className="w-40" aria-label="Filter by status" value={table.filters.isActive ?? ''} onChange={(e) => table.setFilter('isActive', e.target.value)}>
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
            title="Molds could not be loaded"
            description="Check your connection and try again."
            action={<Button variant="outline" onClick={() => table.refetch()}>Try again</Button>}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={table.items}
            rowKey={(m) => m._id}
            onSort={table.toggleSort}
            empty={hasFilters ? (
              <EmptyState
                title="No molds match these filters."
                action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
              />
            ) : (
              <EmptyState
                title="No molds yet"
                description="Create a mold so performance and OEE can be calculated against its capacity."
                action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New mold</Button>}
              />
            )}
          />
        )}
        <Pagination page={table.pagination?.currentPage ?? 1} totalPages={table.pagination?.totalPages ?? 1} onPage={table.setPage} />
      </Section>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New mold' : 'Edit mold'}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button form="mold-form" type="submit" loading={isSubmitting || saveMut.isPending}>
              {editing === 'new' ? 'Create mold' : 'Save changes'}
            </Button>
          </>
        }
      >
        <form id="mold-form" className="space-y-4" onSubmit={handleSubmit((d) => saveMut.mutate(d))}>
          <Field label="Name" error={errors.name?.message}>
            <Input {...register('name')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Capacity"
              hint="Ideal units per hour."
              error={errors.productionCapacityPerHour?.message}
            >
              <Input type="number" min={1} inputMode="numeric" {...register('productionCapacityPerHour', { valueAsNumber: true })} />
            </Field>
            <Field label="Department" error={errors.departmentId?.message}>
              <Select {...register('departmentId')}>
                <option value="">Select a department</option>
                {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Description" hint="Optional. Up to 200 characters." error={errors.description?.message}>
            <textarea rows={3} className={textareaClass} {...register('description')} />
          </Field>
        </form>
      </Modal>
    </div>
  );
};

export default Molds;
