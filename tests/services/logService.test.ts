describe('logService error serialization', () => {
  let logService: typeof import('../../src/services/logService.js').default;

  beforeAll(async () => {
    ({ default: logService } = await import('../../src/services/logService.js'));
  });

  beforeEach(() => {
    logService.clearLogs();
  });

  it('keeps nested Error details when logging structured objects', () => {
    const error = new Error('structured failure');
    (error as Error & { code?: string }).code = 'E_STRUCTURED';

    console.error('Structured log failure', {
      requestId: 'req-123',
      error,
    });

    const lastLog = logService.getLogs().at(-1);

    expect(lastLog).toBeDefined();
    expect(lastLog?.message).toContain('Structured log failure');
    expect(lastLog?.message).toContain('structured failure');
    expect(lastLog?.message).toContain('E_STRUCTURED');
    expect(lastLog?.message).not.toContain('"error": {}');
  });

  it.each([
    { prefix: '[firecrawl] [child]', lineEnding: 'LF', newline: '\n' },
    { prefix: '[firecrawl] [child]', lineEnding: 'CRLF', newline: '\r\n' },
    { prefix: '[firecrawl] [child-456]', lineEnding: 'LF', newline: '\n' },
    { prefix: '[firecrawl] [child-456]', lineEnding: 'CRLF', newline: '\r\n' },
  ])('keeps multiline structured logs for $prefix with $lineEnding', ({ prefix, newline }) => {
    const message = [
      'node:internal/modules/esm/resolve:275',
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'example.js'",
      '    at ModuleLoader.resolve (node:internal/modules/esm/loader:690:38)',
      '',
      'Node.js v22.0.0',
    ].join(newline);
    const subscriber = jest.fn();
    const streamSubscriber = jest.fn();
    const unsubscribe = logService.subscribe(subscriber);
    const unsubscribeFromStream = logService.subscribeToStream(streamSubscriber);

    try {
      console.error(`${prefix} ${message}`);

      const logs = logService.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        type: 'error',
        source: 'child',
        processId: 'firecrawl',
        message,
      });
      expect(subscriber).toHaveBeenCalledWith(logs[0]);
      expect(streamSubscriber).toHaveBeenCalledWith({ type: 'log', log: logs[0] });
    } finally {
      unsubscribe();
      unsubscribeFromStream();
    }
  });

  it('redacts direct remote HTTP errors when logging Error instances', () => {
    const error = Object.assign(new Error('oauth access_token=top-secret'), {
      code: 'ERR_BAD_REQUEST',
      response: {
        status: 400,
        data: {
          access_token: 'top-secret',
        },
        headers: {
          'x-request-id': 'req-remote',
        },
      },
    });

    console.error('OAuth exchange failed:', error);

    const lastLog = logService.getLogs().at(-1);

    expect(lastLog).toBeDefined();
    expect(lastLog?.message).toContain('OAuth exchange failed:');
    expect(lastLog?.message).toContain('[Remote request failed; response details omitted]');
    expect(lastLog?.message).toContain('"status": 400');
    expect(lastLog?.message).toContain('"requestId": "req-remote"');
    expect(lastLog?.message).not.toContain('top-secret');
  });
});
