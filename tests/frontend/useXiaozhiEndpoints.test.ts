import type { DependencyList, SetStateAction } from 'react';
import type { XiaozhiEndpoint, XiaozhiEndpointStatus } from '../../src/types/index.js';
import type { ApiResponse } from '../../frontend/src/types/index.js';

// Keep hook state and effect cleanup observable without installing a browser renderer.
let mockStateIndex = 0;
let mockRefIndex = 0;
let mockCallbackIndex = 0;
let mockEffectIndex = 0;
let mockStates: Array<{ value: unknown }> = [];
let mockRefs: Array<{ current: unknown }> = [];
let mockCallbacks: Array<{ deps: DependencyList; value: unknown }> = [];
let mockEffects: Array<{ deps?: DependencyList; cleanup?: () => void }> = [];
let mockPendingEffects: Array<() => void> = [];
let mockDirty = true;
let mockMounted = true;
let mockUpdatesAfterUnmount = 0;
const mockApiGet = jest.fn<Promise<unknown>, [string, RequestInit?]>();
const mockApiPost = jest.fn<Promise<unknown>, [string, unknown?]>();
const mockApiPut = jest.fn<Promise<unknown>, [string, unknown?]>();
const mockApiDelete = jest.fn<Promise<unknown>, [string]>();
const mockShowToast = jest.fn();
const mockTranslate = (key: string) => key;
const mockSameDeps = (left: DependencyList, right?: DependencyList) =>
  right !== undefined &&
  left.length === right.length &&
  left.every((dep, i) => Object.is(dep, right[i]));

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: <T>(initial: T | (() => T)) => {
    const index = mockStateIndex++;
    mockStates[index] ??= {
      value: typeof initial === 'function' ? (initial as () => T)() : initial,
    };
    const slot = mockStates[index];
    return [
      slot.value as T,
      (update: SetStateAction<T>) => {
        if (!mockMounted) mockUpdatesAfterUnmount++;
        const next =
          typeof update === 'function' ? (update as (previous: T) => T)(slot.value as T) : update;
        if (!Object.is(slot.value, next)) {
          slot.value = next;
          mockDirty = true;
        }
      },
    ];
  },
  useRef: <T>(initial: T) => {
    const index = mockRefIndex++;
    mockRefs[index] ??= { current: initial };
    return mockRefs[index];
  },
  useCallback: <T>(callback: T, deps: DependencyList) => {
    const index = mockCallbackIndex++;
    if (!mockSameDeps(deps, mockCallbacks[index]?.deps)) {
      mockCallbacks[index] = { deps, value: callback };
    }
    return mockCallbacks[index].value;
  },
  useEffect: (effect: () => void | (() => void), deps: DependencyList) => {
    const index = mockEffectIndex++;
    const previous = mockEffects[index];
    if (mockSameDeps(deps, previous?.deps)) return;
    mockPendingEffects.push(() => {
      previous?.cleanup?.();
      mockEffects[index] = { deps, cleanup: effect() || undefined };
    });
  },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: mockTranslate }) }));
jest.mock('../../frontend/src/contexts/ToastContext.js', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));
jest.mock('../../frontend/src/utils/fetchInterceptor.js', () => ({
  apiGet: mockApiGet,
  apiPost: mockApiPost,
  apiPut: mockApiPut,
  apiDelete: mockApiDelete,
}));

import { useXiaozhiEndpoints } from '../../frontend/src/hooks/useXiaozhiEndpoints.js';

