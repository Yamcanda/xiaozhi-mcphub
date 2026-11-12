import { betterAuth, BetterAuthOptions } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { PostgresDialect, SqliteDialect } from 'kysely';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Pool } from 'pg';
import defaultConfig, { loadSettings } from './config/index.js';
import { parseDatabaseUrl, prepareSqliteDatabase } from './config/database.js';
import { getDatabaseUrlFromEnv } from './config/dbEnv.js';
import { resolveBetterAuthRuntimeConfig } from './services/betterAuthConfig.js';
import { resolveInstallBaseUrl } from './utils/installBaseUrl.js';
import { getCurrentModuleDir } from './utils/moduleDir.js';
import { getCachedSystemConfig, isDatabaseModeEnabled } from './utils/systemConfigCache.js';

const resolveSystemConfig = () => {
  const cachedSystemConfig = getCachedSystemConfig();
  if (cachedSystemConfig) {
    return cachedSystemConfig;
  }

  if (!isDatabaseModeEnabled()) {
    return loadSettings().systemConfig ?? null;
  }

  return null;
};

const systemConfig = resolveSystemConfig();
const runtimeConfig = resolveBetterAuthRuntimeConfig(systemConfig);
const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
const plugins: any[] = [];
if (
  runtimeConfig.providers.google.enabled &&
  process.env.GOOGLE_CLIENT_ID &&
  process.env.GOOGLE_CLIENT_SECRET
) {
  socialProviders.google = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  };
}
if (
  runtimeConfig.providers.github.enabled &&
  process.env.GITHUB_CLIENT_ID &&
  process.env.GITHUB_CLIENT_SECRET
) {
  socialProviders.github = {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  };
}
if (
  runtimeConfig.providers.oidc.enabled &&
  runtimeConfig.providers.oidc.discoveryUrl &&
  process.env.OIDC_CLIENT_ID &&
  process.env.OIDC_CLIENT_SECRET
) {
  plugins.push(
    genericOAuth({
      config: [
        {
          providerId: runtimeConfig.providers.oidc.providerId,
          discoveryUrl: runtimeConfig.providers.oidc.discoveryUrl,
          clientId: process.env.OIDC_CLIENT_ID,
          clientSecret: process.env.OIDC_CLIENT_SECRET,
          scopes: runtimeConfig.providers.oidc.scopes,
          pkce: runtimeConfig.providers.oidc.pkce,
          prompt: runtimeConfig.providers.oidc.prompt,
        },
      ],
    }),
  );
}

