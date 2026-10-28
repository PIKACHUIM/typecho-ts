// @ts-expect-error This test uses Node's built-in SQLite; Worker tsconfig intentionally excludes Node types.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { PhpHost } from '../php-compat/host';
import type { AuthUser } from '../src/core/auth';
import type { Db } from '../src/core/db';
import { SiteOptions, type OptionValues } from '../src/core/options';
import { buildRequestContext } from '../src/core/request';
import { countComments, countContents, findContent, listComments, listContents, listPages, listRecentComments, type ContentRow } from '../src/repo/content';
import { Archive } from '../src/widgets/archive';
import { siteValues } from './helpers/render-theme';

const now = Math.floor(Date.now() / 1000);
const published = {
  cid: 12,
  slug: 'visible',
  title: 'Visible',
  type: 'post',
  status: 'publish',
  created: now - 100,
  password: null,
} as ContentRow;

function publicDb(row: ContentRow | null = null) {
  const first = vi.fn(async (sql: string, params: unknown[]) => {
    if (!sql.includes('FROM table.contents') || !row) return null;
    if (!sql.includes('type = ?') || !sql.includes('status = ?') || !sql.includes('created <= ?') || !sql.includes('password IS NULL OR password =')) return null;
    return params[0] === (sql.includes('cid = ?') ? row.cid : row.slug)
      && params[1] === row.type && params[2] === row.status && row.created <= Number(params[3])
      && !row.password ? row : null;
  });
  return {
    db: { first, all: vi.fn(async () => []), count: vi.fn(async () => 0) } as unknown as Db,
    first,
  };
}

function sqliteContentDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE contents (cid INTEGER PRIMARY KEY, title TEXT, text TEXT, type TEXT, status TEXT, created INTEGER, password TEXT);
    CREATE TABLE metas (mid INTEGER PRIMARY KEY, slug TEXT, type TEXT, parent INTEGER);
    CREATE TABLE relationships (cid INTEGER, mid INTEGER);
  `);
  const prepare = (sql: string) => sqlite.prepare(sql.replaceAll('table.', ''));
  const db = {
    all: async (sql: string, params: unknown[]) => prepare(sql).all(...params as (string | number | null)[]),
    count: async (sql: string, params: unknown[]) => Number((prepare(sql).get(...params as (string | number | null)[]) as { num: number }).num),
  } as unknown as Db;
  const addContent = (cid: number, title: string, text: string | null = null, created = 1_700_000_000, status = 'publish', password: string | null = null) => {
    sqlite.prepare('INSERT INTO contents VALUES (?, ?, ?, ?, ?, ?, ?)').run(cid, title, text, 'post', status, created, password);
  };
  return { sqlite, db, addContent };
}

function archive(db: Db, type: string, params?: Record<string, string>, values: OptionValues = siteValues(), echo: (value: unknown) => void = () => {}) {
  const request = buildRequestContext(new Request('http://example.com/'));
  const options = new SiteOptions({ values, request, echo });
  return new Archive({ db, options, request, echo, type, params });
}

describe('public content queries', () => {
  it('requires matching route type, published status, no future creation, and no password for CID and slug', async () => {
    const { db, first } = publicDb(published);
    expect(await findContent(db, { cid: 12, type: 'post' })).toEqual(published);
    expect(await findContent(db, { cid: 12, type: 'page' })).toBeNull();
    expect(await findContent(db, { slug: 'visible', type: 'post' })).toEqual(published);
    expect(await findContent(db, { slug: 'missing', type: 'post' })).toBeNull();
    expect(first).toHaveBeenCalledWith(expect.stringContaining('cid = ? AND type = ? AND status = ? AND created <= ?'), [12, 'post', 'publish', expect.any(Number)]);
    expect(first).toHaveBeenCalledWith(expect.stringContaining('slug = ? AND type = ? AND status = ? AND created <= ?'), ['visible', 'post', 'publish', expect.any(Number)]);
  });

  it('makes a published article visible immediately in its creation second', async () => {
    vi.useFakeTimers();
    try {
      const created = 1793174316;
      vi.setSystemTime(created * 1000);
      const row = { ...published, created };
      const { db } = publicDb(row);
      expect(await findContent(db, { cid: row.cid, type: 'post' })).toEqual(row);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['draft', { status: 'draft' }],
    ['private', { status: 'private' }],
    ['hidden', { status: 'hidden' }],
    ['future', { created: now + 3600 }],
    ['password-protected', { password: 'secret' }],
  ])('never returns a %s row on public single lookup', async (_name, change) => {
    const { db } = publicDb({ ...published, ...change });
    expect(await findContent(db, { cid: 12, type: 'post' })).toBeNull();
  });

  it('applies public-only constraints to listings, page navigation, and recent comments', async () => {
    const all = vi.fn(async (_sql: string, _params?: unknown[]) => []);
    const count = vi.fn(async (_sql: string, _params?: unknown[]) => 0);
    const db = { all, count } as unknown as Db;
    await listContents(db, {});
    await countContents(db, {});
    await listPages(db);
    await listRecentComments(db);
    await listComments(db, 12);
    await countComments(db, 12);
    const listing = all.mock.calls[0][0] as string;
    const countQuery = count.mock.calls[0][0];
    const pages = all.mock.calls[1][0];
    const comments = all.mock.calls[2][0];
    const articleComments = all.mock.calls[3][0];
    const articleCommentsCount = count.mock.calls[1][0];
    for (const query of [listing, countQuery, pages, comments, articleComments, articleCommentsCount]) {
      expect(query).toContain('created <= ?');
      expect(query).toContain('password IS NULL OR');
    }
    expect(all.mock.calls[0][1]).toEqual(['post', 'publish', expect.any(Number), 10, 0]);
    expect(count.mock.calls[0][1]).toEqual(['post', 'publish', expect.any(Number)]);
    expect(pages).toContain("status = 'publish'");
    expect(comments).toContain("status = 'publish'");
    expect(comments).toContain('JOIN table.contents');
    expect(articleComments).toContain('JOIN table.contents');
    expect(articleCommentsCount).toContain('JOIN table.contents');
    expect(all.mock.calls[2][1]).toEqual([expect.any(Number), 5]);
    expect(all.mock.calls[3][1]).toEqual([12, expect.any(Number)]);
  });

  it('includes descendants of a category without duplicating articles, but keeps tags direct', async () => {
    const { sqlite, db, addContent } = sqliteContentDb();
    try {
      const metas = sqlite.prepare('INSERT INTO metas VALUES (?, ?, ?, ?)');
      for (const meta of [
        [1, 'parent', 'category', 0], [2, 'child', 'category', 1],
        [3, 'grandchild', 'category', 2], [4, 'unrelated', 'category', 0],
        [5, 'tag', 'tag', 1],
      ] as const) metas.run(...meta);
      const relation = sqlite.prepare('INSERT INTO relationships VALUES (?, ?)');
      for (const [cid, mid] of [[1, 1], [2, 2], [3, 3], [3, 1], [4, 4], [5, 5], [6, 3], [7, 3], [8, 3]]) relation.run(cid, mid);
      for (const cid of [1, 2, 3, 4, 5]) addContent(cid, `article ${cid}`);
      addContent(6, 'draft', null, 1_700_000_000, 'draft');
      addContent(7, 'future', null, 2_000_000_000);
      addContent(8, 'private', null, 1_700_000_000, 'publish', 'secret');
      expect((await listContents(db, { categorySlug: 'parent' })).map((row) => row.cid)).toEqual([3, 2, 1]);
      expect(await countContents(db, { categorySlug: 'parent' })).toBe(3);
      expect((await listContents(db, { categorySlug: 'child' })).map((row) => row.cid)).toEqual([3, 2]);
      expect((await listContents(db, { tagSlug: 'tag' })).map((row) => row.cid)).toEqual([5]);
    } finally {
      sqlite.close();
    }
  });

  it('finds ordered search words separated by arbitrarily long text without LIKE patterns', async () => {
    const { sqlite, db, addContent } = sqliteContentDb();
    try {
      addContent(1, `alpha ${'中'.repeat(70)} beta`);
      addContent(2, 'beta ... alpha');
      addContent(3, 'alpha', 'beta');
      addContent(4, 'unrelated', `alpha ${'中'.repeat(70)} beta`);
      addContent(5, 'alpha beta', null, 1_700_000_000, 'draft');
      expect((await listContents(db, { keywords: 'alpha   beta' })).map((row) => row.cid)).toEqual([4, 1]);
      expect(await countContents(db, { keywords: 'alpha   beta' })).toBe(2);
      expect((await listContents(db, { keywords: 'beta alpha' })).map((row) => row.cid)).toEqual([2]);
      addContent(6, '界'.repeat(60));
      expect((await listContents(db, { keywords: '界'.repeat(30) })).map((row) => row.cid)).toEqual([6]);
      const manyWords = Array.from({ length: 60 }, (_, index) => `word${index}`);
      addContent(7, manyWords.join(' -- '));
      expect((await listContents(db, { keywords: manyWords.join(' ') })).map((row) => row.cid)).toEqual([7]);
      const all = vi.fn(async (_sql: string, _params: unknown[]) => []);
      await listContents({ all } as unknown as Db, { keywords: 'alpha beta' });
      expect(all.mock.calls[0][0]).not.toMatch(/\bLIKE\b/i);
      expect(all.mock.calls[0][1]).toEqual(['post', 'publish', expect.any(Number), '["alpha","beta"]', '["alpha","beta"]', 10, 0]);
    } finally {
      sqlite.close();
    }
  });

  it('uses the site timezone for inclusive start and exclusive end of day, month and year', async () => {
    const { sqlite, db, addContent } = sqliteContentDb();
    try {
      const start = Date.UTC(2024, 0, 1) / 1000 - 28800;
      const end = Date.UTC(2024, 0, 2) / 1000 - 28800;
      addContent(1, 'just before', null, start - 1);
      addContent(2, 'start of local day', null, start);
      addContent(3, 'end of local day', null, end - 1);
      addContent(4, 'next local day', null, end);
      const date = { year: 2024, month: 1, day: 1, timezoneOffset: 28800 };
      expect((await listContents(db, date)).map((row) => row.cid)).toEqual([3, 2]);
      expect(await countContents(db, date)).toBe(2);
      expect((await listContents(db, { year: 2024, month: 1, timezoneOffset: 28800 })).map((row) => row.cid)).toEqual([4, 3, 2]);
      addContent(7, 'start of local February', null, Date.UTC(2024, 1, 1) / 1000 - 28800);
      addContent(8, 'start of next local year', null, Date.UTC(2025, 0, 1) / 1000 - 28800);
      expect((await listContents(db, { year: 2024, month: 1, timezoneOffset: 28800 })).map((row) => row.cid)).toEqual([4, 3, 2]);
      expect((await listContents(db, { year: 2024, timezoneOffset: 28800 })).map((row) => row.cid)).toEqual([7, 4, 3, 2]);
      const westernStart = Date.UTC(2024, 0, 1, 5) / 1000;
      addContent(5, 'west before', null, westernStart - 1);
      addContent(6, 'west start', null, westernStart);
      expect((await listContents(db, { year: 2024, month: 1, day: 1, timezoneOffset: -18000 })).map((row) => row.cid)).toEqual([4, 3, 6]);
    } finally {
      sqlite.close();
    }
  });
});

describe('archive visibility', () => {
  it.each([
    ['post', { cid: '12' }, published, false],
    ['post', { cid: '12' }, { ...published, status: 'draft' }, true],
    ['post', { cid: '12' }, { ...published, type: 'page' }, true],
    ['attachment', { cid: '12' }, published, true],
    ['page', { slug: 'visible' }, { ...published, type: 'page' }, false],
    ['page', { slug: 'visible' }, { ...published, type: 'page', created: now + 3600 }, true],
  ])('restricts %s route to its published content type', async (type, params, row, missing) => {
    const view = archive(publicDb(row as ContentRow).db, type, params);
    await view.ensureLoaded();
    expect(view.notFound).toBe(missing);
    expect(await view.have()).toBe(!missing);
  });

  it('keeps empty first-page listings valid but rejects out-of-range pages', async () => {
    const { db } = publicDb();
    const index = archive(db, 'index');
    await index.ensureLoaded();
    expect(index.notFound).toBe(false);
    expect(await index.have()).toBe(false);
    const paged = archive(db, 'index_page', { page: '2' });
    await paged.ensureLoaded();
    expect(paged.notFound).toBe(true);
  });

  it('uses the configured front archive, but rejects an unconfigured archive route', async () => {
    const { db } = publicDb();
    const front = archive(db, 'archive', undefined, siteValues({ frontPage: 'page:12', frontArchive: '1' }));
    await front.ensureLoaded();
    expect(front.archiveType).toBe('front');
    expect(front.notFound).toBe(false);
    const missing = archive(db, 'archive');
    await missing.ensureLoaded();
    expect(missing.notFound).toBe(true);
  });

  it('distinguishes an empty category from a nonexistent category', async () => {
    const all = vi.fn(async (sql: string) => sql.startsWith('SELECT * FROM table.metas')
      ? [{ mid: 1, slug: 'empty', name: 'Empty', type: 'category', description: null }]
      : []);
    const db = { all, count: vi.fn(async () => 0) } as unknown as Db;
    const existing = archive(db, 'category', { slug: 'empty' });
    await existing.ensureLoaded();
    expect(existing.notFound).toBe(false);
    expect(await existing.have()).toBe(false);
    const missing = archive(db, 'category', { slug: 'missing' });
    await missing.ensureLoaded();
    expect(missing.notFound).toBe(true);
  });

  it('decodes UTF-8 search keywords for SQL but keeps the canonical URL encoded', async () => {
    const all = vi.fn(async (_sql: string, _params: unknown[]) => []);
    const db = { all, count: vi.fn(async () => 0) } as unknown as Db;
    const encoded = '%E6%B5%8B%E8%AF%95%20A%26B';
    const view = archive(db, 'search', { keywords: encoded });
    await view.ensureLoaded();
    expect(all.mock.calls[0][1]).toContain('["测试","A&B"]');
    expect(view.archiveSlug).toBe('测试 A&B');
    expect(view.archiveUrl).toBe(`http://example.com/search/${encoded}/`);
  });

  it('rejects malformed escapes and HTML-escapes reflected search titles', async () => {
    const { db } = publicDb();
    const invalid = archive(db, 'search', { keywords: '%ZZ' });
    await invalid.ensureLoaded();
    expect(invalid.notFound).toBe(true);
    const output: unknown[] = [];
    const view = archive(db, 'search', { keywords: '%3Cscript%3E' }, siteValues(), (value) => output.push(value));
    await view.ensureLoaded();
    await view.archiveTitle([], '', '');
    expect(output).toEqual(['&lt;script&gt;']);
  });

  it('reflects an authenticated user and restricts PHP permission checks by role', () => {
    const output: unknown[] = [];
    const echo = (value: unknown) => output.push(value);
    const request = buildRequestContext(new Request('http://example.com/'));
    const user: AuthUser = {
      uid: 7, name: 'writer', screenName: '<Writer>', mail: 'writer@example.com',
      group: 'contributor', password: 'hash', authCode: 'secret',
    };
    const options = new SiteOptions({ values: siteValues(), request, echo, user });
    const view = new Archive({ db: publicDb().db, options, request, echo, type: 'index' });
    const host = view.phpGet('user') as PhpHost;
    expect(host.phpGet('uid')).toBe(7);
    expect(host.phpCall('hasLogin', [])).toBe(true);
    expect(host.phpCall('pass', ['contributor', true])).toBe(true);
    expect(host.phpCall('pass', ['editor', true])).toBe(false);
    expect(host.phpCall('pass', ['unknown', true])).toBe(false);
    expect(host.phpGet('authCode')).toBeNull();
    host.phpCall('screenName', []);
    host.phpCall('permalink', []);
    expect(output).toEqual(['&lt;Writer&gt;', 'http://example.com/author/7/']);

    const guest = archive(publicDb().db, 'index').phpGet('user') as PhpHost;
    expect(guest.phpCall('hasLogin', [])).toBe(false);
    expect(guest.phpCall('pass', ['visitor', true])).toBe(false);
  });

  it('uses stored custom template names without adding a second extension', async () => {
    const view = archive(publicDb({ ...published, template: 'custom.php' }).db, 'post', { cid: '12' });
    await view.ensureLoaded();
    expect(view.themeFile).toBe('custom.php');
    const invalid = archive(publicDb({ ...published, template: '../another.php' }).db, 'post', { cid: '12' });
    await invalid.ensureLoaded();
    expect(invalid.themeFile).toBe('');
  });
});
