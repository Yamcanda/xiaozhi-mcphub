import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { AuthState } from '../types/index.js';
import * as authService from '../services/authService.js';
import { getPublicConfig } from '../services/configService.js';

// Initial auth state
const initialState: AuthState = {
  isAuthenticated: false,
  loading: true,
  user: null,
  error: null,
};

// Create auth context
const AuthContext = createContext<{
  auth: AuthState;
  login: (
    username: string,
    password: string,
  ) => Promise<{
    success: boolean;
    isUsingDefaultPassword?: boolean;
    message?: string;
    code?: string;
  }>;
  register: (
    username: string,
    password: string,
    email?: string,
  ) => Promise<{ success: boolean; emailVerificationRequired?: boolean; message?: string }>;
  logout: () => void;
}>({
  auth: initialState,
  login: async () => ({ success: false }),
  register: async () => ({ success: false }),
  logout: () => {},
});

// Auth provider component
export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [auth, setAuth] = useState<AuthState>(initialState);
  const operation = useRef(0);

  useEffect(
    () =>
      authService.subscribeAuthInvalidation(() => {
        if (auth.loading) return;
        setAuth({ ...initialState, loading: false });
      }),
    [auth.loading],
  );

  // Restore once; stale startup work must not overwrite a later login or logout.
  useEffect(() => {
    const currentOperation = ++operation.current;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () => !cancelled && operation.current === currentOperation;
    const loadUser = async (): Promise<void> => {
      try {
        const { skipAuth, permissions } = await getPublicConfig();
        if (!isCurrent()) return;
        if (skipAuth) {
          setAuth({
            isAuthenticated: true,
            loading: false,
            user: { username: 'guest', isAdmin: true, permissions },
            error: null,
          });
          return;
        }

        const revision = authService.getAuthRevision();
        const hadToken = !!authService.getToken();
        let response = hadToken
          ? await authService.getCurrentUser()
          : await authService.getBetterAuthUser();
        if (!isCurrent()) return;
        if (hadToken && !response.success && revision === authService.getAuthRevision()) {
          // A rejected JWT may still have an independent valid cookie session.
          response = await authService.getBetterAuthUser();
          if (!isCurrent()) return;
        }
        if (revision !== authService.getAuthRevision()) {
          // Recheck credentials changed by a parallel rejection or a login in another tab.
          void loadUser();
          return;
        }
        if (response.success && response.user) {
          setAuth({ isAuthenticated: true, loading: false, user: response.user, error: null });
        } else {
          setAuth({ ...initialState, loading: false });
        }
      } catch {
        if (!isCurrent()) return;
        // A network/5xx failure is not proof of logout. Retry without deleting credentials
        // or granting access before the server verifies them.
        retryTimer = setTimeout(() => {
          void loadUser();
        }, 2000);
      }
    };

    void loadUser();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, []);

  // Login function
  const login = async (
    username: string,
    password: string,
  ): Promise<{
    success: boolean;
    isUsingDefaultPassword?: boolean;
    message?: string;
    code?: string;
  }> => {
    const currentOperation = ++operation.current;
    try {
      const response = await authService.login({ username, password });
      if (currentOperation !== operation.current) return { success: false };

      if (response.success && response.token && response.user) {
        authService.setToken(response.token);
        setAuth({
          isAuthenticated: true,
          loading: false,
          user: response.user,
          error: null,
        });
        return {
          success: true,
          isUsingDefaultPassword: response.isUsingDefaultPassword,
        };
      } else {
        setAuth({
          ...initialState,
          loading: false,
          error: response.message || 'Authentication failed',
        });
        return { success: false, message: response.message, code: response.code };
      }
    } catch (error) {
      if (currentOperation !== operation.current) return { success: false };
      setAuth({
        ...initialState,
        loading: false,
        error: 'Authentication failed',
      });
      return { success: false, message: error instanceof Error ? error.message : undefined };
    }
  };

  // Register function
  const register = async (
    username: string,
    password: string,
    email?: string,
  ): Promise<{ success: boolean; emailVerificationRequired?: boolean; message?: string }> => {
    const currentOperation = ++operation.current;
    try {
      const response = await authService.register({ username, password, email });
      if (currentOperation !== operation.current) return { success: false };

      if (response.success && response.token && response.user) {
        authService.setToken(response.token);
        // Direct login (email verification off)
        setAuth({
          isAuthenticated: true,
          loading: false,
          user: response.user,
          error: null,
        });
        return { success: true };
      }

      if (response.success && response.emailVerificationRequired) {
        // Registered but must verify email before logging in
        return {
          success: true,
          emailVerificationRequired: true,
          message: response.message,
        };
      }

      setAuth({
        ...initialState,
        loading: false,
        error: response.message || 'Registration failed',
      });
      return { success: false, message: response.message };
    } catch (error) {
      if (currentOperation !== operation.current) return { success: false };
      setAuth({
        ...initialState,
        loading: false,
        error: 'Registration failed',
      });
      return {
        success: false,
        message: error instanceof Error ? error.message : undefined,
      };
    }
  };

  // Logout function
  const logout = (): void => {
    operation.current++;
    authService.logout();
    setAuth({
      ...initialState,
      loading: false,
    });
  };

  return (
    <AuthContext.Provider value={{ auth, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

// Custom hook to use auth context
export const useAuth = () => useContext(AuthContext);
