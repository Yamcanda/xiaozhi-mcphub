import { EventEmitter } from 'node:events';
import type XiaozhiEndpointEntity from '../../src/db/entities/XiaozhiEndpoint.js';

const handleListToolsRequest = jest.fn();
const handleCallToolRequest = jest.fn();
const getSmartRoutingConfig = jest.fn(async () => ({ enabled: false }));
const isDatabaseConnected = jest.fn(() => false);
const updateStatus = jest.fn();
const findAll = jest.fn();
const getConfig = jest.fn();
const updateById = jest.fn();
const deleteEndpoint = jest.fn();

class MockWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  send = jest.fn((_data: string, callback?: (error?: Error) => void) => callback?.());
  ping = jest.fn((callback?: (error?: Error) => void) => callback?.());
  close = jest.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
  // Intentionally no close event: heartbeat failure must invalidate state immediately.
  terminate = jest.fn(() => {});
  constructor(_url: string) {
    super();
    MockWebSocket.instances.push(this);
  }
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open');
  }
  remoteClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
  message(method: string, id = 1): void {
    this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, id })));
  }
}

jest.mock('ws', () => ({ __esModule: true, default: MockWebSocket }));
jest.mock('../../src/services/mcpService.js', () => ({
  handleListToolsRequest,
  handleCallToolRequest,
}));
jest.mock('../../src/utils/smartRouting.js', () => ({ getSmartRoutingConfig }));
jest.mock('../../src/db/connection.js', () => ({ isDatabaseConnected }));
jest.mock('../../src/db/repositories/index.js', () => ({
  getXiaozhiConfigRepository: () => ({ getConfig }),
  getXiaozhiEndpointRepository: () => ({
    findAll,
    save: jest.fn(),
    updateById,
    delete: deleteEndpoint,
    updateStatus,
  }),
}));

