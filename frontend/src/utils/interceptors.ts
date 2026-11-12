import { addInterceptor, removeInterceptor, type FetchInterceptor } from './fetchInterceptor.js';
import { getApiUrl } from './runtime.js';

// Token key in localStorage
const TOKEN_KEY = 'mcphub_token';
const AUTH_REVISION_KEY = 'mcphub_auth_revision';
const invalidationListeners = new Set<() => void>();

// Read shared storage so a login in another tab also supersedes outstanding requests.
export const getAuthRevision = (): string | null => localStorage.getItem(AUTH_REVISION_KEY);

const advanceAuthRevision = (): void => {
  localStorage.setItem(
    AUTH_REVISION_KEY,
    Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'),
  );
};

export const subscribeAuthInvalidation = (listener: () => void): (() => void) => {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
};

// Get token from localStorage
export const getToken = (): string | null => {
  return localStorage.getItem(TOKEN_KEY);
};

// Set token in localStorage
export const setToken = (token: string): void => {
  localStorage.setItem(TOKEN_KEY, token);
  advanceAuthRevision();
};

// Remove token from localStorage
export const removeToken = (): void => {
  localStorage.removeItem(TOKEN_KEY);
  advanceAuthRevision();
};

const isJwtProtectedRequest = (url: string): boolean => {
  const origin = window.location.origin;
  const requestUrl = new URL(url, origin);
  const apiUrl = new URL(getApiUrl('/'), origin);
  if (requestUrl.origin !== apiUrl.origin || !requestUrl.pathname.startsWith(apiUrl.pathname)) {
    return false;
  }
  const endpoint = requestUrl.pathname.slice(apiUrl.pathname.length);
  // These endpoints authenticate credentials or cookies, not the dashboard JWT.
  return (
    ![
      'auth/login',
      'auth/register',
      'auth/verify-email',
      'auth/forgot-password',
      'auth/verify-reset-token',
      'auth/reset-password',
    ].includes(endpoint) &&
    !endpoint.startsWith('better-auth/') &&
    endpoint !== 'better-auth'
  );
};

// Auth interceptor for automatically adding authorization headers
export const authInterceptor: FetchInterceptor = {
  request: async (url: string, config: RequestInit) => {
    const headers = new Headers(config.headers);
    const language = localStorage.getItem('i18nextLng') || 'en';
    headers.set('Accept-Language', language);

    const token = getToken();
    if (token) {
      headers.set('x-auth-token', token);
    }

    return {
      url,
      metadata: { authRevision: getAuthRevision() },
      config: {
        ...config,
        headers,
        credentials: config.credentials ?? 'include',
      },
    };
  },

  response: async (response, request) => {
    const sentToken = new Headers(request.config.headers).get('x-auth-token');
    if (
      response.status === 401 &&
      isJwtProtectedRequest(request.url) &&
      sentToken &&
      sentToken === getToken() &&
      request.metadata?.authRevision === getAuthRevision()
    ) {
      // A delayed rejection must never invalidate a newer login, even with the same JWT.
      removeToken();
      invalidationListeners.forEach((listener) => listener());
    }

    return response;
  },

  error: async (error: Error) => {
    console.error('Auth interceptor error:', error);
    return error;
  },
};

// Install the auth interceptor
export const installAuthInterceptor = (): void => {
  addInterceptor(authInterceptor);
};

// Uninstall the auth interceptor
export const uninstallAuthInterceptor = (): void => {
  removeInterceptor(authInterceptor);
};

// Logging interceptor for development
export const loggingInterceptor: FetchInterceptor = {
  request: async (url: string, config: RequestInit) => {
    console.log('🚀 Request', { method: config.method || 'GET', url, config });
    return { url, config };
  },

  response: async (response: Response) => {
    console.log(`✅ [${response.status}] ${response.url}`);
    return response;
  },

  error: async (error: Error) => {
    console.error('❌ Fetch error', { error });
    return error;
  },
};

// Install the logging interceptor (only in development)
export const installLoggingInterceptor = (): void => {
  if (process.env.NODE_ENV === 'development') {
    addInterceptor(loggingInterceptor);
  }
};

// Uninstall the logging interceptor
export const uninstallLoggingInterceptor = (): void => {
  removeInterceptor(loggingInterceptor);
};
