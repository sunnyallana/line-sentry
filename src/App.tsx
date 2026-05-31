import React, { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { useAuth } from './context/auth-context';
import { PageLoader } from './components/ui';
import Login from './components/Login';
import Layout from './components/Layout';

// Route-level code splitting: each page is its own chunk, loaded on demand.
const Dashboard = lazy(() => import('./components/Dashboard'));
const DepartmentView = lazy(() => import('./components/DepartmentView'));
const MachineView = lazy(() => import('./components/MachineView'));
const Departments = lazy(() => import('./components/Departments'));
const Users = lazy(() => import('./components/Users'));
const Sensors = lazy(() => import('./components/Sensors'));
const Molds = lazy(() => import('./components/Molds'));
const Configuration = lazy(() => import('./components/Configuration'));
const Reports = lazy(() => import('./components/Reports'));
const Setup = lazy(() => import('./components/Setup'));

// Theme context (consumed across components for the dark/light toggle).
export const ThemeContext = React.createContext<{
  isDarkMode: boolean;
  toggleTheme: () => void;
}>({ isDarkMode: true, toggleTheme: () => {} });

const Screen = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-screen items-center justify-center bg-background">{children}</div>
);

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <Screen><PageLoader /></Screen>;
  return user ? <>{children}</> : <Navigate to="/login" replace />;
};

/** Client-side RBAC guard (defense-in-depth; the backend also enforces it). */
const RequireAdmin: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAdmin } = useAuth();
  return isAdmin ? <>{children}</> : <Navigate to="/dashboard" replace />;
};

const App: React.FC = () => {
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('theme');
    return saved ? saved === 'dark' : true;
  });

  useEffect(() => {
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    // Apply on <html> so portaled content (modals, toasts) inherits the theme.
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);

  const toggleTheme = () => setIsDarkMode((v) => !v);

  return (
    <ThemeContext.Provider value={{ isDarkMode, toggleTheme }}>
      <AuthProvider>
        <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Suspense fallback={<Screen><PageLoader /></Screen>}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="dashboard" element={<Dashboard />} />
                <Route path="departments" element={<RequireAdmin><Departments /></RequireAdmin>} />
                <Route path="department/:id" element={<DepartmentView />} />
                <Route path="machine/:id" element={<MachineView />} />
                <Route path="users" element={<RequireAdmin><Users /></RequireAdmin>} />
                <Route path="setup" element={<RequireAdmin><Setup /></RequireAdmin>} />
                <Route path="sensors" element={<RequireAdmin><Sensors /></RequireAdmin>} />
                <Route path="molds" element={<RequireAdmin><Molds /></RequireAdmin>} />
                <Route path="reports" element={<Reports />} />
                <Route path="config" element={<RequireAdmin><Configuration /></RequireAdmin>} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </Router>
      </AuthProvider>
    </ThemeContext.Provider>
  );
};

export default App;
