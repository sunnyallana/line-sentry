import { createContext, useContext } from 'react';
import { User } from '../types';

export interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string, captchaToken?: string) => Promise<void>;
  logout: () => void;
  isAdmin: boolean;
  isOperator: boolean;
}

/**
 * The context object lives in this component-free module so that editing the
 * provider (AuthContext.tsx) doesn't re-instantiate the context during HMR —
 * which previously left consumers seeing `undefined` ("useAuth must be used
 * within an AuthProvider").
 */
export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
