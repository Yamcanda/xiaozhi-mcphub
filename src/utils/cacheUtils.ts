import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';

const execFileAsync = promisify(execFile);

export interface CacheClearResult {
  status: 'cleared' | 'skipped' | 'error';
  message?: string;
}

/**
 * Resolve the cache used by npm, including npmrc and environment overrides.
 */
export const getNpxCacheDir = async (
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
  let cache: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cache') {
      cache = args[++i];
      if (!cache) throw new Error('Missing npx --cache directory');
    } else if (args[i].startsWith('--cache=')) {
      cache = args[i].slice('--cache='.length);
      if (!cache) throw new Error('Missing npx --cache directory');
    } else if (args[i] === '-p' || args[i] === '--package') {
      i++;
    } else if (args[i] === '--' || !args[i].startsWith('-')) {
      break;
    }
  }

  if (!cache) {
    cache = await new Promise<string>((resolve, reject) => {
      execFile(
        'npm',
        ['config', 'get', 'cache'],
        { env, timeout: 10_000, ...(process.platform === 'win32' ? { shell: true } : {}) },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim());
        },
      );
    });
  }
  if (!cache || /[\r\n\0]/.test(cache) || cache.startsWith('~') || cache.includes('${')) {
    throw new Error('Unable to resolve npm cache directory');
  }
  return path.resolve(cache, '_npx');
};

const getNpxPackageSpec = (args: string[]): { name: string; spec: string } => {
  const packages: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-p' || arg === '--package') {
      const spec = args[++i];
      if (!spec) throw new Error('Missing npx package specifier');
      packages.push(spec);
    } else if (arg.startsWith('--package=')) {
      packages.push(arg.slice('--package='.length));
    } else if (arg === '--cache') {
      if (!args[++i]) throw new Error('Missing npx --cache directory');
    } else if (arg.startsWith('--cache=') || ['-y', '--yes', '--no'].includes(arg)) {
      continue;
    } else if (arg === '--') {
      if (packages.length === 0 && args[i + 1]) packages.push(args[i + 1]);
      break;
    } else if (arg.startsWith('-')) {
      throw new Error('Cannot safely identify the npx package to refresh');
    } else {
      if (packages.length === 0) packages.push(arg);
      break;
    }
  }

  if (packages.length !== 1) {
    throw new Error('Targeted npx refresh requires exactly one package');
  }
  const match = packages[0].match(/^((?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?:@[^\s/\\]+)?$/);
  if (!match) throw new Error('Targeted npx refresh requires an npm package name');
  return { name: match[1], spec: packages[0] };
};

/**
 * Check if a server command supports cache refresh (reinstall).
 * Currently supports: npx (directory-based clear) and uvx (flag-based refresh).
 */
export const supportsCacheRefresh = (command: string): boolean => {
  return command === 'npx' || command === 'uvx';
};

/**
 * Inject cache-busting flags into command arguments for flag-based refresh.
 * Currently only applies to uvx (--refresh flag).
 *
 * For npx, this is a no-op — use clearRunnerCache() instead,
 * since --ignore-existing was removed in npm 7+.
 */
export const injectRefreshFlag = (command: string, args: string[]): string[] => {
  if (command === 'uvx' && !args.includes('--refresh')) {
    return ['--refresh', ...args];
  }
  return args;
};

export interface PreparedRunnerCacheClear {
  targetDirectory?: string;
  clear: () => Promise<void>;
}

const canonicalizeCachePath = async (directory: string): Promise<string> => {
  try {
    return await fs.promises.realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await canonicalizeCachePath(parent), path.basename(directory));
  }
};

const inspectNpxInstallation = async (
  entryDir: string,
  packageName: string,
): Promise<string | undefined> => {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(entryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Cannot safely refresh a symlinked or unrecognized npx installation');
  }
  const manifestPath = path.join(entryDir, 'package.json');
  const manifestStat = await fs.promises.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('Cannot safely refresh a symlinked or unrecognized npx installation');
  }

  const contents = await fs.promises.readFile(manifestPath, 'utf8');
  const manifest: unknown = JSON.parse(contents);
  const dependencies =
    manifest && typeof manifest === 'object' && 'dependencies' in manifest
      ? manifest.dependencies
      : undefined;
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies) ||
    Object.keys(dependencies).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(dependencies, packageName)
  ) {
    throw new Error('Cannot safely refresh a shared or unrecognized npx installation');
  }
  return JSON.stringify([
    stat.dev,
    stat.ino,
    manifestStat.dev,
    manifestStat.ino,
    manifestStat.mtimeMs,
    contents,
  ]);
};

