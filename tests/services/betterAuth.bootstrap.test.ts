import path from 'node:path';

const betterAuthMock = jest.fn(() => ({ handler: jest.fn() }));
const genericOAuthMock = jest.fn((options: unknown) => ({ id: 'generic-oauth', options }));
const poolMock = jest.fn();
const poolQueryMock = jest.fn();
const poolEndMock = jest.fn();
const postgresDialectMock = jest.fn();
const sqliteDialectMock = jest.fn();
const sqliteDatabaseMock = jest.fn();
const sqlitePrepareMock = jest.fn();
const sqliteTableAllMock = jest.fn();
const sqlitePragmaMock = jest.fn();
const sqliteCloseMock = jest.fn();
const requireNativeMock = jest.fn();
const createRequireMock = jest.fn();
const prepareSqliteDatabaseMock = jest.fn();
const getMigrationsMock = jest.fn();
const runMigrationsMock = jest.fn();
const loadSettingsMock = jest.fn();
const resolveBetterAuthRuntimeConfigMock = jest.fn();

const runtimeConfig = {
  enabled: true,
  basePath: '/api/auth/better',
  trustedOrigins: ['https://mcp.imdevinc.home'],
  providers: {
    google: { enabled: false },
    github: { enabled: false },
    oidc: {
      enabled: true,
      providerId: 'local-oidc',
      discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
      scopes: ['openid', 'profile', 'email'],
      pkce: true,
      prompt: 'login',
      trustEmail: true,
    },
  },
};

const disabledRuntimeConfig = {
  enabled: false,
  basePath: '/api/auth/better',
  trustedOrigins: [],
  providers: {
    google: { enabled: false },
    github: { enabled: false },
    oidc: {
      enabled: false,
      providerId: 'oidc',
      scopes: ['openid', 'profile', 'email'],
      pkce: true,
      trustEmail: false,
    },
  },
};

jest.mock('better-auth', () => ({
  betterAuth: betterAuthMock,
}));

jest.mock('better-auth/plugins', () => ({
  genericOAuth: genericOAuthMock,
}));

jest.mock('pg', () => ({
  Pool: poolMock,
}));

jest.mock('kysely', () => ({
  PostgresDialect: postgresDialectMock,
  SqliteDialect: sqliteDialectMock,
}));

jest.mock('node:module', () => ({
  createRequire: createRequireMock,
}));

jest.mock('../../src/config/database.js', () => ({
  ...jest.requireActual('../../src/config/database.js'),
  prepareSqliteDatabase: prepareSqliteDatabaseMock,
}));

jest.mock('better-auth/db/migration', () => ({
  getMigrations: getMigrationsMock,
}));

jest.mock('../../src/config/index.js', () => ({
  __esModule: true,
  default: {
    port: 3000,
    basePath: '',
  },
  loadSettings: loadSettingsMock,
}));

jest.mock('../../src/services/betterAuthConfig.js', () => ({
  __esModule: true,
  betterAuthRuntimeConfig: disabledRuntimeConfig,
  getBetterAuthRuntimeConfig: jest.fn(() => runtimeConfig),
  resolveBetterAuthRuntimeConfig: resolveBetterAuthRuntimeConfigMock,
}));

