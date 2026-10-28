import { describe, expect, it } from 'vitest';
import { renderSite } from '../src/app';
import type { Env } from '../src/env';

const routes = { search: { url: '/search/[keywords]/', widget: '\\Widget\\Archive', action: 'render' } };
const options = [
  { name: 'installed', value: '1' },
  { name: 'theme', value: 'default' },
  { name: 'rewrite', value: '1' },
  { name: 'routingTable', value: JSON.stringify(routes) },
];
const d1 = {
  prepare(sql: string) {
    return {
      async all() { return { results: sql.includes('typecho_options') ? options : [] }; },
      async first() {
        if (sql.includes("name = 'installed'")) return { value: '1' };
        if (sql.includes('typecho_users') && sql.includes("'administrator'")) return { uid: 1 };
        return null;
      },
    };
  },
} as unknown as D1Database;
const env = { DB: d1 } as Env;

describe('theme search form', () => {
  it('redirects a POST search query with UTF-8-safe routing', async () => {
    const response = await renderSite(env, new Request('https://example.test/', {
      method: 'POST', body: new URLSearchParams({ s: '测试 Word' }),
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://example.test/search/%E6%B5%8B%E8%AF%95%20Word/');
  });

  it('rejects empty search terms', async () => {
    const response = await renderSite(env, new Request('https://example.test/?s=%20'));
    expect(response.status).toBe(400);
  });
});
