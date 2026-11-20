import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Plus, Edit, Trash2, Power, PowerOff, Search } from 'lucide-react';
import { useAuth } from '../context/auth-context';
import apiService from '../services/api';
import type { Department } from '../types';
import { useDataTable } from '../hooks/useDataTable';
import {
  Button, Input, Select, Modal, DataTable, Pagination, EmptyState, PageHeader, PageLoader, Section, Toolbar,
  StatusDot, IconButton, Field, type Column,
} from './ui';

const schema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').max(30, 'Username cannot exceed 30 characters'),
  email: z.string().email('Invalid email address').max(50, 'Email cannot exceed 50 characters'),
  role: z.enum(['admin', 'operator']),
  departmentId: z.string().optional(),
  password: z.string().min(6, 'Password must be at least 6 characters').max(30).optional().or(z.literal('')),
});
type FormData = z.infer<typeof schema>;

interface UserRow {
  _id: string;
  username: string;
  email: string;
  role: 'admin' | 'operator';
  isActive: boolean;
  departmentId?: { _id: string; name: string } | string | null;
}

const ROLE_LABELS: Record<UserRow['role'], string> = { admin: 'Administrator', operator: 'Operator' };

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const deptName = (u: UserRow) => (u.departmentId && typeof u.departmentId === 'object' ? u.departmentId.name : '');

