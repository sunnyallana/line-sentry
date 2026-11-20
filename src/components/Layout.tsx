import React, { useContext, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, BarChart3, Building2, ChevronRight, FileText, LayoutDashboard, LogOut, Menu, Monitor, Moon,
  Package, Search, Settings, Sun, Users as UsersIcon, Wrench, X, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../context/auth-context';
import { ThemeContext } from '../App';
import socketService from '../services/socket';
import { toast } from 'react-toastify';
import { useQueryClient } from '@tanstack/react-query';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { Button, IconButton } from './ui';
import { CommandPalette, useCommandPalette } from './CommandPalette';
import { cn } from '../lib/cn';

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Other route prefixes that belong under this item. */
  also?: string[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/* Grouped by what a person comes to do: watch the floor, set the plant up,
   manage the system. Operators only see the first group. */
const monitorGroup: NavGroup = {
  label: 'Monitor',
  items: [
    { name: 'Overview', href: '/dashboard', icon: LayoutDashboard, also: ['/department/', '/machine/'] },
    { name: 'Analysis', href: '/analysis', icon: BarChart3 },
    { name: 'Reports', href: '/reports', icon: FileText },
  ],
};

const adminGroups: NavGroup[] = [
  {
    label: 'Plant',
    items: [
      { name: 'Setup', href: '/setup', icon: Wrench },
      { name: 'Departments', href: '/departments', icon: Building2 },
      { name: 'Sensors', href: '/sensors', icon: Activity },
      { name: 'Molds', href: '/molds', icon: Package },
    ],
  },
  {
    label: 'Administration',
    items: [
      { name: 'Users', href: '/users', icon: UsersIcon },
      { name: 'Settings', href: '/config', icon: Settings },
    ],
  },
];

/** Whether the realtime connection is up, so "live" figures can be trusted. */
function useLiveConnection(): boolean {
  const [connected, setConnected] = useState(socketService.connected);
  useEffect(() => {
    socketService.connect();
    setConnected(socketService.connected);
    return socketService.onStatus(setConnected);
  }, []);
  return connected;
}

const Layout: React.FC = () => {
  const { user, logout, isAdmin } = useAuth();
  const { isDarkMode, toggleTheme } = useContext(ThemeContext);
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const live = useLiveConnection();
  const palette = useCommandPalette();
  const queryClient = useQueryClient();

  useSocketEvent('alert', (alert) => {
    queryClient.invalidateQueries({ queryKey: ['alerts'] });
    const notice = `${alert.title}. ${alert.message}`;
    const open = () => navigate(`/machine/${alert.machineId}`);
    if (alert.level >= 2) toast.error(notice, { onClick: open, autoClose: 15000 });
    else toast.warning(notice, { onClick: open, autoClose: 10000 });
  });

  // Close the mobile menu on navigation.
  useEffect(() => setSidebarOpen(false), [location.pathname]);

  const groups = isAdmin ? [monitorGroup, ...adminGroups] : [monitorGroup];
  const isCurrent = (item: NavItem) =>
    location.pathname === item.href || (item.also ?? []).some((p) => location.pathname.startsWith(p));
  const current = groups.flatMap((g) => g.items).find(isCurrent);

  // The trail tells people where they are and gives a way back up.
  const trail: { name: string; href?: string }[] = [];
  if (current) {
    const deeper = location.pathname.startsWith('/department/')
      ? 'Department'
      : location.pathname.startsWith('/machine/')
        ? 'Machine'
        : null;
    trail.push({ name: current.name, href: deeper ? current.href : undefined });
    if (deeper) trail.push({ name: deeper });
  }

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const initials = (user?.username ?? '?').slice(0, 2).toUpperCase();

  const Sidebar = () => (
    <div className="flex h-full flex-col">
      <Link to="/dashboard" className="flex h-14 shrink-0 items-center gap-2.5 px-4 focus-visible:ring-inset">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-foreground text-background">
          <Activity className="h-3.5 w-3.5" strokeWidth={2.5} />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-foreground">LineSentry</span>
      </Link>

      <nav className="scrollbar-thin flex-1 space-y-5 overflow-y-auto px-2 pb-4 pt-2" aria-label="Main">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
            <ul className="space-y-px">
              {group.items.map((item) => {
                const active = isCurrent(item);
                return (
                  <li key={item.href}>
                    <NavLink
                      to={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'pressable flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium focus-visible:ring-inset',
                        active
                          ? 'bg-foreground/[0.07] text-foreground'
                          : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground',
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0" strokeWidth={active ? 2.1 : 1.8} />
                      {item.name}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-border p-2">
        <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground">
            {initials}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-[13px] font-medium text-foreground">{user?.username}</p>
            <p className="truncate text-xs capitalize text-muted-foreground">{user?.role}</p>
          </div>
          <IconButton label={isDarkMode ? 'Use light theme' : 'Use dark theme'} onClick={toggleTheme}>
            {isDarkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </IconButton>
          <IconButton label="Sign out" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
      >
        Skip to content
      </a>

      {/* Mobile menu: always mounted so it slides out the way it came in, and a
          tap mid-close picks the motion up from where it is. */}
      <div
        className={cn('fixed inset-0 z-50 lg:hidden', !sidebarOpen && 'pointer-events-none')}
        aria-hidden={!sidebarOpen}
      >
        <div
          className={cn(
            'fixed inset-0 bg-black/45 transition-opacity duration-300 ease-out',
            sidebarOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
        <div
          className={cn(
            'fixed inset-y-0 left-0 w-64 border-r border-border bg-card shadow-sheet',
            'transition-[transform,visibility] duration-300 ease-spring',
            'motion-reduce:transition-[opacity,visibility] motion-reduce:duration-200',
            sidebarOpen
              ? 'visible translate-x-0 motion-reduce:opacity-100'
              : 'invisible -translate-x-full motion-reduce:translate-x-0 motion-reduce:opacity-0',
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2.5"
            aria-label="Close menu"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
          <Sidebar />
        </div>
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden border-r border-border bg-card lg:fixed lg:inset-y-0 lg:z-30 lg:block lg:w-56">
        <Sidebar />
      </aside>

      <div className="lg:pl-56">
        <header className="material-chrome sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border px-4 sm:px-6 lg:px-8">
          <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>

          <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
            <ol className="flex items-center gap-1.5 text-[13px]">
              {trail.map((crumb, i) => (
                <li key={crumb.name} className="flex min-w-0 items-center gap-1.5">
                  {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden />}
                  {crumb.href ? (
                    <Link to={crumb.href} className="truncate rounded text-muted-foreground hover:text-foreground">
                      {crumb.name}
                    </Link>
                  ) : (
                    <span className="truncate font-medium text-foreground" aria-current="page">{crumb.name}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>

          <button
            type="button"
            onClick={palette.show}
            className="pressable inline-flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-[13px] text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            aria-label="Search pages, departments and machines"
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Search className="h-4 w-4" />
            <span className="hidden md:inline">Search</span>
            <kbd className="hidden rounded border border-border px-1 text-[11px] md:inline">Ctrl K</kbd>
          </button>

          <Link
            to="/board"
            className="pressable hidden h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground sm:inline-flex"
            title="Open the wall-screen board"
          >
            <Monitor className="h-4 w-4" /> Board
          </Link>

          <span
            className="inline-flex items-center gap-2 text-[13px] text-muted-foreground"
            title={live ? 'Figures update as signals arrive' : 'Not connected. Figures may be out of date; reconnecting.'}
            role="status"
          >
            <span className={cn('h-2 w-2 rounded-full', live ? 'bg-success' : 'bg-warning')} aria-hidden />
            {live ? 'Live' : 'Reconnecting'}
          </span>
        </header>

        <CommandPalette
          open={palette.open}
          onClose={palette.hide}
          destinations={groups.flatMap((g) => g.items.map((item) => ({ ...item, group: g.label })))}
        />

        <main id="main" className="mx-auto max-w-[1360px] px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default Layout;