type Hook = ReturnType<typeof useXiaozhiEndpoints>;
let hook: Hook;
const renderHook = (): Hook => {
  for (let renders = 0; renders < 20; renders++) {
    mockDirty = false;
    mockStateIndex = mockRefIndex = mockCallbackIndex = mockEffectIndex = 0;
    hook = useXiaozhiEndpoints();
    const pending = mockPendingEffects;
    mockPendingEffects = [];
    pending.forEach((effect) => effect());
    if (!mockDirty) return hook;
  }
  throw new Error('Hook did not settle');
};
const unmountHook = () => {
  mockEffects.forEach((effect) => effect.cleanup?.());
  mockEffects = [];
  mockMounted = false;
};
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
  if (mockMounted) renderHook();
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const endpoint: XiaozhiEndpoint = {
  id: 'local-fixture',
  name: 'Local fixture',
  enabled: true,
  webSocketUrl: 'ws://127.0.0.1:1/fixture',
  reconnect: { maxAttempts: 10, initialDelay: 2000, maxDelay: 60000, backoffMultiplier: 2 },
  createdAt: '2026-01-01T00:00:00Z',
};
const status = (connected: boolean, current = endpoint): XiaozhiEndpointStatus => ({
  endpoint: { ...current, status: connected ? 'connected' : 'disconnected' },
  connected,
  connectionCount: connected ? 1 : 0,
});
const success = <T>(data: T): ApiResponse<T> => ({ success: true, data });
const statusPath = '/xiaozhi/endpoints/status/all';
let currentEndpoints: XiaozhiEndpoint[];
let statusResponse: () => Promise<ApiResponse<XiaozhiEndpointStatus[]>>;
let timeoutSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  timeoutSpy = jest
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation(() => new AbortController().signal);
  mockStates = [];
  mockRefs = [];
  mockCallbacks = [];
  mockEffects = [];
  mockPendingEffects = [];
  mockDirty = true;
  mockMounted = true;
  mockUpdatesAfterUnmount = 0;
  currentEndpoints = [{ ...endpoint }];
  statusResponse = async () => success([status(true)]);
  mockApiGet.mockReset().mockImplementation(async (path) => {
    if (path === '/xiaozhi/config') return success({ enabled: true, endpoints: currentEndpoints });
    if (path === '/xiaozhi/endpoints') return success(currentEndpoints);
    if (path === statusPath) return statusResponse();
    throw new Error(`Unexpected fixture route: ${path}`);
  });
  mockApiPost.mockReset().mockResolvedValue({ success: true });
  mockApiPut.mockReset().mockResolvedValue({ success: true });
  mockApiDelete.mockReset().mockResolvedValue({ success: true });
});
afterEach(() => {
  if (mockMounted) unmountHook();
  timeoutSpy.mockRestore();
  jest.useRealTimers();
});

it('fetches live status without cache and with a ten-second timeout', async () => {
  renderHook();
  await settle();
  expect(timeoutSpy).toHaveBeenCalledWith(10000);
  expect(mockApiGet).toHaveBeenCalledWith(statusPath, {
    cache: 'no-store',
    signal: expect.any(AbortSignal),
  });
  expect(hook.getConnectedCount()).toBe(1);
  expect(hook.statusError).toBe(false);
});

it.each(['unsuccessful response', 'network error'])(
  'clears a connected snapshot on %s and recovers on the next poll',
  async (failure) => {
    renderHook();
    await settle();
    statusResponse =
      failure === 'network error'
        ? async () => {
            throw new Error('Fixture unavailable');
          }
        : async () => ({ success: false });
    await jest.advanceTimersByTimeAsync(5000);
    await settle();
    expect(hook.endpointStatuses).toEqual([]);
    expect(hook.getEndpointStatusById(endpoint.id)).toBeUndefined();
    expect(hook.getConnectedCount()).toBe(0);
    expect(hook.statusError).toBe(true);
    statusResponse = async () => success([status(true)]);
    await jest.advanceTimersByTimeAsync(5000);
    await settle();
    expect(hook.getConnectedCount()).toBe(1);
    expect(hook.statusError).toBe(false);
  },
);

it.each(['success', 'failure'])(
  'ignores an older delayed %s after a newer status response',
  async (result) => {
    const pending = deferred<ApiResponse<XiaozhiEndpointStatus[]>>();
    statusResponse = () => pending.promise;
    renderHook();
    await settle();
    statusResponse = async () => success([status(false)]);
    await hook.fetchEndpointStatuses();
    await settle();
    if (result === 'success') pending.resolve(success([status(true)]));
    else pending.reject(new Error('Obsolete request failed'));
    await settle();
    expect(hook.getEndpointStatusById(endpoint.id)?.connected).toBe(false);
    expect(hook.statusError).toBe(false);
  },
);

