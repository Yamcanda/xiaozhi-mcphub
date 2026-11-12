import path from 'node:path';
import { isPostgresUrl, parseDatabaseUrl } from './database.js';

describe('database targets', () => {
  it.each(['postgres://user:pass@localhost/db', 'postgresql://localhost/db'])(
    'preserves PostgreSQL connection strings: %s',
    (url) => expect(parseDatabaseUrl(` ${url} `)).toEqual({ type: 'postgres', url }),
  );

  it('resolves SQLite files relative to the working directory', () => {
    expect(parseDatabaseUrl('sqlite:./data/mcphub.sqlite')).toEqual({
      type: 'better-sqlite3',
      database: path.resolve('data/mcphub.sqlite'),
    });
  });

  it('supports absolute SQLite paths and URL-style slash prefixes', () => {
    const database = path.resolve('data/mcphub.sqlite');
    expect(parseDatabaseUrl(`sqlite:${database}`)).toEqual({ type: 'better-sqlite3', database });
    expect(parseDatabaseUrl(`sqlite://${database}`)).toEqual({ type: 'better-sqlite3', database });
  });

  it('keeps in-memory SQLite ephemeral', () => {
    expect(parseDatabaseUrl('sqlite::memory:')).toEqual({
      type: 'better-sqlite3',
      database: ':memory:',
    });
  });

  it.each([
    '',
    'mysql://localhost/db',
    './data/db.sqlite',
    'sqlite:',
    'sqlite://',
    'sqlite:file?mode=ro',
    'sqlite:file#fragment',
  ])('rejects unsupported or ambiguous targets: %s', (url) =>
    expect(() => parseDatabaseUrl(url)).toThrow(),
  );

  it('recognizes only PostgreSQL URLs as vector-capable', () => {
    expect(isPostgresUrl(' postgresql://localhost/db ')).toBe(true);
    expect(isPostgresUrl('sqlite::memory:')).toBe(false);
    expect(isPostgresUrl(undefined)).toBe(false);
  });
});
