import { describe, expect, it } from 'vitest';
import { chooseThemeFile, renderSite } from '../src/app';
import type { BundledThemeStore } from '../src/core/theme';
import type { Archive } from '../src/widgets/archive';
import type { Env } from '../src/env';
import { DEFAULT_ROUTING_TABLE } from './helpers/render-theme';

function createEnv(theme = 'default', content?: Record<string, unknown>, routes = DEFAULT_ROUTING_TABLE, frontPage = 'recent'): Env {
  const values = [
    { name: 'installed', value: '1' },
    { name: 'theme', value: theme },
    { name: 'title', value: 'Empty Blog' },
    { name: 'siteUrl', value: 'https://example.test' },
    { name: 'rewrite', value: '1' },
    { name: 'frontPage', value: frontPage },
    { name: 'routingTable', value: JSON.stringify(routes) },
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

describe('Typecho archive template fallback', () => {
  it.each([
    ['page', 'page-slug', true, '', ['single.php', 'index.php'], 'single.php'],
    ['page', 'page-slug', true, '', ['index.php'], 'index.php'],
    ['attachment', 'file', true, '', ['post.php', 'single.php', 'index.php'], 'post.php'],
    ['attachment', 'file', true, '', ['page.php', 'post.php', 'index.php'], 'page.php'],
    ['category', 'news', false, '', ['category/news.php', 'category.php', 'archive.php'], 'category/news.php'],
    ['author', '7', false, '', ['author/7.php', 'author.php', 'archive.php'], 'author/7.php'],
    ['post', 'slug', true, 'special.php', ['special.php', 'post.php', 'index.php'], 'special.php'],
  ])('%s selects %s before later fallbacks', async (kind, slug, single, custom, files, expected) => {
    const store = { exists: async (_theme: string, path: string) => (files as string[]).includes(path) } as unknown as BundledThemeStore;
    const archive = { archiveType: kind, archiveSlug: slug, archiveSingle: single, themeFile: custom } as unknown as Archive;
    expect(await chooseThemeFile(store, 'sample', archive, false)).toBe(expected);
  });
});

describe('empty public archive', () => {
  it('shows the theme empty state instead of a 404 response', async () => {
    const response = await renderSite(createEnv(), new Request('https://example.test/'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('没有找到内容');
  });

  it('serves a safe configured theme file as the homepage without treating an empty list as 404', async () => {
    const response = await renderSite(createEnv('default', undefined, DEFAULT_ROUTING_TABLE, 'file:404.php'), new Request('https://example.test/'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('404 - 页面没找到');
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

  it('resolves a published attachment comment-page URL to the attachment', async () => {
    const content = {
      cid: 42, title: 'Image Attachment', slug: 'image', created: 1700000000,
      modified: 1700000000, type: 'attachment', status: 'publish', text: '',
      password: null, commentsNum: 0, allowComment: '0', allowFeed: '1', authorId: 1,
    };
    const routes = {
      ...DEFAULT_ROUTING_TABLE,
      comment_page: { url: '[permalink:string]/comment-page-[commentPage:digital]', widget: '\\Widget\\CommentPage', action: 'action' },
    };
    const response = await renderSite(createEnv('default', content, routes), new Request('https://example.test/attachment/42/comment-page-2/'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Image Attachment');
  });

  it('uses the classic-22 search template rather than its generic archive page', async () => {
    const response = await renderSite(createEnv('classic-22'), new Request('https://example.test/search/nothing/'));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="s" name="s"');
    expect(html).toContain('没有找到内容');
  });
});