it('keeps applying six-second responses while polling every five seconds', async () => {
  let requested = 0;
  statusResponse = () => {
    const response = success([{ ...status(true), lastConnected: `sample-${++requested}` }]);
    return new Promise((resolve) => setTimeout(() => resolve(response), 6000));
  };
  renderHook();
  await settle();
  await jest.advanceTimersByTimeAsync(5000);
  await settle();
  expect(requested).toBe(2);
  expect(hook.endpointStatuses).toEqual([]);
  await jest.advanceTimersByTimeAsync(1000);
  await settle();
  expect(hook.getEndpointStatusById(endpoint.id)?.lastConnected).toBe('sample-1');
  expect(hook.getConnectedCount()).toBe(1);
  for (let sample = 2; sample <= 5; sample++) {
    await jest.advanceTimersByTimeAsync(5000);
    await settle();
    expect(hook.getEndpointStatusById(endpoint.id)?.lastConnected).toBe(`sample-${sample}`);
    expect(hook.statusError).toBe(false);
  }
});

it('expires the last successful sample after fifteen seconds while later polls hang', async () => {
  renderHook();
  await settle();
  const pending = deferred<ApiResponse<XiaozhiEndpointStatus[]>>();
  statusResponse = () => pending.promise;
  await jest.advanceTimersByTimeAsync(14999);
  await settle();
  expect(hook.getConnectedCount()).toBe(1);
  await jest.advanceTimersByTimeAsync(1);
  await settle();
  expect(hook.getConnectedCount()).toBe(0);
  expect(hook.endpointStatuses).toEqual([]);
  expect(hook.statusError).toBe(true);
  pending.resolve(success([status(true)]));
  await settle();
  expect(hook.getConnectedCount()).toBe(1);
  expect(hook.statusError).toBe(false);
});

it('counts only enabled endpoints still present in the current endpoint list', async () => {
  const disabled = { ...endpoint, id: 'disabled-fixture', enabled: false };
  const removed = { ...endpoint, id: 'removed-fixture' };
  currentEndpoints = [endpoint, disabled];
  statusResponse = async () =>
    success([status(true), status(true, disabled), status(true, removed)]);
  renderHook();
  await settle();
  expect(hook.endpointStatuses).toHaveLength(3);
  expect(hook.getEnabledCount()).toBe(1);
  expect(hook.getConnectedCount()).toBe(1);
  currentEndpoints = [];
  await hook.fetchEndpoints();
  await settle();
  expect(hook.getConnectedCount()).toBe(0);
});

it.each(['success', 'failure'])(
  'ignores a pending status %s after unmount and clears timers',
  async (result) => {
    renderHook();
    await settle();
    const pending = deferred<ApiResponse<XiaozhiEndpointStatus[]>>();
    statusResponse = () => pending.promise;
    const request = hook.fetchEndpointStatuses();
    unmountHook();
    expect(jest.getTimerCount()).toBe(0);
    if (result === 'success') pending.resolve(success([status(false)]));
    else pending.reject(new Error('Request settled after unmount'));
    await request;
    await settle();
    expect(mockUpdatesAfterUnmount).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it('completes manual reconnect from the shared status poll without a second polling loop', async () => {
  renderHook();
  await settle();
  statusResponse = async () => success([status(false)]);
  expect(await hook.reconnectEndpoint(endpoint.id)).toBe(true);
  await settle();
  expect(hook.isEndpointReconnecting(endpoint.id)).toBe(true);
  expect(mockApiPost).toHaveBeenCalledWith(`/xiaozhi/endpoints/${endpoint.id}/reconnect`, {});
  const beforePoll = mockApiGet.mock.calls.filter(([path]) => path === statusPath).length;
  await jest.advanceTimersByTimeAsync(2000);
  await settle();
  expect(mockApiGet.mock.calls.filter(([path]) => path === statusPath)).toHaveLength(beforePoll);
  statusResponse = async () => success([status(true)]);
  await jest.advanceTimersByTimeAsync(3000);
  await settle();
  expect(hook.isEndpointReconnecting(endpoint.id)).toBe(false);
  expect(hook.getConnectedCount()).toBe(1);
});

it('releases reconnect feedback after thirty seconds and clears it on unmount', async () => {
  statusResponse = async () => success([status(false)]);
  renderHook();
  await settle();
  await hook.reconnectEndpoint(endpoint.id);
  await settle();
  expect(hook.isEndpointReconnecting(endpoint.id)).toBe(true);
  await jest.advanceTimersByTimeAsync(30000);
  await settle();
  expect(hook.isEndpointReconnecting(endpoint.id)).toBe(false);
  unmountHook();
  expect(jest.getTimerCount()).toBe(0);
});