const resolveBaseURL = (baseUrl: string, basePath: string): string => {
  const normalizedPath = basePath.startsWith('/') ? basePath : `/${basePath}`;
  try {
    const url = new URL(baseUrl);
    if (url.pathname === '/' || url.pathname === '') {
      url.pathname = normalizedPath;
      return url.toString();
    }
    if (url.pathname.endsWith(normalizedPath)) {
      return url.toString();
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${normalizedPath}`;
    return url.toString();
  } catch {
    const trimmedBase = baseUrl.replace(/\/+$/, '');
    return `${trimmedBase}${normalizedPath}`;
  }
};

const systemInstallBaseUrl = resolveInstallBaseUrl(systemConfig);
const baseURL = resolveBaseURL(
  process.env.BETTER_AUTH_URL ||
    systemInstallBaseUrl ||
    `http://localhost:${defaultConfig.port}${defaultConfig.basePath}`,
  runtimeConfig.basePath,
);

const databaseUrl = getDatabaseUrlFromEnv();
if (!databaseUrl) {
  throw new Error('DB_URL (or legacy DATABASE_URL) is required for Better Auth database storage.');
}

const databaseTarget = parseDatabaseUrl(databaseUrl);
const storage = (() => {
  if (databaseTarget.type === 'postgres') {
    const pool = new Pool({ connectionString: databaseTarget.url });
    return { type: 'postgres' as const, pool, dialect: new PostgresDialect({ pool }) };
  }

  prepareSqliteDatabase(databaseTarget.database);
  // Resolve from this package, not cwd, and never load the native binding for PostgreSQL.
  const require = createRequire(path.join(getCurrentModuleDir(), '..', 'betterAuth.js'));
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  // Auth owns its connection; :memory: is intentionally separate from TypeORM's database.
  const sqlite: SqliteDatabase = new Database(databaseTarget.database);
  sqlite.pragma('foreign_keys = ON');
  return { type: 'sqlite' as const, sqlite, dialect: new SqliteDialect({ database: sqlite }) };
})();

const authOptions: BetterAuthOptions = {
  baseURL,
  database: storage.dialect,
  emailAndPassword: {
    enabled: false,
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: [
        ...(runtimeConfig.providers.oidc.enabled && runtimeConfig.providers.oidc.trustEmail
          ? [runtimeConfig.providers.oidc.providerId]
          : []),
      ],
    },
  },
  plugins,
  socialProviders,
  trustedOrigins: runtimeConfig.trustedOrigins,
  logger: {
    disabled: false,
    disableColors: false,
    level: 'info',
    log: (level, message, ...args) => {
      console.log('[better-auth]', { level, message }, ...args);
    },
  },
};

export const auth = betterAuth(authOptions);

let closePromise: Promise<void> | undefined;

/** Close the auth-owned connection separately from TypeORM during application shutdown. */
export const closeBetterAuthDatabase = (): Promise<void> => {
  closePromise ??= (async () => {
    if (storage.type === 'postgres') {
      await storage.pool.end();
    } else if (storage.sqlite.open) {
      storage.sqlite.close();
    }
  })();
  return closePromise;
};

const extractMigrationTableName = (entry: unknown): string | null => {
  if (typeof entry === 'string') {
    return entry;
  }
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const candidate = record.tableName ?? record.table ?? record.name;
  return typeof candidate === 'string' ? candidate : null;
};

const resolveCurrentSchema = async (): Promise<string> => {
  if (storage.type === 'sqlite') {
    return 'main';
  }
  try {
    const result = await storage.pool.query<{ schema: string }>(
      'select current_schema() as schema',
    );
    return result.rows[0]?.schema || 'public';
  } catch {
    return 'public';
  }
};

const listExistingTables = async (schema: string, tableNames: string[]): Promise<Set<string>> => {
  if (!tableNames.length) {
    return new Set();
  }
  if (storage.type === 'sqlite') {
    const placeholders = tableNames.map(() => '?').join(', ');
    const rows = storage.sqlite
      .prepare<
        string[],
        { table_name: string }
      >(`select name as table_name from sqlite_master where type = 'table' and name in (${placeholders})`)
      .all(...tableNames);
    return new Set(rows.map((row) => row.table_name));
  }
  const result = await storage.pool.query<{ table_name: string }>(
    'select table_name from information_schema.tables where table_schema = $1 and table_name = any($2)',
    [schema, tableNames],
  );
  return new Set(result.rows.map((row) => row.table_name));
};

const isRelationAlreadyExistsError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const message = String((error as { message?: string }).message ?? '');
  return storage.type === 'sqlite'
    ? /^(?:table|index)\s+.+\s+already\s+exists$/i.test(message)
    : /relation\s+".*"\s+already\s+exists/i.test(message);
};

export const ensureBetterAuthSchema = async (): Promise<void> => {
  if (!runtimeConfig.enabled) {
    return;
  }

  const { getMigrations } = await import('better-auth/db/migration');
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(authOptions);

  if (!toBeCreated.length && !toBeAdded.length) {
    return;
  }

  if (toBeCreated.length) {
    const tableNames = toBeCreated
      .map((entry) => extractMigrationTableName(entry))
      .filter((tableName): tableName is string => Boolean(tableName));
    if (tableNames.length === toBeCreated.length) {
      const schema = await resolveCurrentSchema();
      const existingTables = await listExistingTables(schema, tableNames);
      const allTablesExist = tableNames.every((tableName) => existingTables.has(tableName));
      if (allTablesExist && !toBeAdded.length) {
        console.warn(
          `[better-auth] Detected existing tables in schema "${schema}"; skipping migrations.`,
        );
        return;
      }
    }
  }

  try {
    await runMigrations();
  } catch (error) {
    if (isRelationAlreadyExistsError(error)) {
      console.warn('[better-auth] Migration skipped due to existing relations.', error);
      return;
    }
    throw error;
  }
};
export { runtimeConfig as betterAuthRuntimeConfig };
