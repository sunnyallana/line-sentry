import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/auth-context';
import { useSocketEvent } from '../hooks/useSocketEvent';
import apiService from '../services/api';
import { Building2, Activity, TrendingUp, AlertTriangle, Users as UsersIcon, Gauge } from 'lucide-react';
import { Card, PageLoader, EmptyState } from './ui';
import { cn } from '../lib/cn';

interface DashboardDept {
  _id: string;
  name: string;
  description?: string;
  machineCount?: number;
  avgOEE?: number;
}

interface FactoryStats {
  totalUnits: number;
  avgOEE: number;
  unclassifiedStoppages: number;
  activeMachines: number;
}

const StatCard = ({
  icon,
  label,
  value,
  accent,
  alert,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  accent: string;
  alert?: boolean;
}) => (
  <Card className="p-6 transition-shadow hover:shadow-md">
    <div className="flex items-center gap-4">
      <div className={cn('flex h-12 w-12 items-center justify-center rounded-xl text-white', accent)}>{icon}</div>
      <div>
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p className={cn('text-2xl font-bold', alert ? 'animate-pulse text-destructive' : 'text-foreground')}>{value}</p>
      </div>
    </div>
  </Card>
);

const Dashboard: React.FC = () => {
  const { user, isOperator } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const factory = useQuery<FactoryStats>({
    queryKey: ['factory-stats'],
    queryFn: () => apiService.getFactoryStats(),
  });

  const departments = useQuery<DashboardDept[]>({
    queryKey: ['dashboard-departments'],
    queryFn: async () => {
      const data: DashboardDept[] = await apiService.getDepartments(10);
      return Promise.all(
        data.map(async (d) => ({
          ...d,
          avgOEE: (await apiService.getDepartmentStats(d._id)).avgOEE,
        })),
      );
    },
  });

  // Realtime: invalidate the relevant queries (TanStack Query coalesces refetches,
  // and useSocketEvent cleans up its own listener — no more refetch storm/leak).
  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ['factory-stats'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard-departments'] });
  };
  const refreshFactory = () => queryClient.invalidateQueries({ queryKey: ['factory-stats'] });
  useSocketEvent('production-update', refreshAll);
  useSocketEvent('stoppage-added', refreshFactory);
  useSocketEvent('unclassified-stoppage-detected', refreshFactory);
  useSocketEvent('machine-state-update', refreshFactory);

  if (departments.isLoading) {
    return <PageLoader label="Loading dashboard…" />;
  }

  const stats: FactoryStats = factory.data ?? {
    totalUnits: 0,
    avgOEE: 0,
    unclassifiedStoppages: 0,
    activeMachines: 0,
  };
  const depts = departments.data ?? [];
  const machineCount = depts.reduce((t, d) => t + (d.machineCount ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* Welcome header */}
      <div className="rounded-xl bg-gradient-to-r from-primary to-info p-6 text-white shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Welcome back, {user?.username}</h1>
            <p className="mt-1 text-white/80">
              {isOperator
                ? `Monitoring ${user?.department?.name || 'your department'}`
                : 'System overview and management'}
            </p>
          </div>
          <div className="hidden items-center gap-2 text-white/80 sm:flex">
            <UsersIcon className="h-5 w-5" />
            <span className="capitalize">{user?.role}</span>
          </div>
        </div>
      </div>

      {/* Quick stats */}
      <div className={cn('grid grid-cols-1 gap-6', isOperator ? 'md:grid-cols-3' : 'md:grid-cols-4')}>
        <StatCard icon={<Building2 className="h-6 w-6" />} label="Departments" value={depts.length} accent="bg-primary" />
        <StatCard icon={<Activity className="h-6 w-6" />} label="Active Machines" value={machineCount} accent="bg-success" />
        {!isOperator && (
          <StatCard icon={<TrendingUp className="h-6 w-6" />} label="Avg OEE" value={`${stats.avgOEE}%`} accent="bg-warning" />
        )}
        <StatCard
          icon={<AlertTriangle className="h-6 w-6" />}
          label="Unclassified Stoppages"
          value={stats.unclassifiedStoppages}
          accent="bg-destructive"
          alert={stats.unclassifiedStoppages > 0}
        />
      </div>

      {/* Departments */}
      <div>
        <h2 className="mb-6 text-xl font-bold text-foreground">
          {isOperator ? 'Your Department' : 'Departments Overview'}
        </h2>

        {depts.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-8 w-8" />}
            title="No departments found"
            description={
              isOperator
                ? 'You have not been assigned to a department yet. Contact your administrator.'
                : 'Create your first department to begin monitoring factory operations.'
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {depts.map((department) => (
              <Card
                key={department._id}
                onClick={() => navigate(`/department/${department._id}`)}
                className="group cursor-pointer p-6 transition-all hover:border-primary hover:shadow-xl"
              >
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-lg font-bold text-foreground">{department.name}</h3>
                  <div className="rounded-lg bg-muted p-2 transition-colors group-hover:bg-primary">
                    <Building2 className="h-5 w-5 text-primary transition-colors group-hover:text-primary-foreground" />
                  </div>
                </div>
                <p className="mb-4 line-clamp-2 text-sm text-muted-foreground">
                  {department.description || 'No description available'}
                </p>
                <dl className="space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="font-medium text-muted-foreground">Machines</dt>
                    <dd className="font-bold text-foreground">{department.machineCount ?? 0}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="font-medium text-muted-foreground">OEE</dt>
                    <dd className="flex items-center gap-2 font-bold text-foreground">
                      <Gauge className="h-4 w-4 text-warning" />
                      {department.avgOEE != null ? `${department.avgOEE}%` : 'N/A'}
                    </dd>
                  </div>
                </dl>
                <div className="mt-6 border-t border-border pt-4">
                  <span className="text-sm font-semibold text-primary group-hover:underline">View details →</span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
