import { describe, expect, it } from 'vitest';
import { compare } from 'bcryptjs';
import { Db } from '../src/core/db';
import { isInstallationComplete, renderInstaller } from '../src/core/install-auth';
import { buildRequestContext } from '../src/core/request';
import { Router } from '../src/core/router';

type Statement = { sql: string; params: unknown[] };
type SiteTable = 'users' | 'options' | 'contents' | 'metas' | 'comments' | 'relationships' | 'fields';

function mockDb(seed: Partial<Record<SiteTable, number>> = {}) {
  const counts: Record<SiteTable, number> = {
    users: 0, options: 0, contents: 0, metas: 0, comments: 0, relationships: 0, fields: 0, ...seed,
  };
  const batches: Statement[][] = [];
  const d1 = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params;
          return statement;
        },
        async first() {
          if (sql.includes(' AS occupied')) return { occupied: Number(Object.values(counts).some(Boolean)) };
          if (sql.includes('WHERE name = \'installed\'')) return counts.options ? { value: '1' } : null;
          if (sql.includes('"group" = \'administrator\'')) return counts.users ? { uid: 1 } : null;
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { success: true, meta: {} }; },
      };
      return statement;
    },
    async batch(statements: Statement[]) {
      if (Object.values(counts).some(Boolean)) throw new Error('UNIQUE constraint failed: typecho_users.uid');
      batches.push(statements.map(({ sql, params }) => ({ sql, params })));
      for (const { sql } of statements) {
        const table = /INSERT INTO typecho_(users|options|contents|metas|comments|relationships|fields)/.exec(sql)?.[1] as SiteTable | undefined;
        if (table) counts[table]++;
      }
      return [];
    },
  } as unknown as D1Database;
  return { db: new Db(d1), batches, counts };
}

function installForm(token: string, locale = 'zh-CN', overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries({
    _: token, locale, title: 'Example Site', description: 'A test blog', siteUrl: 'https://example.test',
    name: 'owner', screenName: 'Site Owner', mail: 'owner@example.test',
    password: 'secure-pass-123', confirm: 'secure-pass-123', timezone: '28800', ...overrides,
  })) form.set(name, value);
  return form;
}

function installPost(token: string, cookie = token, origin = 'https://example.test', locale = 'zh-CN', overrides: Record<string, string> = {}): Request {
  return new Request(`https://example.test/install.php?lang=${locale}`, {
    method: 'POST',
    headers: {
      cookie: `typecho_install_token=${cookie}`,
      origin,
      referer: 'https://example.test/install.php',
    },
    body: installForm(token, locale, overrides),
  });
}

