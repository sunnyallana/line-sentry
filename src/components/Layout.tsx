import React, { useContext, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/auth-context';
import { ThemeContext } from '../App';
import {
  LogOut, Settings, BarChart3, Building2, User, Menu, Activity, X,
  PackagePlus, FileText, Sun, Moon, Factory, Wrench,
} from 'lucide-react';
import { Button } from './ui';
import { cn } from '../lib/cn';

const Layout: React.FC = () => {
  const { user, logout, isAdmin } = useAuth();
  const { isDarkMode, toggleTheme } = useContext(ThemeContext);
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navigation = [
    { name: 'Dashboard', href: '/dashboard', icon: BarChart3 },
    ...(isAdmin
      ? [
          { name: 'Setup', href: '/setup', icon: Wrench },
          { name: 'Users', href: '/users', icon: User },
          { name: 'Sensors', href: '/sensors', icon: Activity },
          { name: 'Departments', href: '/departments', icon: Building2 },
          { name: 'Molds', href: '/molds', icon: PackagePlus },
          { name: 'Reports', href: '/reports', icon: FileText },
          { name: 'Configuration', href: '/config', icon: Settings },
        ]
      : []),
  ];

  const isActive = (href: string) => location.pathname === href;

  const NavLinks = ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav className="flex-1 space-y-1 px-3 py-4">
      {navigation.map((item) => {
        const active = isActive(item.href);
        return (
          <a
            key={item.name}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(item.href);
              onNavigate?.();
            }}
            className={cn(
              'group flex items-center rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <item.icon className="mr-3 h-5 w-5" />
            {item.name}
          </a>
        );
      })}
    </nav>
  );

  const Brand = () => (
    <div className="flex h-16 items-center gap-2 border-b border-border px-4">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
        <Factory className="h-5 w-5 text-primary-foreground" />
      </div>
      <span className="text-lg font-bold text-foreground">LineSentry</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="fixed inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} aria-hidden />
          <div className="fixed inset-y-0 left-0 flex w-64 flex-col bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border pr-2">
              <Brand />
              <Button variant="ghost" size="icon" aria-label="Close menu" onClick={() => setSidebarOpen(false)}>
                <X className="h-5 w-5" />
              </Button>
            </div>
            <NavLinks onNavigate={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-64 lg:flex-col">
        <div className="flex flex-1 flex-col border-r border-border bg-card">
          <Brand />
          <NavLinks />
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col lg:pl-64">
        <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b border-border bg-card/95 px-4 backdrop-blur sm:px-6 lg:px-8">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-6 w-6" />
          </Button>

          <div className="flex flex-1 items-center">
            <h1 className="text-lg font-semibold text-foreground">
              {navigation.find((item) => isActive(item.href))?.name || 'Dashboard'}
            </h1>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right text-sm">
              <div className="font-medium text-foreground">{user?.username}</div>
              <div className="text-xs capitalize text-muted-foreground">{user?.role}</div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDarkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Log out">
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </header>

        <main className="flex-1">
          <div className="px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
};

export default Layout;
