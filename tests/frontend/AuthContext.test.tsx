import type { ReactElement } from 'react';
import type { AuthResponse, AuthState } from '../../frontend/src/types/index.js';

// Exercise provider operations and effect cleanup without installing a browser renderer.
const mockState = { value: undefined as AuthState | undefined };
const mockOperation = { current: 0 };
let mockEffectIndex = 0;
let mockEffects: Array<{ deps?: unknown[]; cleanup?: () => void }> = [];
const mockGetCurrentUser = jest.fn<Promise<AuthResponse>, []>();
const mockGetBetterAuthUser = jest.fn<Promise<AuthResponse>, []>();
const mockLogin = jest.fn<Promise<AuthResponse>, [unknown]>();
const mockRegister = jest.fn<Promise<AuthResponse>, [unknown]>();
const mockSetToken = jest.fn();
const mockLogout = jest.fn();
let mockToken: string | null = null;
let mockRevision = 0;
let mockInvalidation: (() => void) | undefined;

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: AuthState) => {
    mockState.value ??= initial;
    return [
      mockState.value,
      (value: AuthState) => {
        mockState.value = value;
      },
    ];
  },
  useRef: () => mockOperation,
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = mockEffectIndex++;
    const previous = mockEffects[index];
    if (previous && deps.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
    previous?.cleanup?.();
    mockEffects[index] = { deps, cleanup: effect() || undefined };
  },
}));
const mockGetPublicConfig = jest.fn().mockResolvedValue({ skipAuth: false });
jest.mock('../../frontend/src/services/configService.js', () => ({
  getPublicConfig: () => mockGetPublicConfig(),
}));
jest.mock('../../frontend/src/services/authService.js', () => ({
  getToken: () => mockToken,
  getAuthRevision: () => mockRevision,
  setToken: (token: string) => {
    mockSetToken(token);
    mockToken = token;
    mockRevision++;
  },
  subscribeAuthInvalidation: (listener: () => void) => {
    mockInvalidation = listener;
    return () => {
      mockInvalidation = undefined;
    };
  },
  getCurrentUser: () => mockGetCurrentUser(),
  getBetterAuthUser: () => mockGetBetterAuthUser(),
  login: (credentials: unknown) => mockLogin(credentials),
  register: (credentials: unknown) => mockRegister(credentials),
  logout: () => {
    mockLogout();
    mockToken = null;
    mockRevision++;
  },
}));

import { AuthProvider } from '../../frontend/src/contexts/AuthContext.js';

interface ProviderValue {
  auth: AuthState;
  login: (username: string, password: string) => Promise<{ success: boolean }>;
  register: (username: string, password: string) => Promise<{ success: boolean }>;
  logout: () => void;
}
const renderProvider = (): ProviderValue => {
  mockEffectIndex = 0;
  const element = AuthProvider({ children: null }) as ReactElement<{ value: ProviderValue }>;
  return element.props.value;
};
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const user = { username: 'test-user', isAdmin: false };
const loginResult = { success: true, token: 'valid-token', user };

beforeEach(() => {
  jest.useFakeTimers();
  mockState.value = undefined;
  mockOperation.current = 0;
  mockEffects = [];
  mockToken = null;
  mockRevision = 0;
  mockInvalidation = undefined;
  mockGetPublicConfig.mockReset().mockResolvedValue({ skipAuth: false });
  mockSetToken.mockClear();
  mockLogout.mockClear();
  mockGetCurrentUser.mockReset().mockResolvedValue({ success: false });
  mockGetBetterAuthUser.mockReset().mockResolvedValue({ success: false });
  mockLogin.mockReset().mockResolvedValue(loginResult);
  mockRegister.mockReset().mockResolvedValue(loginResult);
});
afterEach(() => {
  mockEffects.forEach((effect) => effect.cleanup?.());
  jest.useRealTimers();
});

it.each(['login', 'register'] as const)(
  'ignores a pre-login cookie probe that completes after %s',
  async (action) => {
    const probe = deferred<AuthResponse>();
    mockGetBetterAuthUser.mockReturnValue(probe.promise);
    const context = renderProvider();
    await settle();
    await context[action]('test-user', 'fixture-password');
    probe.resolve({ success: false });
    await settle();
    expect(renderProvider().auth).toMatchObject({ isAuthenticated: true, user });
    expect(mockToken).toBe('valid-token');
  },
);

it('ignores an old current-user failure after a newer login', async () => {
  mockToken = 'old-token';
  const probe = deferred<AuthResponse>();
  mockGetCurrentUser.mockReturnValue(probe.promise);
  const context = renderProvider();
  await settle();
  await context.login('test-user', 'fixture-password');
  probe.resolve({ success: false });
  await settle();
  expect(renderProvider().auth.isAuthenticated).toBe(true);
  expect(mockToken).toBe('valid-token');
  expect(mockGetBetterAuthUser).not.toHaveBeenCalled();
});

