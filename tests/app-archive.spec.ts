import { describe, expect, it } from 'vitest';
import { renderSite } from '../src/app';
import type { Env } from '../src/env';
import { DEFAULT_ROUTING_TABLE } from './helpers/render-theme';

function createEnv(theme = 'default', content?: Record<string, unknown>): Env {
  const values = [
    { name: 'installed', value: '1' },
    { name: 'theme', value: theme },
    { name: 'title', value: 'Empty Blog' },
    { name: 'siteUrl', value: 'https://example.test' },
    { name: 'rewrite', value: '1' },
    { name: 'routingTable', value: JSON.stringify(DEFAULT_ROUTING_TABLE) },
  ];
  const d1 = {
    prepare(sql: string) {
      const stmt = {
        bind() { return stmt; },
        async all() { return { results: sql.includes('FROM typecho_options') ? values : [] }; },
        async first() {
          if (sql.includes("name = 'installed'")) return { value: '1' };
          if (sql.includes("'administrator'")) return { uid: 1 };
          if (content && sql.includes('FROM typecho_contents WHERE cid = ?')) return content;
          if (sql.includes('COUNT(')) return { num: 0 };
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { DB: d1 } as Env;
}

describe('empty public archive', () => {
  it('shows the theme empty state instead of a 404 response', async () => {
    const response = await renderSite(createEnv(), new Request('https://example.test/'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('没有找到内容');
  });

  it('renders the themed 404 without revealing internal errors', async () => {
    const response = await renderSite(createEnv(), new Request('https://example.test/unknown-address'));
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('页面没找到');
    expect(html).not.toContain('Internal Server Error');
  });

  it('resolves comment-page URLs to the underlying published article', async () => {
    const content = {
      cid: 42, title: 'Commented Article', slug: 'commented', created: 1700000000,
      modified: 1700000000, type: 'post', status: 'publish', text: '<!--markdown-->Welcome',
      password: null, commentsNum: 0, allowComment: '0', allowFeed: '1', authorId: 1,
    };
    const response = await renderSite(createEnv('default', content), new Request('https://example.test/archives/42/comment-page-2/'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Commented Article');
  });

  it('uses the classic-22 search template rather than its generic archive page', async () => {
    const response = await renderSite(createEnv('classic-22'), new Request('https://example.test/search/nothing/'));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="s" name="s"');
    expect(html).toContain('没有找到内容');
  });
});
