import { describe, expect, it } from 'vitest';
import { renderSite } from '../src/app';
import { schemaStatements } from '../src/core/schema';
import type { Env } from '../src/env';

/**
 * Stands in for a freshly created (or deleted) D1 database: every table query
 * fails with D1's `no such table` error until the worker creates the schema.
 */
function emptyDatabaseEnv() {
  let created = false;
  const executed: string[] = [];
  const d1 = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async all() {
          if (!created && /FROM\s+typecho_/i.test(sql)) {
            const table = /FROM\s+(typecho_\w+)/i.exec(sql)?.[1] ?? 'typecho_options';
            throw new Error(`D1_ERROR: no such table: ${table}: SQLITE_ERROR`);
          }
          return { results: [] };
        },
        async first() {
          if (!created && /typecho_/i.test(sql)) {
            const table = /(typecho_\w+)/i.exec(sql)?.[1] ?? 'typecho_options';
            throw new Error(`D1_ERROR: no such table: ${table}: SQLITE_ERROR`);
          }
          if (sql.includes('AS occupied')) return { occupied: 0 };
          if (sql.includes('COUNT(')) return { num: 0 };
          return null;
        },
      };
      return statement;
    },
    async batch(statements: Array<{ sql: string }>) {
      executed.push(...statements.map((item) => item.sql));
      created = true;
      return [];
    },
  } as unknown as D1Database;
  return { env: { DB: d1 } as Env, executed };
}

describe('schema bootstrap for a fresh database', () => {
  it('creates the tables and renders the installer instead of failing with 500', async () => {
    const { env, executed } = emptyDatabaseEnv();
    const response = await renderSite(env, new Request('https://example.test/'));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('管理员用户名');
    expect(executed.some((sql) => /CREATE TABLE IF NOT EXISTS typecho_options/.test(sql))).toBe(true);
    expect(executed.some((sql) => /CREATE TABLE IF NOT EXISTS typecho_users/.test(sql))).toBe(true);
  });

  it('serves uninstalled requests through the same path as an existing schema', async () => {
    const { env, executed } = emptyDatabaseEnv();
    const install = await renderSite(env, new Request('https://example.test/install.php'));
    const login = await renderSite(env, new Request('https://example.test/admin/login.php'));

    expect(install.status).toBe(200);
    expect(login.status).toBe(200);
    expect(executed.length).toBeGreaterThan(0);
  });
});

describe('schema statement prefixing', () => {
  it('rewrites the bundled typecho_ prefix for custom DB_PREFIX values', () => {
    const [first] = schemaStatements('blog_');
    expect(first).toContain('CREATE TABLE IF NOT EXISTS blog_comments');
    expect(first).not.toContain('typecho_');
  });
});
