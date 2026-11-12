jest.mock('../../frontend/src/services/betterAuthClient.js', () => ({
  authClient: { signOut: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../frontend/src/utils/runtime.js', () => ({
  getApiUrl: (endpoint: string) => `/api${endpoint}`,
}));

import {
  getBetterAuthUser,
  getCurrentUser,
  login,
} from '../../frontend/src/services/authService.js';
import { clearInterceptors } from '../../frontend/src/utils/fetchInterceptor.js';

const originalFetch = global.fetch;
const originalStorage = global.localStorage;
const fetchMock = jest.fn<typeof fetch>();
const setItem = jest.fn();

beforeEach(() => {
  clearInterceptors();
  fetchMock.mockReset();
  global.fetch = fetchMock;
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'current-token', setItem, removeItem: jest.fn() },
  });
});

afterAll(() => {
  global.fetch = originalFetch;
  Object.defineProperty(global, 'localStorage', { configurable: true, value: originalStorage });
});

it('leaves login token commitment to the provider so stale login results cannot restore sessions', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, token: 'new-token' })));
  expect((await login({ username: 'test', password: 'fixture-password' })).success).toBe(true);
  expect(setItem).not.toHaveBeenCalled();
});

it.each([getCurrentUser, getBetterAuthUser])(
  'treats only explicit 401 as an absent session',
  async (getUser) => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(getUser()).resolves.toEqual({ success: false });
  },
);

it.each([500, 502, 503])('does not misreport HTTP %s as invalid credentials', async (status) => {
  fetchMock.mockResolvedValue(new Response('{}', { status }));
  await expect(getCurrentUser()).rejects.toThrow('Unable to verify');
});

it('preserves the distinction between a network failure and an absent session', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(getCurrentUser()).rejects.toThrow('Failed to fetch');
});

it('rejects malformed successful responses instead of logging the user out', async () => {
  fetchMock.mockResolvedValue(new Response('{"success":false}'));
  await expect(getCurrentUser()).rejects.toThrow('Invalid session response');
});

it('returns a verified user', async () => {
  const user = { username: 'verified', isAdmin: false };
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, user })));
  await expect(getCurrentUser()).resolves.toEqual({ success: true, user });
});