it.each(['login', 'register'] as const)(
  'does not let pending %s complete after explicit logout',
  async (action) => {
    const pending = deferred<AuthResponse>();
    if (action === 'login') mockLogin.mockReturnValue(pending.promise);
    else mockRegister.mockReturnValue(pending.promise);
    const context = renderProvider();
    await settle();
    const operation = context[action]('test-user', 'fixture-password');
    context.logout();
    pending.resolve(loginResult);
    await operation;
    expect(mockSetToken).not.toHaveBeenCalled();
    expect(renderProvider().auth.isAuthenticated).toBe(false);
  },
);

it('retries temporary session failures without deleting a token or granting unverified access', async () => {
  mockToken = 'existing-token';
  mockGetCurrentUser.mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue(loginResult);
  renderProvider();
  await settle();
  expect(mockToken).toBe('existing-token');
  expect(renderProvider().auth).toMatchObject({ isAuthenticated: false, loading: true });
  await jest.advanceTimersByTimeAsync(2000);
  expect(renderProvider().auth).toMatchObject({ isAuthenticated: true, loading: false, user });
});

it('does not apply a retry after logout', async () => {
  mockToken = 'existing-token';
  mockGetCurrentUser.mockRejectedValue(new Error('Failed to fetch'));
  const context = renderProvider();
  await settle();
  context.logout();
  await jest.advanceTimersByTimeAsync(2000);
  expect(renderProvider().auth.isAuthenticated).toBe(false);
  expect(mockSetToken).not.toHaveBeenCalled();
});

it('falls back to cookie auth after an explicitly rejected JWT during startup', async () => {
  mockToken = 'expired-token';
  mockGetCurrentUser.mockImplementation(async () => {
    mockToken = null;
    mockRevision++;
    mockInvalidation?.();
    return { success: false };
  });
  mockGetBetterAuthUser.mockResolvedValue({ success: true, user });
  renderProvider();
  await settle();
  expect(renderProvider().auth).toMatchObject({ isAuthenticated: true, loading: false, user });
});

it('continues restoration if credentials are rejected while public config is pending', async () => {
  mockToken = 'rejected-token';
  const config = deferred<{ skipAuth: boolean }>();
  mockGetPublicConfig.mockReturnValue(config.promise);
  renderProvider();
  mockToken = null;
  mockRevision++;
  mockInvalidation?.();
  config.resolve({ skipAuth: false });
  await settle();
  expect(renderProvider().auth).toMatchObject({ isAuthenticated: false, loading: false });
  expect(mockGetCurrentUser).not.toHaveBeenCalled();
  expect(mockGetBetterAuthUser).toHaveBeenCalledTimes(1);
});

it('does not authenticate a delayed startup success after concurrent invalidation', async () => {
  mockToken = 'rejected-token';
  const probe = deferred<AuthResponse>();
  mockGetCurrentUser.mockReturnValue(probe.promise);
  renderProvider();
  await settle();
  mockToken = null;
  mockRevision++;
  mockInvalidation?.();
  probe.resolve({ success: true, user });
  await settle();
  expect(renderProvider().auth).toMatchObject({ isAuthenticated: false, loading: false });
  expect(mockGetBetterAuthUser).toHaveBeenCalledTimes(1);
});

it('verifies a newer cross-tab session instead of applying an old startup result', async () => {
  mockToken = 'old-token';
  const probe = deferred<AuthResponse>();
  mockGetCurrentUser.mockReturnValueOnce(probe.promise).mockResolvedValue(loginResult);
  renderProvider();
  await settle();
  mockToken = 'new-token';
  mockRevision++;
  probe.resolve({ success: false });
  await settle();
  expect(renderProvider().auth).toMatchObject({ isAuthenticated: true, loading: false, user });
  expect(mockToken).toBe('new-token');
  expect(mockGetCurrentUser).toHaveBeenCalledTimes(2);
  expect(mockGetBetterAuthUser).not.toHaveBeenCalled();
});

it('synchronizes current-session rejection with React auth state', async () => {
  mockToken = 'valid-token';
  mockGetCurrentUser.mockResolvedValue(loginResult);
  renderProvider();
  await settle();
  expect(renderProvider().auth.isAuthenticated).toBe(true);
  mockInvalidation?.();
  expect(renderProvider().auth).toMatchObject({ isAuthenticated: false, loading: false });
});

it('ignores cancelled effect results as in development StrictMode', async () => {
  const probe = deferred<AuthResponse>();
  mockGetBetterAuthUser
    .mockReturnValueOnce(probe.promise)
    .mockResolvedValue({ success: true, user });
  renderProvider();
  await settle();
  mockEffects.forEach((effect) => effect.cleanup?.());
  mockEffects = [];
  renderProvider();
  await settle();
  probe.resolve({ success: false });
  await settle();
  expect(renderProvider().auth.isAuthenticated).toBe(true);
});
