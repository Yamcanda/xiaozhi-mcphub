import {
  authInterceptor,
  getToken,
  removeToken,
  setToken,
  subscribeAuthInvalidation,
} from '../../frontend/src/utils/interceptors.js';
import {
  addInterceptor,
  clearInterceptors,
  fetchWithInterceptors,
} from '../../frontend/src/utils/fetchInterceptor.js';

jest.mock('../../frontend/src/utils/runtime.js', () => ({
  getApiUrl: (endpoint: string) => `/hub/api${endpoint}`,
}));

const originalStorage = global.localStorage;
const originalWindow = global.window;
const originalFetch = global.fetch;
const values = new Map<string, string>();
const fetchMock = jest.fn<typeof fetch>();

beforeEach(() => {
  values.clear();
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  global.window = { location: { origin: 'http://localhost:5173' } } as Window & typeof globalThis;
  fetchMock.mockReset();
  global.fetch = fetchMock;
  clearInterceptors();
  addInterceptor(authInterceptor);
  // A later interceptor must not discard request authentication metadata.
  addInterceptor({ request: async (url, config) => ({ url, config }) });
});

afterAll(() => {
  clearInterceptors();
  Object.defineProperty(global, 'localStorage', { configurable: true, value: originalStorage });
  global.window = originalWindow;
  global.fetch = originalFetch;
});

it.each([
  '/hub/api/better-auth/user',
  '/hub/api/auth/login',
  '/hub/api/auth/register',
  '/hub/api/auth/verify-email',
  '/hub/api/auth/forgot-password',
  '/hub/api/auth/verify-reset-token',
  '/hub/api/auth/reset-password',
  '/hub/public-config',
  'https://example.com/hub/api/servers',
])('does not revoke the dashboard JWT for an independent 401 from %s', async (url) => {
  setToken('current-token');
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
  await fetchWithInterceptors(url);
  expect(getToken()).toBe('current-token');
});

it.each([null, 'old-token', 'same-token'])(
  'ignores delayed 401 after login, including identical same-second JWTs (%s)',
  async (oldToken) => {
    if (oldToken) setToken(oldToken);
    let release!: (response: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const operation = fetchWithInterceptors('/hub/api/servers');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    setToken(oldToken === 'same-token' ? 'same-token' : 'new-token');
    release(new Response('{}', { status: 401 }));
    await operation;
    expect(getToken()).toBe(oldToken === 'same-token' ? 'same-token' : 'new-token');
  },
);

it('preserves an identical-token login committed by another tab before a delayed 401', async () => {
  let otherTab!: typeof import('../../frontend/src/utils/interceptors.js');
  jest.isolateModules(() => {
    otherTab = jest.requireActual('../../frontend/src/utils/interceptors.js');
  });
  setToken('same-second-token');
  let release!: (response: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const operation = fetchWithInterceptors('/hub/api/servers');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  otherTab.setToken('same-second-token');
  release(new Response('{}', { status: 401 }));
  await operation;
  expect(getToken()).toBe('same-second-token');
});

it('removes genuinely rejected current credentials and notifies the auth provider once', async () => {
  setToken('rejected-token');
  const listener = jest.fn();
  const unsubscribe = subscribeAuthInvalidation(listener);
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
  try {
    await fetchWithInterceptors('/hub/api/servers');
    await fetchWithInterceptors('/hub/api/groups');
    expect(getToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

it.each([200, 403, 500, 503])('preserves credentials on HTTP %s', async (status) => {
  setToken('current-token');
  fetchMock.mockResolvedValue(new Response('{}', { status }));
  await fetchWithInterceptors('/hub/api/servers');
  expect(getToken()).toBe('current-token');
});

it('preserves credentials on network failure', async () => {
  setToken('current-token');
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(fetchWithInterceptors('/hub/api/servers')).rejects.toThrow('Failed to fetch');
  expect(getToken()).toBe('current-token');
});

it('does not resurrect credentials after logout and a late response', async () => {
  setToken('old-token');
  let release!: (response: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const operation = fetchWithInterceptors('/hub/api/servers');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  removeToken();
  release(new Response('{}', { status: 401 }));
  await operation;
  expect(getToken()).toBeNull();
});
