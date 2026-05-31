import React, { useState, useEffect, ReactNode } from 'react';
import apiService from '../services/api';
import socketService from '../services/socket';
import { User } from '../types';
import { AuthContext } from './auth-context';

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      checkAuth();
    } else {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Connect to socket when user is authenticated
    if (user) {
      socketService.connect();
    } else {
      socketService.disconnect();
    }
  }, [user]);

  const checkAuth = async () => {
    try {
      const userData = await apiService.getCurrentUser();
      setUser(userData);
    } catch (error) {
      console.error('Auth check failed:', error);
      localStorage.removeItem('token');
      apiService.clearToken();
    } finally {
      setLoading(false);
    }
  };

  const login = async (username: string, password: string, captchaToken?: string) => {
    const response = await apiService.login(username, password, captchaToken);
    setUser(response.user);
  };

  const logout = () => {
    setUser(null);
    apiService.clearToken();
    socketService.disconnect();
  };

  const value = {
    user,
    loading,
    login,
    logout,
    isAdmin: user?.role === 'admin',
    isOperator: user?.role === 'operator',
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
