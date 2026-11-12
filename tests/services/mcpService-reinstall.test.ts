const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockClear = jest.fn().mockResolvedValue(undefined);
const mockPrepare = jest.fn(async () => ({ targetDirectory: '/cache/target', clear: mockClear }));
const mockStopTree = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/utils/cacheUtils.js', () => ({
  supportsCacheRefresh: (command: string) => command === 'npx' || command === 'uvx',
  injectRefreshFlag: (command: string, args: string[]) =>
    command === 'uvx' ? ['--refresh', ...args] : args,
  prepareRunnerCacheClear: (...args: unknown[]) => mockPrepare(...args),
}));
jest.mock('../../src/utils/stdioProcess.js', () => ({
  stopStdioProcessTree: (...args: unknown[]) => mockStopTree(...args),
}));
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    getServerCapabilities: () => ({}),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));
const mockTransport = jest.fn();
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation((options: unknown) => {
    mockTransport(options);
    return { stderr: { on: jest.fn() }, close: jest.fn().mockResolvedValue(undefined) };
  }),
}));
jest.mock('../../src/services/oauthService.js', () => ({ initializeAllOAuthClients: jest.fn() }));
jest.mock('../../src/services/mcpOAuthProvider.js', () => ({ createOAuthProvider: jest.fn() }));
jest.mock('../../src/services/groupService.js', () => ({
  getServersInGroup: jest.fn(),
  getServerConfigInGroup: jest.fn(),
}));
jest.mock('../../src/services/sseService.js', () => ({ getGroup: jest.fn() }));
jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/services.js', () => ({
  getDataService: () => ({ filterData: (value: unknown) => value }),
}));
jest.mock('../../src/services/smartRoutingService.js', () => ({
  initSmartRoutingService: jest.fn(),
  getSmartRoutingTools: jest.fn(),
  handleSearchToolsRequest: jest.fn(),
  handleDescribeToolRequest: jest.fn(),
  isSmartRoutingGroup: () => false,
}));
jest.mock('../../src/services/keepAliveService.js', () => ({
  setupClientKeepAlive: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: () => ({ logToolCall: jest.fn() }),
}));
const mockDao = { findById: jest.fn(), findAll: jest.fn() };
jest.mock('../../src/dao/index.js', () => ({
  getServerDao: () => mockDao,
  getSystemConfigDao: () => ({ get: jest.fn().mockResolvedValue({}) }),
  getBuiltinPromptDao: () => ({ findEnabled: jest.fn().mockResolvedValue([]) }),
  getBuiltinResourceDao: () => ({ findEnabled: jest.fn().mockResolvedValue([]) }),
}));
jest.mock('../../src/config/index.js', () => ({
  expandEnvVars: (value: string) => value,
  replaceEnvVars: (value: unknown) => value,
  getNameSeparator: () => '::',
  default: { mcpHubName: 'test', mcpHubVersion: '1.0.0' },
}));

import {
  getServerByName,
  reinstallServer,
  setServerInfosForTest,
} from '../../src/services/mcpService.js';
import type { ServerConfig, ServerInfo } from '../../src/types/index.js';

