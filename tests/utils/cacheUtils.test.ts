import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import {
  clearRunnerCache,
  getNpxCacheDir,
  prepareRunnerCacheClear,
} from '../../src/utils/cacheUtils.js';

jest.mock('child_process', () => ({ execFile: jest.fn() }));

const cacheRoot = path.resolve('test-npm-cache');
const npxRoot = path.join(cacheRoot, '_npx');
const installation = (spec: string) =>
  path.join(npxRoot, createHash('sha512').update(spec).digest('hex').slice(0, 16));
const firecrawlCache = installation('firecrawl-mcp');
const versionedCache = installation('firecrawl-mcp@3.35.0');
const otherCache = installation('@playwright/mcp@latest');
const mockExecFile = jest.mocked(execFile);
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const directoryStat = (overrides: Partial<fs.Stats> = {}) =>
  ({
    dev: 1,
    ino: 2,
    mtimeMs: 100,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    isFile: () => false,
    ...overrides,
  }) as fs.Stats;
const fileStat = () => directoryStat({ isDirectory: () => false, isFile: () => true });

describe('targeted npx cache refresh', () => {
  beforeEach(() => {
    mockExecFile.mockReset().mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      const commandArgs = args[1] as string[];
      callback(null, commandArgs.includes('package') ? 'package=\ncall=\n' : `${cacheRoot}\n`, '');
      return {} as ReturnType<typeof execFile>;
    });
    jest.spyOn(fs.promises, 'realpath').mockImplementation(async (file) => String(file));
    jest.spyOn(fs.promises, 'readdir').mockRejectedValue(new Error('must not scan other installs'));
    jest
      .spyOn(fs.promises, 'lstat')
      .mockImplementation(async (file) =>
        path.basename(String(file)) === 'package.json' ? fileStat() : directoryStat(),
      );
    jest.spyOn(fs.promises, 'readFile').mockImplementation(async (file) => {
      const dir = path.dirname(String(file));
      if (dir === otherCache) return JSON.stringify({ dependencies: { '@playwright/mcp': '*' } });
      if (dir === firecrawlCache || dir === versionedCache) {
        return JSON.stringify({ dependencies: { 'firecrawl-mcp': '^3.36.0' } });
      }
      throw missing();
    });
    jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves the configured npm cache instead of guessing the platform default', async () => {
    const env = { ...process.env, npm_config_cache: cacheRoot };
    await expect(getNpxCacheDir([], env)).resolves.toBe(npxRoot);
    expect(mockExecFile).toHaveBeenCalledWith(
      'npm',
      ['config', 'get', 'cache'],
      expect.objectContaining({ env, timeout: 10_000 }),
      expect.any(Function),
    );
  });

  it('uses an explicit --cache directory without invoking npm for cache discovery', async () => {
    await expect(getNpxCacheDir(['--cache', cacheRoot, '-y', 'firecrawl-mcp'])).resolves.toBe(
      npxRoot,
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('targets the exact npm hash without scanning same-package versions or unrelated entries', async () => {
    expect(path.basename(firecrawlCache)).toBe('12b05d58670d8359');
    await clearRunnerCache('npx', ['-y', 'firecrawl-mcp']);
    expect(fs.promises.rm).toHaveBeenCalledTimes(1);
    expect(fs.promises.rm).toHaveBeenCalledWith(firecrawlCache, { recursive: true, force: true });
    expect(fs.promises.lstat).not.toHaveBeenCalledWith(versionedCache);
    expect(fs.promises.readdir).not.toHaveBeenCalled();
  });

  it('preserves the raw version/tag specifier in the installation identity', async () => {
    const plain = await prepareRunnerCacheClear('npx', ['firecrawl-mcp']);
    const versioned = await prepareRunnerCacheClear('npx', ['firecrawl-mcp@3.35.0']);
    expect(plain.targetDirectory).toBe(firecrawlCache);
    expect(versioned.targetDirectory).toBe(versionedCache);
    await versioned.clear();
    expect(fs.promises.rm).toHaveBeenCalledWith(versionedCache, expect.anything());
    expect(fs.promises.rm).not.toHaveBeenCalledWith(firecrawlCache, expect.anything());
  });

  it('prepares non-destructively and supports scoped --package specs', async () => {
    const prepared = await prepareRunnerCacheClear('npx', [
      '--package=@playwright/mcp@latest',
      'playwright',
    ]);
    expect(prepared.targetDirectory).toBe(otherCache);
    expect(fs.promises.rm).not.toHaveBeenCalled();
    await prepared.clear();
    expect(fs.promises.rm).toHaveBeenCalledWith(otherCache, expect.anything());
  });

  it.each([
    [],
    ['-y', '../local-package'],
    ['-y', 'https://example.com/package.tgz'],
    ['--unknown', 'firecrawl-mcp'],
    ['-p', 'firecrawl-mcp', '-p', 'unrelated', 'firecrawl-mcp'],
    ['--package='],
    ['--cache'],
    ['--package'],
  ])('refuses ambiguous or unsupported package arguments: %j', async (...args: string[]) => {
    await expect(prepareRunnerCacheClear('npx', args)).rejects.toThrow();
    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it.each([
    ['firecrawl-mcp', '--cache', '/child-cache'],
    ['--', 'firecrawl-mcp', '--cache=/child-cache'],
  ])('does not treat child flags as npm cache options: %j', async (...args: string[]) => {
    const prepared = await prepareRunnerCacheClear('npx', args);
    expect(prepared.targetDirectory).toBe(firecrawlCache);
  });

  it.each(['~/npm-cache', '${CACHE_ROOT}', 'bad\npath'])(
    'refuses unsupported cache paths: %s',
    async (cache) => {
      await expect(
        prepareRunnerCacheClear('npx', ['--cache', cache, 'firecrawl-mcp']),
      ).rejects.toThrow();
      expect(fs.promises.rm).not.toHaveBeenCalled();
    },
  );

  it.each(['package=other\ncall=\n', 'package=\ncall=echo secret\n', 'package=\ncall= \n'])(
    'rejects npm execution config overrides before shutdown: %j',
    async (output) => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1) as (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
        callback(null, output, '');
        return {} as ReturnType<typeof execFile>;
      });
      await expect(prepareRunnerCacheClear('npx', ['firecrawl-mcp'])).rejects.toThrow('overrides');
      expect(fs.promises.rm).not.toHaveBeenCalled();
    },
  );

  it.each(['directory', 'manifest'])(
    'refuses a symlinked %s before reading or deletion',
    async (kind) => {
      jest.mocked(fs.promises.lstat).mockImplementation(async (file) => {
        const manifest = path.basename(String(file)) === 'package.json';
        if ((kind === 'manifest') === manifest) {
          return directoryStat({ isSymbolicLink: () => true, isDirectory: () => false });
        }
        return manifest ? fileStat() : directoryStat();
      });
      await expect(prepareRunnerCacheClear('npx', ['firecrawl-mcp'])).rejects.toThrow();
      expect(fs.promises.readFile).not.toHaveBeenCalled();
      expect(fs.promises.rm).not.toHaveBeenCalled();
    },
  );

  it.each([
    'not json',
    '{}',
    '{"dependencies":[]}',
    '{"dependencies":{"firecrawl-mcp":"*","unrelated":"*"}}',
  ])('refuses malformed/shared manifests without deleting: %s', async (manifest) => {
    jest.mocked(fs.promises.readFile).mockResolvedValue(manifest);
    await expect(prepareRunnerCacheClear('npx', ['firecrawl-mcp'])).rejects.toThrow();
    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it('treats a missing target as empty while preserving canonical identity', async () => {
    jest.mocked(fs.promises.lstat).mockRejectedValue(missing());
    const prepared = await prepareRunnerCacheClear('npx', ['firecrawl-mcp']);
    expect(prepared.targetDirectory).toBe(firecrawlCache);
    await prepared.clear();
    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it('resolves existing ancestor aliases even when _npx does not exist', async () => {
    const canonical = path.resolve('canonical-cache');
    jest.mocked(fs.promises.realpath).mockImplementation(async (file) => {
      if (String(file) === npxRoot) throw missing();
      return String(file) === cacheRoot ? canonical : String(file);
    });
    jest.mocked(fs.promises.lstat).mockRejectedValue(missing());
    const prepared = await prepareRunnerCacheClear('npx', ['firecrawl-mcp']);
    expect(prepared.targetDirectory).toBe(
      path.join(canonical, '_npx', path.basename(firecrawlCache)),
    );
  });

  it('refuses a manifest changed between preparation and clear', async () => {
    const prepared = await prepareRunnerCacheClear('npx', ['firecrawl-mcp']);
    jest
      .mocked(fs.promises.readFile)
      .mockResolvedValue('{"dependencies":{"firecrawl-mcp":"9.0.0"}}');
    await expect(prepared.clear()).rejects.toThrow('changed');
    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it('refuses a redirected cache alias between preparation and clear', async () => {
    const prepared = await prepareRunnerCacheClear('npx', ['firecrawl-mcp']);
    jest.mocked(fs.promises.realpath).mockResolvedValue(path.resolve('elsewhere'));
    await expect(prepared.clear()).rejects.toThrow('changed');
    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it('does not fall back to a shared cache clear if npm fails', async () => {
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      callback(new Error('npm failed'));
      return {} as ReturnType<typeof execFile>;
    });
    await expect(prepareRunnerCacheClear('npx', ['firecrawl-mcp'])).rejects.toThrow('npm failed');
    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it('keeps uvx flag-based without filesystem or npm operations', async () => {
    await clearRunnerCache('uvx', ['mcp-server-fetch']);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(fs.promises.lstat).not.toHaveBeenCalled();
    expect(fs.promises.rm).not.toHaveBeenCalled();
  });
});