const endpoint = {
  id: 'test-endpoint',
  name: 'local-fixture',
  enabled: true,
  webSocketUrl: 'ws://127.0.0.1:1/fixture',
  owner: 'fixture-user',
  status: 'connected',
  reconnect: { maxAttempts: 10, initialDelay: 2000, maxDelay: 60000, backoffMultiplier: 2 },
  createdAt: new Date('2026-01-01T00:00:00Z'),
} as XiaozhiEndpointEntity;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('xiaozhiEndpointService', () => {
  let service: typeof import('../../src/services/xiaozhiEndpointService.js').xiaozhiEndpointService;
  let restoreEnvironment: NodeJS.ProcessEnv;
  const status = () => service.getEndpointStatus(endpoint.id)!;
  const connect = async () => {
    isDatabaseConnected.mockReturnValue(true);
    await service.initializeEndpoints();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.open();
    await settle();
    return socket;
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.resetModules();
    restoreEnvironment = { ...process.env };
    process.env.XIAOZHI_RECONNECT_JITTER_RATIO = '0';
    process.env.XIAOZHI_AGGRESSIVE_RECONNECT = 'false';
    isDatabaseConnected.mockReturnValue(false);
    findAll.mockReset().mockResolvedValue([{ ...endpoint }]);
    getConfig.mockReset().mockResolvedValue({ enabled: true });
    updateStatus.mockReset().mockResolvedValue(undefined);
    updateById.mockReset().mockResolvedValue(endpoint);
    deleteEndpoint.mockReset().mockResolvedValue(true);
    handleListToolsRequest.mockReset().mockResolvedValue({ tools: [] });
    handleCallToolRequest.mockReset().mockResolvedValue({ content: [] });
    getSmartRoutingConfig.mockReset().mockResolvedValue({ enabled: false });
    MockWebSocket.instances = [];
    ({ xiaozhiEndpointService: service } = await import(
      '../../src/services/xiaozhiEndpointService.js'
    ));
  });
  afterEach(async () => {
    await service.disconnect();
    await settle();
    jest.useRealTimers();
    process.env = restoreEnvironment;
  });

  it('exposes a health summary without throwing when DB is off', () => {
    expect(service.getHealthSummary()).toMatchObject({
      available: false,
      enabledTotal: 0,
      connected: 0,
      disconnected: 0,
      pendingReconnects: 0,
    });
  });
  it('reports aggregate status with enabled/connected flags', () => {
    expect(service.getAggregateStatus()).toMatchObject({
      enabled: false,
      connected: false,
      endpoints: [],
    });
  });
  it('filters endpoints for non-admin users by owner', () => {
    expect(service.getEndpointsForUser('__no_such_user__', false)).toEqual([]);
  });
  it('preloads configuration without opening a socket or trusting persisted connected status', async () => {
    isDatabaseConnected.mockReturnValue(true);
    await service.preloadConfig();
    expect(service.isEnabled()).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(status()).toMatchObject({ connected: false, endpoint: { status: 'disconnected' } });
    expect(service.getAggregateStatus().endpoints[0].status).toBe('disconnected');
  });
  it('does not replace an active socket on repeated initialization', async () => {
    const socket = await connect();
    await service.initializeEndpoints();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
  });
  it('terminates a missing-pong socket and schedules exactly one reconnect without a close event', async () => {
    const socket = await connect();
    await jest.advanceTimersByTimeAsync(30000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(status()).toMatchObject({ connected: false, endpoint: { status: 'disconnected' } });
    expect(status().error).toContain('Heartbeat timed out');
    expect(service.getHealthSummary()).toMatchObject({ connected: 0, pendingReconnects: 1 });
    socket.emit('error', new Error('late socket error'));
    socket.remoteClose();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
  it('keeps a pong-responsive connection alive across multiple heartbeat cycles', async () => {
    const socket = await connect();
    socket.ping.mockImplementation((callback) => {
      socket.emit('pong');
      callback?.();
    });
    await jest.advanceTimersByTimeAsync(70000);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(status().connected).toBe(true);
    expect(status().runtime?.lastPongAt).toBeDefined();
  });
  it('fails immediately on a ping write error', async () => {
    const socket = await connect();
    socket.ping.mockImplementation((callback) => callback?.(new Error('write failed')));
    await jest.advanceTimersByTimeAsync(30000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(status().connected).toBe(false);
    expect(status().error).toContain('write failed');
  });
  it('updates live status before a slow persistence write and never lets old completion overwrite a new socket', async () => {
    const socket = await connect();
    const pending = deferred<void>();
    updateStatus.mockImplementationOnce(() => pending.promise);
    socket.remoteClose(1009, 'message too big');
    await settle();
    expect(status()).toMatchObject({ connected: false, endpoint: { status: 'disconnected' } });
    expect(service.getAggregateStatus().endpoints[0].status).toBe('disconnected');
    expect(service.getHealthSummary().connected).toBe(0);
    await service.reconnectEndpoint(endpoint.id);
    MockWebSocket.instances.at(-1)!.open();
    pending.resolve();
    await settle();
    expect(status()).toMatchObject({ connected: true, endpoint: { status: 'connected' } });
    expect(updateStatus.mock.calls.at(-1)?.[1]).toBe('connected');
  });
  it('ignores saved callbacks from an obsolete socket, including queued heartbeat work', async () => {
    const socket = await connect();
    const open = socket.listeners('open')[0];
    const close = socket.listeners('close')[0];
    const error = socket.listeners('error')[0];
    const message = socket.listeners('message')[0];
    await service.reconnectEndpoint(endpoint.id);
    const replacement = MockWebSocket.instances.at(-1)!;
    replacement.open();
    open();
    close(1009, Buffer.from('obsolete'));
    error(new Error('obsolete'));
    message(Buffer.from('{"method":"tools/list","id":3}'));
    await settle();
    expect(handleListToolsRequest).not.toHaveBeenCalled();
    expect(status()).toMatchObject({ connected: true, error: undefined });
    expect(status().runtime?.lastCloseCode).toBeUndefined();
    await jest.advanceTimersByTimeAsync(30000);
    expect(socket.ping).not.toHaveBeenCalled();
    expect(replacement.ping).toHaveBeenCalledTimes(1);
    expect(service.getHealthSummary().pendingReconnects).toBe(0);
  });
  it.each(['tools/list', 'tools/call'])(
    'does not deliver a late %s response to a replacement socket',
    async (method) => {
      const socket = await connect();
      const pending = deferred<unknown>();
      (method === 'tools/list'
        ? handleListToolsRequest
        : handleCallToolRequest
      ).mockReturnValueOnce(pending.promise);
      socket.message(method);
      await settle();
      await service.reconnectEndpoint(endpoint.id);
      const replacement = MockWebSocket.instances.at(-1)!;
      replacement.open();
      replacement.send.mockClear();
      pending.resolve({ tools: [] });
      await settle();
      expect(replacement.send).not.toHaveBeenCalled();
      expect(status().runtime?.toolsListSentAt).toBeUndefined();
      replacement.message('ping', 2);
      await settle();
      expect(replacement.send).toHaveBeenCalledWith(
        expect.stringContaining('"id":2'),
        expect.any(Function),
      );
    },
  );
  it('ignores a late tool failure and does not start tools after a stale routing lookup', async () => {
    const socket = await connect();
    const pending = deferred<unknown>();
    handleCallToolRequest.mockReturnValueOnce(pending.promise);
    socket.message('tools/call');
    await settle();
    await service.reconnectEndpoint(endpoint.id);
    MockWebSocket.instances.at(-1)!.open();
    pending.reject(new Error('obsolete failure'));
    await settle();
    expect(status().error).toBeUndefined();
    const routing = deferred<{ enabled: boolean }>();
    getSmartRoutingConfig.mockReturnValueOnce(routing.promise);
    MockWebSocket.instances.at(-1)!.message('tools/call');
    await settle();
    await service.reconnectEndpoint(endpoint.id);
    MockWebSocket.instances.at(-1)!.open();
    routing.resolve({ enabled: false });
    await settle();
    expect(handleCallToolRequest).toHaveBeenCalledTimes(1);
  });
  it('retains close history across reopen and records tools/list only after a successful current write', async () => {
    const socket = await connect();
    expect(status().runtime?.toolsListSentAt).toBeUndefined();
    socket.remoteClose(1009, 'message too big');
    const closedAt = status().runtime?.lastCloseAt;
    await jest.advanceTimersByTimeAsync(2000);
    const replacement = MockWebSocket.instances.at(-1)!;
    replacement.open();
    expect(status().runtime).toMatchObject({
      lastCloseCode: 1009,
      lastCloseReason: 'message too big',
      lastCloseAt: closedAt,
    });
    let written!: (error?: Error) => void;
    replacement.send.mockImplementation((_data, callback) => {
      written = callback!;
    });
    replacement.message('tools/list');
    await settle();
    expect(status().runtime?.toolsListSentAt).toBeUndefined();
    written(new Error('write rejected'));
    await settle();
    expect(status().runtime?.toolsListSentAt).toBeUndefined();
    replacement.message('tools/list', 2);
    await settle();
    written();
    await settle();
    expect(status().runtime?.toolsListSentAt).toBeDefined();
    expect(status().connected).toBe(true);
  });
  it.each(['disconnect', 'disable', 'delete'])(
    'clears heartbeat and reconnect timers on %s',
    async (action) => {
      const socket = await connect();
      await jest.advanceTimersByTimeAsync(30000);
      if (action === 'disconnect') await service.disconnect();
      if (action === 'disable') await service.updateEndpoint(endpoint.id, { enabled: false });
      if (action === 'delete') await service.deleteEndpoint(endpoint.id);
      await jest.advanceTimersByTimeAsync(60000);
      expect(socket.terminate).not.toHaveBeenCalled();
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(jest.getTimerCount()).toBe(0);
      expect(service.getHealthSummary().pendingReconnects).toBe(0);
    },
  );
  it('absorbs asynchronous handshake-abort errors after teardown', async () => {
    isDatabaseConnected.mockReturnValue(true);
    await service.initializeEndpoints();
    const socket = MockWebSocket.instances[0];
    socket.close.mockImplementation(() => {
      queueMicrotask(() => socket.emit('error', new Error('handshake aborted')));
    });
    await service.disconnect();
    await settle();
    expect(service.getHealthSummary().pendingReconnects).toBe(0);
    expect(status().connected).toBe(false);
  });
});
