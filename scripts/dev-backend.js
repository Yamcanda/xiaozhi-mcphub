import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { randomBytes } from 'node:crypto';
import { parse } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const DEFAULT_DEV_SETTINGS_PATH = path.join(projectRoot, 'data', 'mcp_settings.dev.json');

function resolvePathFromProjectRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function resolveDevConfiguration(env = process.env) {
  const settingsPath = env.MCPHUB_SETTING_PATH
    ? resolvePathFromProjectRoot(env.MCPHUB_SETTING_PATH)
    : DEFAULT_DEV_SETTINGS_PATH;

  return {
    childEnvironment: {
      ...env,
      NODE_ENV: env.NODE_ENV || 'development',
      MCPHUB_SETTING_PATH: settingsPath,
    },
    settingsPath,
  };
}

function prepareDevSettingsFile(settingsPath) {
  if (fs.existsSync(settingsPath)) {
    return false;
  }

  const sourcePath = path.join(projectRoot, 'mcp_settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.copyFileSync(sourcePath, settingsPath);
  return true;
}

function printEnvironment() {
  console.log(
    JSON.stringify({
      environment: 'sanitized',
    }),
  );
}

function printPrepareResult(created) {
  console.log(
    JSON.stringify({
      created,
    }),
  );
}

function resolveDevJwtSecret(env) {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  const envPath = path.join(projectRoot, '.env');
  let configuredSecret;
  try {
    configuredSecret = parse(fs.readFileSync(envPath)).JWT_SECRET;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Keep one random key in the unwatched parent so automatic restarts keep sessions valid.
  return configuredSecret || randomBytes(32).toString('hex');
}

function startBackend(extraArgs) {
  const configuration = resolveDevConfiguration();
  configuration.childEnvironment.JWT_SECRET = resolveDevJwtSecret(process.env);
  prepareDevSettingsFile(configuration.settingsPath);

  console.log('[dev] Starting backend dev server');
  console.log('[dev] Using isolated development settings');

  const require = createRequire(import.meta.url);
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supportsImport =
    major > 20 || (major === 20 && minor >= 6) || (major === 18 && minor >= 19);
  // Use Node's watcher to avoid tsx watch's preflight loading on Windows.
  // Keep the CLI fallback for Node versions without module.register().
  const childArgs = supportsImport
    ? [
        '--watch',
        ...extraArgs,
        '--import',
        pathToFileURL(require.resolve('tsx')).href,
        'src/index.ts',
      ]
    : [require.resolve('tsx/cli'), 'watch', ...extraArgs, 'src/index.ts'];
  const child = spawn(process.execPath, childArgs, {
    cwd: projectRoot,
    env: configuration.childEnvironment,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error('[dev] Failed to start backend:', error.message);
    process.exit(1);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on('exit', (code, signal) => {
    if (signal) {
      const signalExitCodes = {
        SIGINT: 130,
        SIGTERM: 143,
      };
      process.exit(signalExitCodes[signal] ?? 1);
      return;
    }

    process.exit(code ?? 0);
  });
}

const args = process.argv.slice(2);
const printEnv = args.includes('--print-env');
const prepareOnly = args.includes('--prepare-only');
const backendArgs = args.filter((arg) => arg !== '--print-env' && arg !== '--prepare-only');
const configuration = resolveDevConfiguration();

if (printEnv) {
  printEnvironment();
} else if (prepareOnly) {
  const created = prepareDevSettingsFile(configuration.settingsPath);
  printPrepareResult(created);
} else {
  startBackend(backendArgs);
}
