import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = path.resolve(__dirname, '../..');

const getAvailablePort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a development test port.');
  }
  return address.port;
};

const stopProcessTree = async (child: ChildProcess): Promise<void> => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    if (result.error) throw result.error;
  } else {
    process.kill(-child.pid, 'SIGKILL');
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Development process did not stop.')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

describe('real development backend login', () => {
  it.each(['configured', 'generated'])(
    'preserves SQLite users and %s-key sessions after a watched restart',
    async (secretMode) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-dev-login-'));
      let child: ChildProcess | undefined;
      let logs = '';
      let launchError: Error | undefined;
      try {
        fs.mkdirSync(path.join(directory, 'scripts'));
        fs.copyFileSync(
          path.join(projectRoot, 'scripts', 'dev-backend.js'),
          path.join(directory, 'scripts', 'dev-backend.js'),
        );
        for (const filename of ['package.json', 'tsconfig.json']) {
          fs.copyFileSync(path.join(projectRoot, filename), path.join(directory, filename));
        }
        for (const name of ['src', 'locales']) {
          fs.cpSync(path.join(projectRoot, name), path.join(directory, name), { recursive: true });
        }
        fs.symlinkSync(
          path.join(projectRoot, 'node_modules'),
          path.join(directory, 'node_modules'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        const settingsPath = path.join(directory, 'settings.json');
        fs.writeFileSync(
          settingsPath,
          JSON.stringify({
            mcpServers: {},
            users: [],
            groups: [],
            systemConfig: { smartRouting: { enabled: false } },
          }),
        );
        const port = await getAvailablePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        const password = 'Development-Login-Regression!42';
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          NODE_ENV: 'development',
          NODE_OPTIONS: '',
          PORT: String(port),
          BASE_PATH: '',
          MCPHUB_SETTING_PATH: settingsPath,
          DB_URL: `sqlite:${path.join(directory, 'development.sqlite')}`,
          DATABASE_URL: '',
          USE_DB: 'true',
          ADMIN_PASSWORD: password,
          JWT_SECRET:
            secretMode === 'configured'
              ? 'development-login-regression-secret-not-for-deployment'
              : undefined,
          SMART_ROUTING_ENABLED: 'false',
          BETTER_AUTH_ENABLED: 'false',
          DISABLE_WEB: 'true',
          HUB_MODE: '',
        };
        delete env.JEST_WORKER_ID;
        delete env.VITEST_WORKER_ID;
        child = spawn(process.execPath, ['scripts/dev-backend.js'], {
          cwd: directory,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
        child.on('error', (error) => {
          launchError = error;
        });
        child.stdout?.on('data', (data: Buffer) => {
          logs += data.toString();
        });
        child.stderr?.on('data', (data: Buffer) => {
          logs += data.toString();
        });

        const waitForStartup = async (count: number): Promise<void> => {
          // Full CI runs compile other suites while this real backend loads its dependency graph.
          const deadline = Date.now() + 60000;
          while (Date.now() < deadline) {
            if (launchError) throw launchError;
            if (child?.exitCode !== null || child?.signalCode !== null) {
              throw new Error('Development launcher exited before becoming ready.');
            }
            const startups = logs.split(`Server is running on port ${port}`).length - 1;
            if (startups >= count) {
              try {
                const response = await fetch(`${baseUrl}/health`, {
                  signal: AbortSignal.timeout(1000),
                });
                if (response.ok && (await response.json()).status === 'healthy') return;
              } catch {
                // A restart can briefly close the listener before it is ready again.
              }
            }
            await delay(100);
          }
          throw new Error(`Development startup ${count} timed out.`);
        };
        const login = async (username = 'admin'): Promise<string> => {
          const response = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
            signal: AbortSignal.timeout(3000),
          });
          expect(response.status).toBe(200);
          const result = await response.json();
          expect(result.success).toBe(true);
          expect(result.user.username).toBe(username);
          expect(result.token).toEqual(expect.any(String));
          return result.token;
        };
        const expectAuthenticated = async (token: string, username = 'admin'): Promise<void> => {
          const response = await fetch(`${baseUrl}/api/auth/user`, {
            headers: { 'x-auth-token': token },
            signal: AbortSignal.timeout(3000),
          });
          expect(response.status).toBe(200);
          const result = await response.json();
          expect(result.success).toBe(true);
          expect(result.user.username).toBe(username);
        };

        await waitForStartup(1);
        expect(logs).toContain('SQLite database connection established');
        const originalToken = await login();
        await expectAuthenticated(originalToken);
        // A valid dashboard JWT does not imply an independent Better Auth cookie session.
        const cookieProbe = await fetch(`${baseUrl}/api/better-auth/user`, {
          headers: { 'x-auth-token': originalToken },
          signal: AbortSignal.timeout(3000),
        });
        expect(cookieProbe.status).toBe(401);
        await expectAuthenticated(originalToken);
        for (const headers of [{}, { 'x-auth-token': 'invalid-fixture-token' }]) {
          const unauthenticated = await fetch(`${baseUrl}/api/auth/user`, {
            headers,
            signal: AbortSignal.timeout(3000),
          });
          expect(unauthenticated.status).toBe(401);
        }
        const persistedUsername = 'development-persistence-user';
        const registration = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: persistedUsername, password }),
          signal: AbortSignal.timeout(3000),
        });
        expect(registration.status).toBe(200);
        expect((await registration.json()).success).toBe(true);
        await expectAuthenticated(await login(persistedUsername), persistedUsername);

        fs.appendFileSync(
          path.join(directory, 'src', 'config', 'index.ts'),
          '\n// Trigger the development watcher in the disposable project.\n',
        );
        await waitForStartup(2);
        await expectAuthenticated(originalToken);
        await expectAuthenticated(await login());
        await expectAuthenticated(await login(persistedUsername), persistedUsername);
        expect(logs).not.toContain('Failed to initialize database mode');
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`);
      } finally {
        try {
          if (child) await stopProcessTree(child);
        } finally {
          fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      }
    },
    180000,
  );
});
