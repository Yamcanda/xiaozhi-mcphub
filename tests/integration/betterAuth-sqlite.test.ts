import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = process.cwd();
const authModuleUrl = pathToFileURL(path.join(projectRoot, 'src', 'betterAuth.ts')).href;

// Use Node's ESM loader so Better Auth and its real migrations are not replaced by Jest mocks.
const sqliteAuthScript = `
  import assert from 'node:assert/strict';
  import { createRequire } from 'node:module';
  const { auth, ensureBetterAuthSchema, closeBetterAuthDatabase } = await import(${JSON.stringify(authModuleUrl)});
  try {
    await ensureBetterAuthSchema();
    await ensureBetterAuthSchema();
    const context = await auth.$context;
    let user;
    let session;
    if (process.env.AUTH_SQLITE_REOPEN === 'true') {
      user = await context.adapter.findOne({ model: 'user', where: [{ field: 'email', value: 'sqlite@example.com' }] });
      session = await context.internalAdapter.findSession(process.env.AUTH_SQLITE_SESSION_TOKEN);
      assert.equal(session?.user.id, user.id);
    } else {
      user = await context.internalAdapter.createUser({ name: 'SQLite User', email: 'sqlite@example.com', emailVerified: true });
      await context.internalAdapter.createAccount({ userId: user.id, accountId: 'sqlite-github-account', providerId: 'github', accessToken: 'sqlite-test-token' });
      const createdSession = await context.internalAdapter.createSession(user.id);
      session = await context.internalAdapter.findSession(createdSession.token);
      assert.equal(session?.session.token, createdSession.token);
    }
    assert.equal(user.emailVerified, true);
    assert.equal(session?.user.email, 'sqlite@example.com');
    assert.equal(session?.session.expiresAt instanceof Date, true);
    const account = await context.internalAdapter.findAccountByProviderId('sqlite-github-account', 'github');
    assert.equal(account.userId, user.id);
    assert.equal(account.accessToken, 'sqlite-test-token');
    if (process.env.AUTH_SQLITE_FILE) {
      const require = createRequire(${JSON.stringify(authModuleUrl)});
      const Database = require('better-sqlite3');
      const inspection = new Database(process.env.AUTH_SQLITE_FILE);
      try {
        const tables = inspection.prepare("select name from sqlite_master where type = 'table'").all().map((row) => row.name);
        for (const name of ['user', 'session', 'account', 'verification']) assert.ok(tables.includes(name), name);
        assert.equal(inspection.prepare('select count(*) as count from "user"').get().count, 1);
      } finally {
        inspection.close();
      }
    }
    console.log('SQLITE_AUTH_RESULT=' + JSON.stringify({ userId: user.id, token: session.session.token }));
  } finally {
    await closeBetterAuthDatabase();
    await closeBetterAuthDatabase();
  }
`;

const runSqliteAuth = (databaseUrl: string, extraEnv: NodeJS.ProcessEnv = {}) => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', sqliteAuthScript],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        DB_URL: databaseUrl,
        DATABASE_URL: '',
        USE_DB: 'true',
        BETTER_AUTH_ENABLED: 'true',
        BETTER_AUTH_URL: 'http://localhost:3000',
        BETTER_AUTH_SECRET: 'sqlite-auth-integration-secret-at-least-32-characters',
        GITHUB_CLIENT_ID: 'sqlite-test-client',
        GITHUB_CLIENT_SECRET: 'sqlite-test-secret',
        BETTER_AUTH_GITHUB_ENABLED: 'true',
        BETTER_AUTH_GOOGLE_ENABLED: 'false',
        BETTER_AUTH_OIDC_ENABLED: 'false',
        AUTH_SQLITE_REOPEN: 'false',
        AUTH_SQLITE_FILE: '',
        ...extraEnv,
      },
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `SQLite auth subprocess failed: ${result.error?.message ?? result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  const output = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('SQLITE_AUTH_RESULT='));
  if (!output) {
    throw new Error(`SQLite auth subprocess produced no result:\n${result.stdout}`);
  }
  return JSON.parse(output.slice('SQLITE_AUTH_RESULT='.length)) as {
    userId: string;
    token: string;
  };
};

describe('Better Auth real SQLite storage', () => {
  it('creates an idempotent in-memory schema and stores OAuth accounts and sessions', () => {
    const result = runSqliteAuth('sqlite::memory:');

    expect(result.userId).toEqual(expect.any(String));
    expect(result.token).toEqual(expect.any(String));
  }, 30000);

  it('creates parent directories and preserves auth data when reopening a SQLite file', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'mcphub-auth-sqlite-'));
    const databaseFile = path.join(directory, 'nested', 'mcphub.sqlite');
    try {
      const initial = runSqliteAuth(`sqlite:${databaseFile}`, { AUTH_SQLITE_FILE: databaseFile });
      const reopened = runSqliteAuth(`sqlite:${databaseFile}`, {
        AUTH_SQLITE_FILE: databaseFile,
        AUTH_SQLITE_REOPEN: 'true',
        AUTH_SQLITE_SESSION_TOKEN: initial.token,
      });

      expect(reopened).toEqual(initial);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});
