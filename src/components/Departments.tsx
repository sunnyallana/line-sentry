import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Building2, Plus, Edit, Trash2, Power, PowerOff, Search } from 'lucide-react';
import apiService from '../services/api';
import type { Department } from '../types';
import { useDataTable } from '../hooks/useDataTable';
import {
  Button, Input, Label, Select, Badge, Card, Modal, DataTable, Pagination, EmptyState, type Column,
} from './ui';

const schema = z.object({
  name: z.string().min(3, 'Name must be at least 3 characters').max(50, 'Name cannot exceed 50 characters'),
  description: z.string().max(200, 'Description cannot exceed 200 characters').optional(),
});
type FormData = z.infer<typeof schema>;

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
    onError: (e) => toast.error(errMsg(e, 'Save failed')),
  });

  const toggleMut = useMutation({
    mutationFn: (d: Department) => apiService.updateDepartment(d._id, { isActive: !d.isActive }),
    onSuccess: () => { toast.success('Status updated'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Update failed')),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.deleteDepartment(id),
    onSuccess: () => { toast.success('Department deleted'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Delete failed')),
  });

  const onDelete = (d: Department) => {
    if (window.confirm('Permanently delete this department? This also deletes its machines and molds and cannot be undone.')) {
      deleteMut.mutate(d._id);
    }
  };

  const columns: Column<Department>[] = [
    {
      key: 'name',
      header: 'Department',
      render: (d) => (
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Building2 className="h-5 w-5" />
          </div>
          <span className="font-medium text-foreground">{d.name}</span>
        </div>
      ),
    },
    { key: 'description', header: 'Description', render: (d) => (
      <span className="block max-w-xs truncate text-muted-foreground">{d.description || '—'}</span>
    ) },
    { key: 'status', header: 'Status', render: (d) => (
      <Badge variant={d.isActive ? 'success' : 'muted'}>{d.isActive ? 'Active' : 'Inactive'}</Badge>
    ) },
    { key: 'machineCount', header: 'Machines', sortable: true, render: (d) => d.machineCount ?? 0 },
    { key: 'createdAt', header: 'Created', sortable: true, render: (d) =>
      d.createdAt ? new Date(d.createdAt).toLocaleDateString() : '—' },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (d) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => openEdit(d)}>
            <Edit className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={d.isActive ? 'Deactivate' : 'Activate'}
            loading={toggleMut.isPending && toggleMut.variables?._id === d._id}
            onClick={() => toggleMut.mutate(d)}
          >
            {d.isActive ? <PowerOff className="h-4 w-4 text-warning" /> : <Power className="h-4 w-4 text-success" />}
          </Button>
          <Button variant="ghost" size="icon" aria-label="Delete" onClick={() => onDelete(d)}>
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
          <h1 className="text-2xl font-bold text-foreground">Departments</h1>
          <p className="text-muted-foreground">Manage and configure your industrial departments</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            className="w-full sm:w-64"
            placeholder="Search departments…"
            icon={<Search className="h-4 w-4" />}
            value={table.searchInput}
            onChange={(e) => table.setSearch(e.target.value)}
          />
          <Select
            className="w-40"
            value={table.filters.isActive ?? ''}
            onChange={(e) => table.setFilter('isActive', e.target.value)}
          >
            <option value="">All status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New Department
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <DataTable
          columns={columns}
          rows={table.items}
          rowKey={(d) => d._id}
          onRowClick={(d) => navigate(`/department/${d._id}`)}
          onSort={table.toggleSort}
          empty={
            <EmptyState
              icon={<Building2 className="h-8 w-8" />}
              title="No departments found"
              description="Create your first department to begin monitoring."
              action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New Department</Button>}
            />
          }
        />
        <Pagination
          page={table.pagination?.currentPage ?? 1}
          totalPages={table.pagination?.totalPages ?? 1}
          onPage={table.setPage}
        />
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Create department' : 'Edit department'}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button form="department-form" type="submit" loading={isSubmitting || saveMut.isPending}>
              {editing === 'new' ? 'Create' : 'Save'}
            </Button>
          </>
        }
      >
        <form id="department-form" className="space-y-4" onSubmit={handleSubmit((d) => saveMut.mutate(d))}>
          <div>
            <Label htmlFor="name">Department name *</Label>
            <Input id="name" {...register('name')} />
            {errors.name && <p className="mt-1 text-sm text-destructive">{errors.name.message}</p>}
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <textarea
              id="description"
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              {...register('description')}
            />
            {errors.description && <p className="mt-1 text-sm text-destructive">{errors.description.message}</p>}
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default Departments;
