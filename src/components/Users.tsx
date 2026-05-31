import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { User as UserIcon, Plus, Edit, Trash2, Power, PowerOff, Search } from 'lucide-react';
import { useAuth } from '../context/auth-context';
import apiService from '../services/api';
import type { Department } from '../types';
import { useDataTable } from '../hooks/useDataTable';
import {
  Button, Input, Label, Select, Badge, Card, Modal, DataTable, Pagination, EmptyState, type Column,
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
    onError: (e) => toast.error(errMsg(e, 'Save failed')),
  });

  const toggleMut = useMutation({
    mutationFn: (u: UserRow) => apiService.updateUser(u._id, { isActive: !u.isActive }),
    onSuccess: () => { toast.success('Status updated'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Update failed')),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiService.deleteUser(id),
    onSuccess: () => { toast.success('User deleted'); invalidate(); },
    onError: (e) => toast.error(errMsg(e, 'Delete failed')),
  });

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

  const columns: Column<UserRow>[] = [
    { key: 'username', header: 'User', sortable: true, render: (u) => (
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <UserIcon className="h-5 w-5" />
        </div>
        <span className="font-medium text-foreground">{u.username}</span>
      </div>
    ) },
    { key: 'email', header: 'Email', render: (u) => <span className="text-muted-foreground">{u.email}</span> },
    { key: 'role', header: 'Role', render: (u) => (
      <Badge variant={u.role === 'admin' ? 'info' : 'muted'} className="capitalize">{u.role}</Badge>
    ) },
    { key: 'department', header: 'Department', render: (u) => deptName(u) || '—' },
    { key: 'status', header: 'Status', render: (u) => (
      <Badge variant={u.isActive ? 'success' : 'muted'}>{u.isActive ? 'Active' : 'Inactive'}</Badge>
    ) },
    {
      key: 'actions', header: '', className: 'text-right',
      render: (u) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => openEdit(u)}><Edit className="h-4 w-4" /></Button>
          {!isSelf(u) && (
            <>
              <Button variant="ghost" size="icon" aria-label={u.isActive ? 'Deactivate' : 'Activate'} onClick={() => toggleMut.mutate(u)}>
                {u.isActive ? <PowerOff className="h-4 w-4 text-warning" /> : <Power className="h-4 w-4 text-success" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete"
                onClick={() => window.confirm('Delete this user?') && deleteMut.mutate(u._id)}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Users</h1>
          <p className="text-muted-foreground">Manage accounts and role-based access</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input className="w-full sm:w-64" placeholder="Search users…" icon={<Search className="h-4 w-4" />} value={table.searchInput} onChange={(e) => table.setSearch(e.target.value)} />
          <Select className="w-36" value={table.filters.role ?? ''} onChange={(e) => table.setFilter('role', e.target.value)}>
            <option value="">All roles</option>
            <option value="admin">Admin</option>
            <option value="operator">Operator</option>
          </Select>
          <Select className="w-36" value={table.filters.isActive ?? ''} onChange={(e) => table.setFilter('isActive', e.target.value)}>
            <option value="">All status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
          <Button onClick={openCreate}><Plus className="h-4 w-4" /> New User</Button>
        </div>
      </div>

      <Card className="p-4">
        <DataTable
          columns={columns}
          rows={table.items}
          rowKey={(u) => u._id}
          onSort={table.toggleSort}
          empty={<EmptyState icon={<UserIcon className="h-8 w-8" />} title="No users found" action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> New User</Button>} />}
        />
        <Pagination page={table.pagination?.currentPage ?? 1} totalPages={table.pagination?.totalPages ?? 1} onPage={table.setPage} />
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Create user' : 'Edit user'}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button form="user-form" type="submit" loading={isSubmitting || saveMut.isPending}>{editing === 'new' ? 'Create' : 'Save'}</Button>
          </>
        }
      >
        <form id="user-form" className="space-y-4" onSubmit={onSubmit}>
          <div>
            <Label htmlFor="username">Username *</Label>
            <Input id="username" {...register('username')} />
            {errors.username && <p className="mt-1 text-sm text-destructive">{errors.username.message}</p>}
          </div>
          <div>
            <Label htmlFor="email">Email *</Label>
            <Input id="email" type="email" {...register('email')} />
            {errors.email && <p className="mt-1 text-sm text-destructive">{errors.email.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="role">Role *</Label>
              <Select id="role" {...register('role')}>
                <option value="operator">Operator</option>
                <option value="admin">Admin</option>
              </Select>
            </div>
            {role === 'operator' && (
              <div>
                <Label htmlFor="departmentId">Department *</Label>
                <Select id="departmentId" {...register('departmentId')}>
                  <option value="">Select…</option>
                  {(departments.data ?? []).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
                </Select>
              </div>
            )}
          </div>
          {errors.departmentId && <p className="-mt-2 text-sm text-destructive">{errors.departmentId.message}</p>}
          <div>
            <Label htmlFor="password">{editing === 'new' ? 'Password *' : 'Password (leave blank to keep)'}</Label>
            <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
            {errors.password && <p className="mt-1 text-sm text-destructive">{errors.password.message}</p>}
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default Users;