describe('betterAuth bootstrap', () => {
  const originalEnv = { ...process.env };

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.resetModules();
    betterAuthMock.mockClear();
    genericOAuthMock.mockClear();
    poolMock.mockReset().mockImplementation(() => ({ query: poolQueryMock, end: poolEndMock }));
    poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
    poolEndMock.mockReset().mockResolvedValue(undefined);
    postgresDialectMock.mockReset().mockImplementation(() => ({ type: 'postgres' }));
    sqliteDialectMock.mockReset().mockImplementation(() => ({ type: 'sqlite' }));
    sqliteDatabaseMock.mockReset().mockImplementation(() => ({
      prepare: sqlitePrepareMock,
      pragma: sqlitePragmaMock,
      close: sqliteCloseMock,
      open: true,
    }));
    sqlitePrepareMock.mockReset().mockReturnValue({ all: sqliteTableAllMock });
    sqliteTableAllMock.mockReset().mockReturnValue([]);
    sqlitePragmaMock.mockReset();
    sqliteCloseMock.mockReset();
    requireNativeMock.mockReset().mockReturnValue(sqliteDatabaseMock);
    createRequireMock.mockReset().mockReturnValue(requireNativeMock);
    prepareSqliteDatabaseMock.mockReset();
    runMigrationsMock.mockReset().mockResolvedValue(undefined);
    getMigrationsMock.mockReset().mockResolvedValue({
      toBeCreated: [],
      toBeAdded: [],
      runMigrations: runMigrationsMock,
    });
    loadSettingsMock.mockReset();
    resolveBetterAuthRuntimeConfigMock.mockReset();
    resolveBetterAuthRuntimeConfigMock.mockReturnValue(runtimeConfig);
    loadSettingsMock.mockReturnValue({
      systemConfig: {},
    });
    process.env.DB_URL = 'postgresql://mcphub:password@localhost:5432/mcphub';
    process.env.BETTER_AUTH_URL = 'http://localhost:5173';
    process.env.OIDC_CLIENT_ID = 'oidc-client-id';
    process.env.OIDC_CLIENT_SECRET = 'oidc-client-secret';
    process.env.USE_DB = 'true';
  });

  it('keeps PostgreSQL storage without loading the SQLite native binding', async () => {
    await import('../../src/betterAuth.js');

    expect(poolMock).toHaveBeenCalledWith({
      connectionString: 'postgresql://mcphub:password@localhost:5432/mcphub',
    });
    expect(postgresDialectMock).toHaveBeenCalledWith({
      pool: { query: poolQueryMock, end: poolEndMock },
    });
    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ database: { type: 'postgres' } }),
    );
    expect(createRequireMock).not.toHaveBeenCalled();
    expect(requireNativeMock).not.toHaveBeenCalled();
    expect(prepareSqliteDatabaseMock).not.toHaveBeenCalled();
  });

  it.each([
    ['sqlite::memory:', ':memory:'],
    ['sqlite:./data/mcphub.sqlite', path.resolve('./data/mcphub.sqlite')],
  ])('uses SQLite storage for %s without creating a PostgreSQL pool', async (url, database) => {
    process.env.DB_URL = url;

    await import('../../src/betterAuth.js');

    expect(prepareSqliteDatabaseMock).toHaveBeenCalledWith(database);
    expect(requireNativeMock).toHaveBeenCalledWith('better-sqlite3');
    expect(sqliteDatabaseMock).toHaveBeenCalledWith(database);
    expect(sqlitePragmaMock).toHaveBeenCalledWith('foreign_keys = ON');
    expect(sqliteDialectMock).toHaveBeenCalledWith({
      database: expect.objectContaining({ prepare: sqlitePrepareMock, pragma: sqlitePragmaMock }),
    });
    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ database: { type: 'sqlite' } }),
    );
    expect(poolMock).not.toHaveBeenCalled();
    expect(postgresDialectMock).not.toHaveBeenCalled();
  });

  it('continues to accept the legacy PostgreSQL DATABASE_URL', async () => {
    delete process.env.DB_URL;
    process.env.DATABASE_URL = 'postgres://legacy:password@localhost:5432/mcphub';

    await import('../../src/betterAuth.js');

    expect(poolMock).toHaveBeenCalledWith({
      connectionString: 'postgres://legacy:password@localhost:5432/mcphub',
    });
    expect(requireNativeMock).not.toHaveBeenCalled();
  });

  it('requires a database URL instead of using PostgreSQL defaults', async () => {
    delete process.env.DB_URL;
    delete process.env.DATABASE_URL;

    await expect(import('../../src/betterAuth.js')).rejects.toThrow(
      'DB_URL (or legacy DATABASE_URL) is required for Better Auth database storage.',
    );
    expect(poolMock).not.toHaveBeenCalled();
    expect(requireNativeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['postgresql://mcphub:password@localhost:5432/mcphub', poolEndMock],
    ['sqlite::memory:', sqliteCloseMock],
  ])('closes the auth-owned database only once for %s', async (url, closeMock) => {
    process.env.DB_URL = url;
    const { closeBetterAuthDatabase } = await import('../../src/betterAuth.js');

    await Promise.all([closeBetterAuthDatabase(), closeBetterAuthDatabase()]);
    await closeBetterAuthDatabase();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  describe('schema bootstrap', () => {
    it('does not inspect or migrate disabled Better Auth', async () => {
      resolveBetterAuthRuntimeConfigMock.mockReturnValue(disabledRuntimeConfig);
      const { ensureBetterAuthSchema } = await import('../../src/betterAuth.js');

      await ensureBetterAuthSchema();

      expect(getMigrationsMock).not.toHaveBeenCalled();
      expect(runMigrationsMock).not.toHaveBeenCalled();
    });

    it('does not rerun migrations when the schema is current', async () => {
      const { ensureBetterAuthSchema } = await import('../../src/betterAuth.js');

      await ensureBetterAuthSchema();

      expect(runMigrationsMock).not.toHaveBeenCalled();
      expect(poolQueryMock).not.toHaveBeenCalled();
    });

    it('preserves PostgreSQL schema discovery and existing-table handling', async () => {
      getMigrationsMock.mockResolvedValue({
        toBeCreated: [{ tableName: 'user' }, { table: 'session' }, { name: 'account' }],
        toBeAdded: [],
        runMigrations: runMigrationsMock,
      });
      poolQueryMock.mockResolvedValueOnce({ rows: [{ schema: 'auth' }] }).mockResolvedValueOnce({
        rows: [{ table_name: 'user' }, { table_name: 'session' }, { table_name: 'account' }],
      });
      const { ensureBetterAuthSchema } = await import('../../src/betterAuth.js');

      await ensureBetterAuthSchema();

      expect(poolQueryMock).toHaveBeenCalledWith('select current_schema() as schema');
      expect(poolQueryMock).toHaveBeenCalledWith(
        'select table_name from information_schema.tables where table_schema = $1 and table_name = any($2)',
        ['auth', ['user', 'session', 'account']],
      );
      expect(runMigrationsMock).not.toHaveBeenCalled();
      expect(sqlitePrepareMock).not.toHaveBeenCalled();
    });

    it('falls back to the public PostgreSQL schema when discovery fails', async () => {
      getMigrationsMock.mockResolvedValue({
        toBeCreated: ['user'],
        toBeAdded: [],
        runMigrations: runMigrationsMock,
      });
      poolQueryMock
        .mockRejectedValueOnce(new Error('schema discovery failed'))
        .mockResolvedValueOnce({ rows: [] });
      const { ensureBetterAuthSchema } = await import('../../src/betterAuth.js');

      await ensureBetterAuthSchema();

      expect(poolQueryMock).toHaveBeenLastCalledWith(expect.any(String), ['public', ['user']]);
      expect(runMigrationsMock).toHaveBeenCalledTimes(1);
    });

    it('discovers existing SQLite tables through sqlite_master, not PostgreSQL schemas', async () => {
      process.env.DB_URL = 'sqlite::memory:';
      getMigrationsMock.mockResolvedValue({
        toBeCreated: [{ table: 'user' }, { table: 'session' }],
        toBeAdded: [],
        runMigrations: runMigrationsMock,
      });
      sqliteTableAllMock.mockReturnValue([{ table_name: 'user' }, { table_name: 'session' }]);
      const { ensureBetterAuthSchema } = await import('../../src/betterAuth.js');

      await ensureBetterAuthSchema();

      expect(sqlitePrepareMock).toHaveBeenCalledWith(
        "select name as table_name from sqlite_master where type = 'table' and name in (?, ?)",
      );
      expect(sqliteTableAllMock).toHaveBeenCalledWith('user', 'session');
      expect(runMigrationsMock).not.toHaveBeenCalled();
      expect(poolQueryMock).not.toHaveBeenCalled();
    });

    it('creates missing SQLite tables', async () => {
      process.env.DB_URL = 'sqlite::memory:';
      getMigrationsMock.mockResolvedValue({
        toBeCreated: [{ table: 'user' }, { table: 'session' }],
        toBeAdded: [],
        runMigrations: runMigrationsMock,
      });
      sqliteTableAllMock.mockReturnValue([{ table_name: 'user' }]);
      const { ensureBetterAuthSchema } = await import('../../src/betterAuth.js');

      await ensureBetterAuthSchema();

      expect(runMigrationsMock).toHaveBeenCalledTimes(1);
    });

    it('still applies SQLite column additions even when tables already exist', async () => {
      process.env.DB_URL = 'sqlite::memory:';
      getMigrationsMock.mockResolvedValue({
        toBeCreated: [],
        toBeAdded: [{ table: 'user', fields: { image: { type: 'string' } } }],
        runMigrations: runMigrationsMock,
      });
      const { ensureBetterAuthSchema } = await import('../../src/betterAuth.js');

      await ensureBetterAuthSchema();

      expect(runMigrationsMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['postgresql://mcphub:password@localhost:5432/mcphub', 'relation "user" already exists'],
      ['sqlite::memory:', 'table "user" already exists'],
      ['sqlite::memory:', 'index user_email_uidx already exists'],
    ])('tolerates an already-existing relation for %s', async (url, message) => {
      process.env.DB_URL = url;
      getMigrationsMock.mockResolvedValue({
        toBeCreated: [{ table: 'user' }],
        toBeAdded: [],
        runMigrations: runMigrationsMock,
      });
      runMigrationsMock.mockRejectedValue(new Error(message));
      const { ensureBetterAuthSchema } = await import('../../src/betterAuth.js');

      await expect(ensureBetterAuthSchema()).resolves.toBeUndefined();

      expect(runMigrationsMock).toHaveBeenCalledTimes(1);
    });

    it.each(['postgresql://mcphub:password@localhost:5432/mcphub', 'sqlite::memory:'])(
      'does not hide unrelated migration errors for %s',
      async (url) => {
        process.env.DB_URL = url;
        getMigrationsMock.mockResolvedValue({
          toBeCreated: [{ table: 'user' }],
          toBeAdded: [],
          runMigrations: runMigrationsMock,
        });
        const error = new Error('database is locked');
        runMigrationsMock.mockRejectedValue(error);
        const { ensureBetterAuthSchema } = await import('../../src/betterAuth.js');

        await expect(ensureBetterAuthSchema()).rejects.toBe(error);
      },
    );
  });

  it('registers the generic OAuth plugin when the OIDC provider is enabled', async () => {
    await import('../../src/betterAuth.js');

    expect(genericOAuthMock).toHaveBeenCalledWith({
      config: [
        {
          providerId: 'local-oidc',
          discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
          clientId: 'oidc-client-id',
          clientSecret: 'oidc-client-secret',
          scopes: ['openid', 'profile', 'email'],
          pkce: true,
          prompt: 'login',
        },
      ],
    });

    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        socialProviders: {},
        trustedOrigins: ['https://mcp.imdevinc.home'],
        account: {
          accountLinking: {
            enabled: true,
            trustedProviders: ['local-oidc'],
          },
        },
        plugins: [
          {
            id: 'generic-oauth',
            options: {
              config: [
                {
                  providerId: 'local-oidc',
                  discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
                  clientId: 'oidc-client-id',
                  clientSecret: 'oidc-client-secret',
                  scopes: ['openid', 'profile', 'email'],
                  pkce: true,
                  prompt: 'login',
                },
              ],
            },
          },
        ],
      }),
    );
  });

  it('prefers BETTER_AUTH_URL over install.baseUrl when deriving the Better Auth base URL', async () => {
    process.env.USE_DB = 'false';
    loadSettingsMock.mockReturnValue({
      systemConfig: {
        install: {
          baseUrl: 'https://mcp.imdevinc.home/mcphub',
        },
      },
    });

    await import('../../src/betterAuth.js');

    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://localhost:5173/api/auth/better',
      }),
    );
  });

  it('builds the auth instance from the current resolved runtime config instead of the stale exported snapshot', async () => {
    await import('../../src/betterAuth.js');

    expect(resolveBetterAuthRuntimeConfigMock).toHaveBeenCalled();
    expect(genericOAuthMock).toHaveBeenCalledWith({
      config: [
        {
          providerId: 'local-oidc',
          discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
          clientId: 'oidc-client-id',
          clientSecret: 'oidc-client-secret',
          scopes: ['openid', 'profile', 'email'],
          pkce: true,
          prompt: 'login',
        },
      ],
    });

    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: [
          expect.objectContaining({
            id: 'generic-oauth',
          }),
        ],
      }),
    );
  });

  it('includes the OIDC provider in trustedProviders when OIDC is enabled and trustEmail is true', async () => {
    await import('../../src/betterAuth.js');

    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account: {
          accountLinking: {
            enabled: true,
            trustedProviders: ['local-oidc'],
          },
        },
      }),
    );
  });

  it('uses an empty trustedProviders when OIDC is enabled but trustEmail is false', async () => {
    resolveBetterAuthRuntimeConfigMock.mockReturnValue({
      ...runtimeConfig,
      providers: {
        ...runtimeConfig.providers,
        oidc: { ...runtimeConfig.providers.oidc, trustEmail: false },
      },
    });

    await import('../../src/betterAuth.js');

    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account: {
          accountLinking: {
            enabled: true,
            trustedProviders: [],
          },
        },
      }),
    );
  });

  it('uses an empty trustedProviders when OIDC is disabled', async () => {
    resolveBetterAuthRuntimeConfigMock.mockReturnValue({
      ...disabledRuntimeConfig,
      providers: {
        ...disabledRuntimeConfig.providers,
        oidc: { ...disabledRuntimeConfig.providers.oidc, enabled: false },
      },
    });

    await import('../../src/betterAuth.js');

    expect(betterAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account: {
          accountLinking: {
            enabled: true,
            trustedProviders: [],
          },
        },
      }),
    );
  });
});