const config = { name: 'target', command: 'npx', args: ['-y', 'firecrawl-mcp'], enabled: true };
const makeRuntime = (name = 'target'): ServerInfo => ({
  name,
  status: 'connected',
  error: null,
  tools: [{ name: 'old-tool', description: '', inputSchema: {} }],
  prompts: [],
  resources: [],
  createTime: Date.now(),
  client: { close: jest.fn().mockResolvedValue(undefined) } as unknown as ServerInfo['client'],
  transport: {
    pid: 12345,
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as ServerInfo['transport'],
});

describe('targeted reinstall safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepare
      .mockReset()
      .mockResolvedValue({ targetDirectory: '/cache/target', clear: mockClear });
    mockClear.mockReset().mockResolvedValue(undefined);
    mockStopTree.mockReset().mockResolvedValue(undefined);
    mockDao.findById.mockResolvedValue(config);
    mockDao.findAll.mockResolvedValue([config]);
  });

  it('keeps a healthy connection intact when preparation fails', async () => {
    const target = makeRuntime();
    setServerInfosForTest([target]);
    mockPrepare.mockRejectedValueOnce(new Error('unsupported arguments'));
    await expect(reinstallServer('target')).rejects.toThrow('unsupported arguments');
    expect(target.status).toBe('connected');
    expect(target.tools).toHaveLength(1);
    expect(target.client?.close).not.toHaveBeenCalled();
    expect(mockStopTree).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('refuses an installation shared by another enabled server before closing', async () => {
    const target = makeRuntime();
    setServerInfosForTest([target]);
    mockDao.findAll.mockResolvedValue([config, { ...config, name: 'peer' }]);
    await expect(reinstallServer('target')).rejects.toThrow('shared');
    expect(target.client?.close).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('fails closed if a peer installation cannot be identified', async () => {
    const target = makeRuntime();
    setServerInfosForTest([target]);
    mockDao.findAll.mockResolvedValue([config, { ...config, name: 'peer' }]);
    mockPrepare
      .mockResolvedValueOnce({ targetDirectory: '/cache/target', clear: mockClear })
      .mockRejectedValueOnce(new Error('lookup failed'));
    await expect(reinstallServer('target')).rejects.toThrow('lookup failed');
    expect(target.client?.close).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('waits for process tree and SDK shutdown before deletion, then initializes only the target', async () => {
    const target = makeRuntime();
    const peer = makeRuntime('peer');
    const closeClient = target.client!.close as jest.Mock;
    const closeTransport = target.transport!.close as jest.Mock;
    const events: string[] = [];
    let releaseTree!: () => void;
    mockStopTree.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseTree = resolve;
        }),
    );
    closeClient.mockImplementation(async () => {
      events.push('client');
    });
    closeTransport.mockImplementation(async () => {
      events.push('transport');
    });
    mockClear.mockImplementationOnce(async () => {
      events.push('clear');
    });
    mockDao.findAll.mockResolvedValue([config, { name: 'peer', command: 'uvx', args: ['fetch'] }]);
    setServerInfosForTest([target, peer]);
    const pending = reinstallServer('target');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(mockStopTree).toHaveBeenCalledWith(12345);
    expect(closeClient).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
    releaseTree();
    await pending;
    expect(events).toEqual(['client', 'transport', 'clear']);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(peer.client?.close).not.toHaveBeenCalled();
    expect(getServerByName('peer')?.status).toBe('connected');
  });

  it.each(['tree', 'clear'])(
    'leaves stopped runtime disconnected without stale tools on %s failure',
    async (stage) => {
      const target = makeRuntime();
      setServerInfosForTest([target]);
      if (stage === 'tree') mockStopTree.mockRejectedValueOnce(new Error('stop failed'));
      else mockClear.mockRejectedValueOnce(new Error('clear failed'));
      await expect(reinstallServer('target')).rejects.toThrow('failed');
      expect(target.status).toBe('disconnected');
      expect(target.tools).toEqual([]);
      expect(target.error).toContain('Failed to reinstall');
      expect(mockConnect).not.toHaveBeenCalled();
      if (stage === 'tree') expect(mockClear).not.toHaveBeenCalled();
    },
  );

  it('preserves uvx flag-based refresh without deleting shared npx installations', async () => {
    const uvxConfig: ServerConfig & { name: string } = {
      ...config,
      command: 'uvx',
      args: ['fetch'],
    };
    mockDao.findById.mockResolvedValue(uvxConfig);
    mockDao.findAll.mockResolvedValue([uvxConfig]);
    mockPrepare.mockResolvedValue({ clear: mockClear });
    setServerInfosForTest([makeRuntime()]);
    await reinstallServer('target');
    expect(mockTransport).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['--refresh', 'fetch'] }),
    );
  });
});
