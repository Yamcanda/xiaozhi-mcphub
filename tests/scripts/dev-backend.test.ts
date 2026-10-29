import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(projectRoot, 'scripts', 'dev-backend.js');

const runScript = (args: string[], env: NodeJS.ProcessEnv = {}) => {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: undefined,
      ADMIN_PASSWORD: undefined,
      MCPHUB_SETTING_PATH: undefined,
      ...env,
    },
    encoding: 'utf8',
  });
};

describe('dev backend launcher', () => {
  it('prints only sanitized environment metadata', () => {
    const resultText = runScript(['--print-env'], {
      ADMIN_PASSWORD: 'super-secret-password',
      MCPHUB_SETTING_PATH: 'data/custom-dev-settings.json',
    });
    const result = JSON.parse(resultText);

    expect(result).toEqual({ environment: 'sanitized' });
    expect(result).not.toHaveProperty('ADMIN_PASSWORD');
    expect(resultText).not.toContain('super-secret-password');
    expect(resultText).not.toContain('custom-dev-settings.json');
  });

  it('prepares a copied dev settings file without modifying the repository settings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-dev-settings-'));
    const devSettingsPath = path.join(tmpDir, 'mcp_settings.dev.json');
    const shippedSettingsPath = path.join(projectRoot, 'mcp_settings.json');
    const shippedSettingsBefore = fs.readFileSync(shippedSettingsPath, 'utf8');

    try {
      const result = JSON.parse(
        runScript(['--prepare-only'], {
          MCPHUB_SETTING_PATH: devSettingsPath,
        }),
      );

      expect(result.created).toBe(true);
      expect(result).not.toHaveProperty('MCPHUB_SETTING_PATH');
      expect(fs.readFileSync(devSettingsPath, 'utf8')).toBe(shippedSettingsBefore);
      expect(fs.readFileSync(shippedSettingsPath, 'utf8')).toBe(shippedSettingsBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    { nodeVersion: '22.0.0', extraArgs: [], nativeWatch: true },
    { nodeVersion: '22.0.0', extraArgs: ['--inspect'], nativeWatch: true },
    { nodeVersion: '20.6.0', extraArgs: [], nativeWatch: true },
    { nodeVersion: '18.19.0', extraArgs: [], nativeWatch: true },
    { nodeVersion: '20.5.0', extraArgs: [], nativeWatch: false },
    { nodeVersion: '18.18.0', extraArgs: ['--inspect'], nativeWatch: false },
  ])(
    'launches through Node $nodeVersion with runtime flags $extraArgs',
    ({ nodeVersion, extraArgs, nativeWatch }) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-dev-launch-'));
      const childScript = `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import { EventEmitter } from 'node:events';
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';

      const scriptPath = ${JSON.stringify(scriptPath)};
      const extraArgs = ${JSON.stringify(extraArgs)};
      Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} });
      process.argv = [process.execPath, scriptPath, ...extraArgs];
      childProcess.spawn = (command, args, options) => {
        const require = createRequire(pathToFileURL(scriptPath));
        assert.equal(command, process.execPath);
        const expectedArgs = ${JSON.stringify(nativeWatch)}
          ? ['--watch', ...extraArgs, '--import', pathToFileURL(require.resolve('tsx')).href, 'src/index.ts']
          : [require.resolve('tsx/cli'), 'watch', ...extraArgs, 'src/index.ts'];
        assert.deepEqual(args, expectedArgs);
        assert.equal(options.cwd, ${JSON.stringify(projectRoot)});
        assert.equal(options.env.NODE_ENV, 'development');
        assert.equal(options.env.MCPHUB_SETTING_PATH, process.env.MCPHUB_SETTING_PATH);
        assert.equal(options.env.ADMIN_PASSWORD, 'launcher-test-secret');
        assert.equal(options.stdio, 'inherit');
        assert.ok(!options.shell);
        const child = new EventEmitter();
        child.kill = (signal) => {
          assert.equal(signal, 'SIGTERM');
          child.emit('exit', null, signal);
        };
        return child;
      };
      syncBuiltinESMExports();
      await import(pathToFileURL(scriptPath).href);
      process.emit('SIGTERM');
    `;

      try {
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
          cwd: projectRoot,
          env: {
            ...process.env,
            NODE_ENV: undefined,
            ADMIN_PASSWORD: 'launcher-test-secret',
            MCPHUB_SETTING_PATH: path.join(tmpDir, 'mcp_settings.dev.json'),
          },
          encoding: 'utf8',
          timeout: 10000,
        });

        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe('');
        expect(result.status).toBe(143);
        expect(result.stdout).toContain('[dev] Starting backend dev server');
        expect(result.stdout).not.toContain('launcher-test-secret');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it('runs development command help without invoking a platform-specific package-manager shim', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-dev-cli-'));
    try {
      const output = runScript(['--help'], {
        MCPHUB_SETTING_PATH: path.join(tmpDir, 'mcp_settings.dev.json'),
      });

      expect(output).toContain('[dev] Starting backend dev server');
      expect(output).toContain('--watch');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      inherited: 'inherited-fixture-key',
      dotenvValue: 'dotenv-fixture-key',
      expected: 'inherited-fixture-key',
    },
    { inherited: undefined, dotenvValue: 'dotenv-fixture-key', expected: 'dotenv-fixture-key' },
    { inherited: '', dotenvValue: 'dotenv-fixture-key', expected: 'dotenv-fixture-key' },
    { inherited: undefined, dotenvValue: undefined, expected: undefined },
    { inherited: undefined, dotenvValue: '', expected: undefined },
  ])(
    'resolves the development signing key without printing it ($inherited / $dotenvValue)',
    ({ inherited, dotenvValue, expected }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-dev-secret-'));
      try {
        fs.mkdirSync(path.join(directory, 'scripts'));
        const fixtureScript = path.join(directory, 'scripts', 'dev-backend.js');
        fs.copyFileSync(scriptPath, fixtureScript);
        fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
        fs.writeFileSync(path.join(directory, 'settings.json'), '{}');
        if (dotenvValue !== undefined) {
          fs.writeFileSync(path.join(directory, '.env'), `JWT_SECRET="${dotenvValue}"\n`);
        }
        fs.symlinkSync(
          path.join(projectRoot, 'node_modules'),
          path.join(directory, 'node_modules'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        const childScript = `
        import assert from 'node:assert/strict';
        import childProcess from 'node:child_process';
        import { createHash } from 'node:crypto';
        import { EventEmitter } from 'node:events';
        import { syncBuiltinESMExports } from 'node:module';
        import { pathToFileURL } from 'node:url';
        process.argv = [process.execPath, ${JSON.stringify(fixtureScript)}];
        childProcess.spawn = (_command, _args, options) => {
          const secret = options.env.JWT_SECRET;
          const expected = ${JSON.stringify(expected) ?? 'undefined'};
          if (expected !== undefined) assert.equal(secret, expected);
          else assert.match(secret, /^[a-f0-9]{64}$/);
          console.log(JSON.stringify({
            verified: true,
            fingerprint: expected === undefined ? createHash('sha256').update(secret).digest('hex') : null,
          }));
          return new EventEmitter();
        };
        syncBuiltinESMExports();
        await import(pathToFileURL(${JSON.stringify(fixtureScript)}).href);
      `;
        const run = () => {
          const result = spawnSync(
            process.execPath,
            ['--input-type=module', '--eval', childScript],
            {
              cwd: directory,
              env: {
                ...process.env,
                JWT_SECRET: inherited,
                MCPHUB_SETTING_PATH: path.join(directory, 'settings.json'),
              },
              encoding: 'utf8',
              timeout: 10000,
            },
          );
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stderr).toBe('');
          expect(result.stdout).not.toContain('inherited-fixture-key');
          expect(result.stdout).not.toContain('dotenv-fixture-key');
          return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || '{}') as {
            verified: boolean;
            fingerprint: string | null;
          };
        };
        const first = run();
        expect(first.verified).toBe(true);
        if (expected === undefined) expect(run().fingerprint).not.toBe(first.fingerprint);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
  );

  it('keeps production start independent from dev defaults', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

    expect(packageJson.scripts['backend:dev']).toBe('node scripts/dev-backend.js');
    expect(packageJson.scripts.start).toBe('node dist/index.js');
  });
});
