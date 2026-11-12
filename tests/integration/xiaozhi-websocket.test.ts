import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import type XiaozhiEndpointEntity from '../../src/db/entities/XiaozhiEndpoint.js';

const findAll = jest.fn();
const updateStatus = jest.fn(async () => {});
const handleListToolsRequest = jest.fn(async () => ({
  tools: [{ name: 'fixture_echo', description: 'Local fixture', inputSchema: { type: 'object' } }],
}));
const handleCallToolRequest = jest.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));

jest.mock('../../src/db/connection.js', () => ({ isDatabaseConnected: () => true }));
jest.mock('../../src/db/repositories/index.js', () => ({
  getXiaozhiConfigRepository: () => ({ getConfig: async () => ({ enabled: true }) }),
  getXiaozhiEndpointRepository: () => ({ findAll, updateStatus }),
}));
jest.mock('../../src/services/mcpService.js', () => ({
  handleListToolsRequest,
  handleCallToolRequest,
}));
jest.mock('../../src/utils/smartRouting.js', () => ({
  getSmartRoutingConfig: async () => ({ enabled: false }),
}));

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error('Timed out waiting for local WebSocket I/O');
};

describe('Xiaozhi real WebSocket lifecycle', () => {
  let server: WebSocketServer;
  let service: typeof import('../../src/services/xiaozhiEndpointService.js').xiaozhiEndpointService;
  let originalEnvironment: NodeJS.ProcessEnv;
  let peers: WebSocket[];
  let messages: Array<Record<string, unknown>>;
  let pingCount: number;
  let respondToPing: boolean;
  const endpointId = 'local-websocket-fixture';
  const status = () => service.getEndpointStatus(endpointId)!;

  beforeEach(async () => {
    jest.resetModules();
    originalEnvironment = { ...process.env };
    process.env.XIAOZHI_AGGRESSIVE_RECONNECT = 'false';
    process.env.XIAOZHI_RECONNECT_JITTER_RATIO = '0';
    peers = [];
    messages = [];
    pingCount = 0;
    respondToPing = true;
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    server.on('connection', (peer) => {
      peers.push(peer);
      peer.on('ping', (data) => {
        pingCount++;
        if (respondToPing) peer.pong(data);
      });
      peer.on('message', (data) => messages.push(JSON.parse(data.toString())));
    });
    const port = (server.address() as AddressInfo).port;
    findAll.mockResolvedValue([
      {
        id: endpointId,
        name: 'local-fixture',
        enabled: true,
        webSocketUrl: `ws://127.0.0.1:${port}/fixture`,
        owner: 'fixture-user',
        status: 'connected',
        reconnect: {
          maxAttempts: 3,
          infiniteReconnect: false,
          initialDelay: 2000,
          maxDelay: 60000,
          backoffMultiplier: 2,
        },
        createdAt: new Date('2026-01-01T00:00:00Z'),
      } as XiaozhiEndpointEntity,
    ]);
    ({ xiaozhiEndpointService: service } = await import(
      '../../src/services/xiaozhiEndpointService.js'
    ));
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    await service.initializeEndpoints();
    await waitFor(() => status().connected && peers.length === 1);
  });

  afterEach(async () => {
    await service.disconnect();
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    jest.useRealTimers();
    process.env = originalEnvironment;
  });

  it('round-trips MCP requests and retains a remote close diagnostic after reconnect', async () => {
    const peer = peers[0];
    peer.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await waitFor(() => messages.some((message) => message.id === 1));
    expect(messages.find((message) => message.id === 1)).toMatchObject({
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } },
    });
    expect(status().runtime?.toolsListSentAt).toBeUndefined();

    peer.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    await waitFor(() => messages.some((message) => message.id === 2));
    expect(messages.find((message) => message.id === 2)).toMatchObject({
      result: { tools: [{ name: 'fixture_echo' }] },
    });
    expect(status().runtime?.toolsListSentAt).toBeDefined();

    peer.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'fixture_echo' },
      }),
    );
    await waitFor(() => messages.some((message) => message.id === 3));
    expect(messages.find((message) => message.id === 3)).toMatchObject({
      result: { content: [{ type: 'text', text: 'ok' }] },
    });

    peer.close(1009, 'fixture message too big');
    // CLOSING already reports disconnected; diagnostics arrive with the close event.
    await waitFor(() => !status().connected && status().runtime?.lastCloseCode !== undefined);
    expect(status()).toMatchObject({
      endpoint: { status: 'disconnected' },
      runtime: { lastCloseCode: 1009, lastCloseReason: 'fixture message too big' },
    });
    const closedAt = status().runtime?.lastCloseAt;
    expect(closedAt).toBeDefined();
    expect(service.getAggregateStatus().connected).toBe(false);
    expect(service.getHealthSummary().pendingReconnects).toBe(1);

    await jest.advanceTimersByTimeAsync(2000);
    await waitFor(() => peers.length === 2 && status().connected);
    expect(status().runtime).toMatchObject({
      lastCloseCode: 1009,
      lastCloseAt: closedAt,
      lastCloseReason: 'fixture message too big',
    });
    expect(status().runtime?.toolsListSentAt).toBeUndefined();
  });

  it('keeps a peer alive only when actual control-frame pongs return', async () => {
    for (let cycle = 1; cycle <= 3; cycle++) {
      const previousPong = status().runtime?.lastPongAt;
      await jest.advanceTimersByTimeAsync(30000);
      await waitFor(() => pingCount === cycle && status().runtime?.lastPongAt !== previousPong);
      expect(status().connected).toBe(true);
    }
    expect(peers).toHaveLength(1);
    expect(service.getHealthSummary().pendingReconnects).toBe(0);
  });

  it('terminates a silent open peer after the pong deadline and reconnects once', async () => {
    respondToPing = false;
    await jest.advanceTimersByTimeAsync(30000);
    await waitFor(() => pingCount === 1);
    expect(status().connected).toBe(true);
    expect(status().runtime?.lastPongAt).toBeUndefined();
    await jest.advanceTimersByTimeAsync(9999);
    expect(status().connected).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    expect(status()).toMatchObject({
      connected: false,
      endpoint: { status: 'disconnected' },
      error: 'Heartbeat timed out: no pong within 10000ms',
    });
    await waitFor(() => peers[0].readyState === WebSocket.CLOSED);
    expect(service.getHealthSummary()).toMatchObject({ connected: 0, pendingReconnects: 1 });
    respondToPing = true;
    await jest.advanceTimersByTimeAsync(2000);
    await waitFor(() => peers.length === 2 && status().connected);
    expect(service.getHealthSummary().pendingReconnects).toBe(0);
  });
});