const assertDefaultNpxExecutionConfig = async (env: NodeJS.ProcessEnv): Promise<void> => {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      'npm',
      ['config', 'get', 'package', 'call', '--json=false'],
      { env, timeout: 10_000, ...(process.platform === 'win32' ? { shell: true } : {}) },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
  // npm prints key=value lines, not JSON. Nonempty overrides change what npx runs.
  if (output.replace(/\r\n/g, '\n').replace(/\n$/, '') !== 'package=\ncall=') {
    throw new Error('Targeted npx refresh does not support configured package or call overrides');
  }
};

/**
 * Discover and validate the exact installation before stopping a running server.
 * npm's registry-package cache key is the first 16 hex characters of SHA-512
 * over the original package spec. Do not sweep other versions of the same package.
 */
export const prepareRunnerCacheClear = async (
  command: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<PreparedRunnerCacheClear> => {
  if (command !== 'npx') return { clear: async () => {} };

  const { name, spec } = getNpxPackageSpec(args);
  await assertDefaultNpxExecutionConfig(env);
  const cacheDir = await getNpxCacheDir(args, env);
  const canonicalCacheDir = await canonicalizeCachePath(cacheDir);
  const cacheKey = createHash('sha512').update(spec).digest('hex').slice(0, 16);
  const targetDirectory = path.join(canonicalCacheDir, cacheKey);
  const identity = await inspectNpxInstallation(targetDirectory, name);

  return {
    targetDirectory,
    clear: async () => {
      // Check both the original alias and the canonical root before deleting.
      if (
        (await canonicalizeCachePath(cacheDir)) !== canonicalCacheDir ||
        (await canonicalizeCachePath(canonicalCacheDir)) !== canonicalCacheDir
      ) {
        throw new Error('npm cache directory changed during refresh');
      }
      const currentIdentity = await inspectNpxInstallation(targetDirectory, name);
      if (currentIdentity === undefined) return;
      if (currentIdentity !== identity) {
        throw new Error('npx installation changed during refresh');
      }
      await fs.promises.rm(targetDirectory, { recursive: true, force: true });
      console.log(`Cleared targeted npx cache for ${name}: ${cacheKey}`);
    },
  };
};

/** Clear only the requested installation; uvx uses --refresh instead. */
export const clearRunnerCache = async (
  command: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  const prepared = await prepareRunnerCacheClear(command, args, env);
  await prepared.clear();
};

/**
 * Check if a command binary exists on the system.
 * Uses a 3s timeout to avoid hanging on slow PATH lookups.
 */
const commandExists = async (cmd: string): Promise<boolean> => {
  const checkCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(checkCmd, [cmd], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
};

// 60s timeout per cache clear command. npm cache clean can be slow on large caches.
const CACHE_CLEAR_TIMEOUT_MS = 60_000;

/**
 * Clear a single runner's cache. Returns the result without throwing.
 */
const clearRunnerCacheAsync = async (
  runner: string,
  cmd: string,
  args: string[],
  execOptions: Record<string, unknown>,
): Promise<CacheClearResult> => {
  if (!(await commandExists(cmd))) {
    return { status: 'skipped', message: `${cmd} not found` };
  }
  try {
    await execFileAsync(cmd, args, { ...execOptions, timeout: CACHE_CLEAR_TIMEOUT_MS });
    console.log(`Cleared ${runner} cache`);
    return { status: 'cleared' };
  } catch (error) {
    console.error(`Failed to clear ${runner} cache`, error);
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Clear all runner caches (npm + uv) in parallel using fixed commands.
 * Uses execFile with hardcoded arguments — no shell interpolation, no injection risk.
 * On Windows, shell: true is required because npm and uv are .cmd batch files.
 * Each command has a 60s timeout. Skips runners that are not installed.
 */
export const clearAllCaches = async (): Promise<Record<string, CacheClearResult>> => {
  // Windows npm/uv are .cmd wrappers and require shell: true to execute via execFile
  const execOptions = process.platform === 'win32' ? { shell: true } : {};

  // Run npm and uv clears in parallel — they operate on independent caches
  const [npmResult, uvResult] = await Promise.all([
    clearRunnerCacheAsync('npm', 'npm', ['cache', 'clean', '--force'], execOptions),
    clearRunnerCacheAsync('uv', 'uv', ['cache', 'clean', '--force'], execOptions),
  ]);

  return { npm: npmResult, uv: uvResult };
};
