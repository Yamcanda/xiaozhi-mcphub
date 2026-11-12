import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type DatabaseTarget =
  | { type: 'postgres'; url: string }
  | { type: 'better-sqlite3'; database: string };

/** Resolve storage without changing the default JSON mode or existing PostgreSQL URLs. */
export function parseDatabaseUrl(value: string): DatabaseTarget {
  const url = value.trim();
  if (/^postgres(?:ql)?:\/\//i.test(url)) {
    return { type: 'postgres', url };
  }

  if (/^sqlite:/i.test(url)) {
    // sqlite:./data/app.sqlite is relative to cwd; sqlite:///data/app.sqlite is absolute.
    const database = url.slice('sqlite:'.length).replace(/^\/\//, '');
    if (!database || database.includes('\0') || /[?#]/.test(database)) {
      throw new Error('Invalid SQLite URL. Use sqlite:./data/mcphub.sqlite or sqlite::memory:.');
    }
    return {
      type: 'better-sqlite3',
      database: database === ':memory:' ? database : path.resolve(database),
    };
  }

  throw new Error('Unsupported database URL. Use postgres://, postgresql://, or sqlite:.');
}

/** Create only the containing directory; opening the SQLite file is the driver's responsibility. */
export function prepareSqliteDatabase(database: string): void {
  if (database !== ':memory:') {
    mkdirSync(path.dirname(database), { recursive: true });
  }
}

export function isPostgresUrl(value: string | undefined): boolean {
  return /^postgres(?:ql)?:\/\//i.test(value?.trim() ?? '');
}
