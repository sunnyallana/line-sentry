import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Plus, Edit, Trash2, Power, PowerOff, Search } from 'lucide-react';
import apiService from '../services/api';
import type { Department } from '../types';
import { useDataTable } from '../hooks/useDataTable';
import {
  Button, Input, Select, Modal, DataTable, Pagination, EmptyState, PageHeader, PageLoader, Section, Toolbar,
  StatusDot, IconButton, Field, formatNumber, type Column,
} from './ui';

const schema = z.object({
  name: z.string().min(3, 'Name must be at least 3 characters').max(50, 'Name cannot exceed 50 characters'),
  description: z.string().max(200, 'Description cannot exceed 200 characters').optional(),
});
type FormData = z.infer<typeof schema>;

const textareaClass = [
  'flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground',
  'transition-[border-color,box-shadow] duration-150 ease-out hover:border-foreground/30',
  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20',
].join(' ');

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const Departments: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['departments'] });

  const table = useDataTable<Department>({
    queryKey: 'departments',
    listKey: 'departments',
    fetcher: (params) => apiService.getDepartmentsAdmin(params),
    initialSort: { by: 'name', order: 'asc' },
  });

  // `null` = closed, 'new' = create, Department = edit.
  const [editing, setEditing] = useState<Department | 'new' | null>(null);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '' },
  });

  const openCreate = () => {
    reset({ name: '', description: '' });
    setEditing('new');
  };
  const openEdit = (d: Department) => {
    reset({ name: d.name, description: d.description || '' });
    setEditing(d);
  };

  const saveMut = useMutation({
    mutationFn: (data: FormData) =>
      editing === 'new'
        ? apiService.createDepartment(data)
        : apiService.updateDepartment((editing as Department)._id, data),
    onSuccess: () => {
      toast.success(editing === 'new' ? 'Department created' : 'Department updated');
      invalidate();
      setEditing(null);
    },
    onError: (e) => toast.error(errMsg(e, 'Could not save department')),
  });

  const toggleMut = useMutation({
    mutationFn: (d: Department) => apiService.updateDepartment(d._id, { isActive: !d.isActive }),
    onSuccess: (_data, d) => { toast.success(d.isActive ? 'Department deactivated' : 'Department activated'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Could not update department')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.deleteDepartment(id),
    onSuccess: () => { toast.success('Department deleted'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Could not delete department')),
  });

  const onDelete = (d: Department) => {
    if (window.confirm(`Delete department "${d.name}"? Its machines and molds are deleted with it. This cannot be undone.`)) {
      deleteMut.mutate(d._id);
    }
  };

  const hasFilters = Boolean(table.searchInput || table.filters.isActive);
  const clearFilters = () => {
    table.setSearch('');
    table.setFilter('isActive', '');
  };

  const columns: Column<Department>[] = [
    {
      key: 'name',
      header: 'Department',
      render: (d) => (
        <div className="min-w-0">
          <Link
            to={`/department/${d._id}`}
            className="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(e) => e.stopPropagation()}
          >
            {d.name}
          </Link>
          {d.description && <div className="max-w-md truncate text-[13px] text-muted-foreground">{d.description}</div>}
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (d) => (
      <StatusDot status={d.isActive ? 'running' : 'inactive'} label={d.isActive ? 'Active' : 'Inactive'} />
    ) },
    { key: 'machineCount', header: 'Machines', sortable: true, className: 'text-right tabular-nums', render: (d) =>
      formatNumber(d.machineCount ?? 0) },
    { key: 'createdAt', header: 'Created', sortable: true, className: 'whitespace-nowrap', render: (d) =>
      d.createdAt
        ? <span className="text-muted-foreground">{new Date(d.createdAt).toLocaleDateString()}</span>
        : <span className="text-muted-foreground">–</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'text-right',
      render: (d) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <IconButton label={`Edit ${d.name}`} onClick={() => openEdit(d)}>
            <Edit className="h-4 w-4" />
          </IconButton>
          <IconButton
            label={`${d.isActive ? 'Deactivate' : 'Activate'} ${d.name}`}
            disabled={toggleMut.isPending && toggleMut.variables?._id === d._id}
            onClick={() => toggleMut.mutate(d)}
          >
            {d.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
          </IconButton>
          <IconButton label={`Delete ${d.name}`} danger onClick={() => onDelete(d)}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Departments"
        description="The areas of the plant that machines are grouped into."
        actions={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New department</Button>}
      />

      <Section flush>
        <div className="border-b border-border px-5 py-3">
          <Toolbar>
            <Input
              className="w-64"
              aria-label="Search departments"
              placeholder="Search departments"
              icon={<Search className="h-4 w-4" />}
              value={table.searchInput}
              onChange={(e) => table.setSearch(e.target.value)}
            />
            <Select
              className="w-40"
              aria-label="Filter by status"
              value={table.filters.isActive ?? ''}
              onChange={(e) => table.setFilter('isActive', e.target.value)}
            >
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
            title="Departments could not be loaded"
            description="Check your connection and try again."
            action={<Button variant="outline" onClick={() => table.refetch()}>Try again</Button>}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={table.items}
            rowKey={(d) => d._id}
            onRowClick={(d) => navigate(`/department/${d._id}`)}
            onSort={table.toggleSort}
            empty={hasFilters ? (
              <EmptyState
                title="No departments match these filters."
                action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
              />
            ) : (
              <EmptyState
                title="No departments yet"
                description="Create a department, then add its machines to start monitoring."
                action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New department</Button>}
              />
            )}
          />
        )}
        <Pagination
          page={table.pagination?.currentPage ?? 1}
          totalPages={table.pagination?.totalPages ?? 1}
          onPage={table.setPage}
        />
      </Section>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New department' : 'Edit department'}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button form="department-form" type="submit" loading={isSubmitting || saveMut.isPending}>
              {editing === 'new' ? 'Create department' : 'Save changes'}
            </Button>
          </>
        }
      >
        <form id="department-form" className="space-y-4" onSubmit={handleSubmit((d) => saveMut.mutate(d))}>
          <Field label="Name" error={errors.name?.message}>
            <Input placeholder="e.g. Injection molding" {...register('name')} />
          </Field>
          <Field label="Description" hint="Optional. Up to 200 characters." error={errors.description?.message}>
            <textarea rows={3} className={textareaClass} {...register('description')} />
          </Field>
        </form>
      </Modal>
    </div>
  );
};

export default Departments;
