import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const smartRoutingConfigMock = jest.fn(async () => ({ dbUrl: process.env.DB_URL }));
jest.mock('../../src/utils/smartRouting.js', () => ({
  getSmartRoutingConfig: smartRoutingConfigMock,
}));
jest.mock('../../src/services/vectorSearchService.js', () => ({
  createVectorIndex: jest.fn(),
}));
const preSyncMock = jest.fn();
jest.mock('../../src/utils/legacySchemaMigration.js', () => ({
  prepareLegacySchemaBeforeSynchronize: preSyncMock,
}));

import {
  checkDatabaseHealth,
  closeDatabase,
  getAppDataSource,
  initializeDatabase,
  reconnectDatabase,
} from '../../src/db/connection.js';
import { User, Server, Group, OAuthToken, XiaozhiEndpoint } from '../../src/db/entities/index.js';
import { UserRepository } from '../../src/db/repositories/UserRepository.js';
import { ActivityRepository } from '../../src/db/repositories/ActivityRepository.js';

describe('SQLite storage integration', () => {
  const originalEnv = { ...process.env };
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'mcphub-sqlite-'));
    process.env.DB_URL = 'sqlite::memory:';
  });

  afterEach(async () => {
    await closeDatabase();
    process.env = { ...originalEnv };
    rmSync(directory, { recursive: true, force: true });
  });

  it('initializes production metadata, CRUD, indexes, dates and JSON without PostgreSQL bootstrap', async () => {
    const ds = await initializeDatabase();
    expect(ds.options.type).toBe('better-sqlite3');
    expect(ds.entityMetadatas).toHaveLength(15);
    expect(ds.entityMetadatas.some((metadata) => metadata.tableName === 'vector_embeddings')).toBe(
      false,
    );
    expect(preSyncMock).not.toHaveBeenCalled();

    const users = new UserRepository();
    const user = await users.create({
      username: 'alice',
      password: 'stored-hash',
      isAdmin: true,
      email: null,
      emailVerified: false,
      ssoUserId: null,
    });
    expect(user.id).toBeValidUUID();
    expect(user.createdAt).toBeInstanceOf(Date);
    expect((await users.findAdmins()).map((entry) => entry.username)).toEqual(['alice']);
    await users.update('alice', { emailVerified: true });
    expect((await users.findByUsername('alice'))?.emailVerified).toBe(true);
    await expect(
      users.create({
        username: 'alice',
        password: 'different-hash',
        isAdmin: false,
        email: null,
        emailVerified: false,
        ssoUserId: null,
      }),
    ).rejects.toThrow();

    const servers = ds.getRepository(Server);
    await servers.save(
      servers.create({ name: 'fetch', owner: 'alice', args: ['one'], enabled: true }),
    );
    await servers.save(
      servers.create({ name: 'fetch', owner: 'bob', args: ['two'], enabled: false }),
    );
    await expect(servers.save(servers.create({ name: 'fetch', owner: 'alice' }))).rejects.toThrow();
    expect((await servers.findOneByOrFail({ name: 'fetch', owner: 'alice' })).args).toEqual([
      'one',
    ]);

    const groups = ds.getRepository(Group);
    await groups.save(groups.create({ name: 'test', owner: 'alice', servers: ['fetch'] }));
    expect((await groups.findOneByOrFail({ name: 'test' })).servers).toEqual(['fetch']);

    const expires = new Date(Date.now() + 60000);
    const tokens = ds.getRepository(OAuthToken);
    await tokens.save(
      tokens.create({
        accessToken: 'access',
        clientId: 'client',
        username: 'alice',
        accessTokenExpiresAt: expires,
      }),
    );
    expect((await tokens.findOneByOrFail({ accessToken: 'access' })).accessTokenExpiresAt).toEqual(
      expires,
    );

    const endpoints = ds.getRepository(XiaozhiEndpoint);
    await endpoints.save(
      endpoints.create({
        id: 'endpoint',
        name: 'Xiaozhi',
        owner: 'alice',
        reconnect: { maxAttempts: 3 },
        lastConnected: expires,
      }),
    );
    expect((await endpoints.findOneByOrFail({ id: 'endpoint' })).reconnect).toEqual({
      maxAttempts: 3,
    });

    const activities = new ActivityRepository();
    await activities.create({
      timestamp: new Date(),
      server: 'fetch',
      tool: 'get',
      duration: 25,
      status: 'success',
    });
    expect(await activities.getStats()).toEqual({
      totalCalls: 1,
      successCount: 1,
      errorCount: 0,
      avgDuration: 25,
    });
    expect(await checkDatabaseHealth()).toBe(true);

    // A local in-memory handle must not be destroyed by network reconnection logic.
    await reconnectDatabase();
    expect(await users.count()).toBe(1);
    expect(await users.delete('alice')).toBe(true);
    expect(await users.count()).toBe(0);
  });

  it('creates the parent directory and preserves data and credentials after reopen', async () => {
    process.env.DB_URL = `sqlite:${path.join(directory, 'nested', 'mcphub.sqlite')}`;
    const ds = await initializeDatabase();
    const repository = ds.getRepository(User);
    await repository.save(
      repository.create({ username: 'admin', password: 'unchanged-hash', isAdmin: true }),
    );
    await closeDatabase();

    const reopened = await initializeDatabase();
    expect(
      (await reopened.getRepository(User).findOneByOrFail({ username: 'admin' })).password,
    ).toBe('unchanged-hash');
    expect(await reopened.getRepository(User).count()).toBe(1);
    expect(await checkDatabaseHealth()).toBe(true);
    expect(getAppDataSource()).toBe(reopened);
  });
});