describe('first-run installer', () => {
  it('renders setup for an empty database and commits a complete initial site', async () => {
    const { db, batches } = mockDb();
    const page = await renderInstaller(db, buildRequestContext(new Request('https://example.test/')));
    const html = await page.text();
    const token = /name="_" value="([^"]+)"/.exec(html)?.[1];
    const cookie = /typecho_install_token=([^;]+)/.exec(page.headers.get('set-cookie') ?? '')?.[1];

    expect(page.status).toBe(200);
    expect(html).toContain('管理员用户名');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(cookie).toBe(token);
    expect(page.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict; Secure');

    const installed = await renderInstaller(db, buildRequestContext(installPost(token!)));
    expect(installed.status).toBe(303);
    expect(installed.headers.get('location')).toBe('https://example.test/admin/login.php?installed=1');
    expect(installed.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await isInstallationComplete(db)).toBe(true);
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    const userInsert = batch.find(({ sql }) => sql.includes('INSERT INTO typecho_users'));
    const optionsInsert = batch.filter(({ sql }) => sql.includes('INSERT INTO typecho_options'));
    expect(userInsert?.params[0]).toBe('owner');
    expect(await compare('secure-pass-123', String(userInsert?.params[1]))).toBe(true);
    expect(optionsInsert.some(({ params }) => params[0] === 'title' && params[1] === 'Example Site')).toBe(true);
    expect(optionsInsert.some(({ params }) => params[0] === 'adminLocale' && params[1] === 'zh-CN')).toBe(true);
    expect(optionsInsert.some(({ params }) => params[0] === 'defaultCategory' && params[1] === '1')).toBe(true);
    expect(optionsInsert.some(({ params }) => params[0] === 'installed' && params[1] === '1')).toBe(true);
    expect(optionsInsert.some(({ params }) => params[0] === 'phpPluginHooks' && params[1] === '[]')).toBe(true);
    const routes = JSON.parse(String(optionsInsert.find(({ params }) => params[0] === 'routingTable')?.params[1]));
    const router = Router.from(routes);
    expect(router.routes).toHaveLength(25);
    expect(routes.feed.url).toBe('/feed[feed:string:0]');
    expect(router.match('/search/hello/page/2/')?.route.name).toBe('search_page');
    expect(router.match('/search/hello/')?.route.name).toBe('search');
    expect(router.match('/archives/1/comment-page-2')?.route.name).toBe('comment_page');
    expect(router.match('/feed/rss/')?.route.name).toBe('feed');
  });

  it('renders the selected language and falls back to Chinese for unsupported locales', async () => {
    const { db } = mockDb();
    const english = await renderInstaller(db, buildRequestContext(new Request('https://example.test/install.php?lang=en-US')));
    const englishHtml = await english.text();
    expect(englishHtml).toContain('<html lang="en-US"');
    expect(englishHtml).toContain('Get started');
    expect(englishHtml).toContain('Administrator username');
    expect(englishHtml).toContain('action="https://example.test/install.php?lang=en-US"');
    expect(englishHtml).toContain('name="locale" value="en-US"');
    expect(englishHtml).toContain('href="https://example.test/install.php?lang=zh-CN"');
    expect(englishHtml).toContain('href="https://example.test/install.php?lang=en-US"');

    const unsupported = await renderInstaller(db, buildRequestContext(new Request('https://example.test/install.php?lang=fr')));
    const unsupportedHtml = await unsupported.text();
    expect(unsupportedHtml).toContain('<html lang="zh-CN"');
    expect(unsupportedHtml).toContain('action="https://example.test/install.php?lang=zh-CN"');
  });

  it('preserves the selected locale and non-password fields after validation fails', async () => {
    const { db } = mockDb();
    const token = 'c'.repeat(64);
    const response = await renderInstaller(db, buildRequestContext(installPost(token, token, 'https://example.test', 'en-US', {
      title: 'Retained <title>', description: 'Retained description', siteUrl: 'https://saved.example.test',
      name: 'saved_owner', screenName: 'Saved Owner', mail: 'invalid-email', timezone: '3600',
    })));
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain('<html lang="en-US"');
    expect(html).toContain('Enter a valid email address.');
    expect(html).toContain('action="https://example.test/install.php?lang=en-US"');
    expect(html).toContain('value="Retained &lt;title&gt;"');
    expect(html).toContain('value="Retained description"');
    expect(html).toContain('value="https://saved.example.test"');
    expect(html).toContain('value="saved_owner"');
    expect(html).toContain('value="Saved Owner"');
    expect(html).toContain('value="invalid-email"');
    expect(html).toContain('value="3600"');
    expect(html).not.toContain('secure-pass-123');
    expect(html).not.toContain('name="password" value=');
  });

  it('persists the submitted English preference without exposing credentials in the redirect', async () => {
    const { db, batches } = mockDb();
    const token = 'd'.repeat(64);
    const response = await renderInstaller(db, buildRequestContext(installPost(token, token, 'https://example.test', 'en-US')));
    const options = batches[0].filter(({ sql }) => sql.includes('INSERT INTO typecho_options'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://example.test/admin/login.php?installed=1');
    expect(response.headers.get('location')).not.toContain('secure-pass-123');
    expect(options.some(({ params }) => params[0] === 'adminLocale' && params[1] === 'en-US')).toBe(true);
  });

  it.each(['users', 'options', 'contents', 'metas', 'comments', 'relationships', 'fields'] as SiteTable[])(
    'refuses setup when %s contains existing data', async (table) => {
      const { db, batches } = mockDb({ [table]: 1 });
      const response = await renderInstaller(db, buildRequestContext(new Request('https://example.test/install.php')));
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('已存在数据');
      expect(batches).toHaveLength(0);
    }
  );

  it('rejects requests with missing CSRF cookie or a foreign origin', async () => {
    const { db, batches } = mockDb();
    const token = 'a'.repeat(64);
    const missingCookie = await renderInstaller(db, buildRequestContext(installPost(token, '')));
    expect(missingCookie.status).toBe(403);
    const foreignOrigin = await renderInstaller(db, buildRequestContext(installPost(token, token, 'https://other.test')));
    expect(foreignOrigin.status).toBe(403);
    expect(batches).toHaveLength(0);
  });

  it('does not write data if another installer committed after the setup page was opened', async () => {
    const { db, batches } = mockDb();
    const token = 'b'.repeat(64);
    const responses = await Promise.all([
      renderInstaller(db, buildRequestContext(installPost(token))),
      renderInstaller(db, buildRequestContext(installPost(token))),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([303, 409]);
    expect(batches).toHaveLength(1);
  });
});