const Users: React.FC = () => {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const table = useDataTable<UserRow>({
    queryKey: 'users',
    listKey: 'users',
    fetcher: (params) => apiService.getUsersAdmin(params),
    initialSort: { by: 'username', order: 'asc' },
  });
  const departments = useQuery<Department[]>({
    queryKey: ['departments', 'options'],
    queryFn: () => apiService.getDepartments(),
  });

  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const { register, handleSubmit, reset, watch, setError, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', email: '', role: 'operator', departmentId: '', password: '' },
  });
  const role = watch('role');

  const openCreate = () => {
    reset({ username: '', email: '', role: 'operator', departmentId: '', password: '' });
    setEditing('new');
  };
  const openEdit = (u: UserRow) => {
    reset({
      username: u.username,
      email: u.email,
      role: u.role,
      departmentId: typeof u.departmentId === 'object' ? u.departmentId?._id : (u.departmentId ?? ''),
      password: '',
    });
    setEditing(u);
  };

  const saveMut = useMutation({
    mutationFn: (data: FormData) => {
      const payload: Record<string, unknown> = {
        username: data.username,
        email: data.email,
        role: data.role,
        departmentId: data.role === 'operator' ? data.departmentId : undefined,
      };
      if (data.password) payload.password = data.password; // omit empty on edit
      return editing === 'new'
        ? apiService.createUser(payload)
        : apiService.updateUser((editing as UserRow)._id, payload);
    },
    onSuccess: () => {
      toast.success(editing === 'new' ? 'User created' : 'User updated');
      invalidate();
      setEditing(null);
    },
    onError: (e) => toast.error(errMsg(e, 'Could not save user')),
  });

  const toggleMut = useMutation({
    mutationFn: (u: UserRow) => apiService.updateUser(u._id, { isActive: !u.isActive }),
    onSuccess: (_data, u) => { toast.success(u.isActive ? 'User deactivated' : 'User activated'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Could not update user')),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.deleteUser(id),
    onSuccess: () => { toast.success('User deleted'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Could not delete user')),
  });

  const onDelete = (u: UserRow) => {
    if (window.confirm(`Delete user "${u.username}"? Their account is removed and they can no longer sign in. This cannot be undone.`)) {
      deleteMut.mutate(u._id);
    }
  };

  const onSubmit = handleSubmit((data) => {
    if (data.role === 'operator' && !data.departmentId) {
      setError('departmentId', { message: 'Department is required for operators' });
      return;
    }
    if (editing === 'new' && !data.password) {
      setError('password', { message: 'Password is required' });
      return;
    }
    saveMut.mutate(data);
  });

  const isSelf = (u: UserRow) => me?.id === u._id;

  const hasFilters = Boolean(table.searchInput || table.filters.role || table.filters.isActive);
  const clearFilters = () => {
    table.setSearch('');
    table.setFilter('role', '');
    table.setFilter('isActive', '');
  };

  const columns: Column<UserRow>[] = [
    { key: 'username', header: 'User', sortable: true, render: (u) => (
      <div className="min-w-0">
        <div className="font-medium">
          {u.username}
          {isSelf(u) && <span className="ml-1.5 font-normal text-muted-foreground">(you)</span>}
        </div>
        <div className="truncate text-[13px] text-muted-foreground">{u.email}</div>
      </div>
    ) },
    { key: 'role', header: 'Role', render: (u) => ROLE_LABELS[u.role] ?? u.role },
    { key: 'department', header: 'Department', render: (u) => deptName(u) || <span className="text-muted-foreground">–</span> },
    { key: 'status', header: 'Status', render: (u) => (
      <StatusDot status={u.isActive ? 'running' : 'inactive'} label={u.isActive ? 'Active' : 'Inactive'} />
    ) },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right',
      render: (u) => (
        <div className="flex justify-end gap-1">
          <IconButton label={`Edit ${u.username}`} onClick={() => openEdit(u)}><Edit className="h-4 w-4" /></IconButton>
          {!isSelf(u) && (
            <>
              <IconButton
                label={`${u.isActive ? 'Deactivate' : 'Activate'} ${u.username}`}
                disabled={toggleMut.isPending && toggleMut.variables?._id === u._id}
                onClick={() => toggleMut.mutate(u)}
              >
                {u.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
              </IconButton>
              <IconButton label={`Delete ${u.username}`} danger onClick={() => onDelete(u)}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="People who can sign in, and what each of them can see."
        actions={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New user</Button>}
      />

      <Section flush>
        <div className="border-b border-border px-5 py-3">
          <Toolbar>
            <Input
              className="w-64"
              aria-label="Search users"
              placeholder="Search users"
              icon={<Search className="h-4 w-4" />}
              value={table.searchInput}
              onChange={(e) => table.setSearch(e.target.value)}
            />
            <Select className="w-40" aria-label="Filter by role" value={table.filters.role ?? ''} onChange={(e) => table.setFilter('role', e.target.value)}>
              <option value="">All roles</option>
              <option value="admin">Administrator</option>
              <option value="operator">Operator</option>
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
            title="Users could not be loaded"
            description="Check your connection and try again."
            action={<Button variant="outline" onClick={() => table.refetch()}>Try again</Button>}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={table.items}
            rowKey={(u) => u._id}
            onSort={table.toggleSort}
            empty={hasFilters ? (
              <EmptyState
                title="No users match these filters."
                action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
              />
            ) : (
              <EmptyState
                title="No users yet"
                description="Create an account for each person who needs to sign in."
                action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New user</Button>}
              />
            )}
          />
        )}
        <Pagination page={table.pagination?.currentPage ?? 1} totalPages={table.pagination?.totalPages ?? 1} onPage={table.setPage} />
      </Section>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New user' : 'Edit user'}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button form="user-form" type="submit" loading={isSubmitting || saveMut.isPending}>
              {editing === 'new' ? 'Create user' : 'Save changes'}
            </Button>
          </>
        }
      >
        <form id="user-form" className="space-y-4" onSubmit={onSubmit}>
          <Field label="Username" hint="3 to 30 characters. Used to sign in." error={errors.username?.message}>
            <Input autoComplete="off" {...register('username')} />
          </Field>
          <Field label="Email" error={errors.email?.message}>
            <Input type="email" autoComplete="off" {...register('email')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role" hint={role === 'admin' ? 'Has access to every department and the admin screens.' : 'Works within one department.'}>
              <Select {...register('role')}>
                <option value="operator">Operator</option>
                <option value="admin">Administrator</option>
              </Select>
            </Field>
            {role === 'operator' && (
              <Field label="Department" error={errors.departmentId?.message}>
                <Select {...register('departmentId')}>
                  <option value="">Select a department</option>
                  {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
                </Select>
              </Field>
            )}
          </div>
          <Field
            label={editing === 'new' ? 'Password' : 'New password'}
            hint={editing === 'new' ? 'At least 6 characters.' : 'Leave blank to keep the current password.'}
            error={errors.password?.message}
          >
            <Input type="password" autoComplete="new-password" {...register('password')} />
          </Field>
        </form>
      </Modal>
    </div>
  );
};

export default Users;
