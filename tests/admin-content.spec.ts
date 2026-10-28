import { describe, expect, it } from 'vitest';
import { handleAdminContentRequest } from '../src/core/admin-content';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';

const base = 'https://example.test';
const authCode = 'abcdef0123456789abcdef0123456789';
const user = { uid: 1, name: 'admin', group: 'administrator', screenName: 'Admin', password: '', mail: 'a@example.test', authCode };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;

function fakeDb(): { db: Db; statements: Array<{ sql: string; params: unknown[] }> } {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const d1 = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() {
          if (sql.includes('FROM typecho_users')) return user;
          if (sql.includes('RETURNING cid')) return { cid: 3 };
          if (sql.includes('SELECT mid FROM typecho_metas')) return { mid: 1 };
          return null;
        },
        async all() { return { results: [] }; },
        async run() { statements.push({ sql, params: statement.params }); return { success: true }; },
      };
      return statement;
    },
    async batch(entries: Array<{ sql: string; params: unknown[] }>) {
      statements.push(...entries.map((entry) => ({ sql: entry.sql, params: entry.params })));
      return [];
    },
  } as unknown as D1Database;
  return { db: new Db(d1), statements };
}

describe('content administration', () => {
  it('requires authentication for list and edit pages', async () => {
    const { db } = fakeDb();
    const request = buildRequestContext(new Request(`${base}/admin/manage-posts.php`));
    const response = await handleAdminContentRequest(db, request, 'secret');
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toContain('/admin/login.php');
  });

  it('renders the editor and accepts a valid administrator create request', async () => {
    const { db } = fakeDb();
    const editor = `${base}/admin/write-post.php`;
    const get = await handleAdminContentRequest(db, buildRequestContext(new Request(editor, { headers: { cookie } })), 'secret');
    expect(get?.status).toBe(200);
    expect(await get?.text()).toContain('保存文章');

    const form = new FormData();
    form.set('cid', '0');
    form.set('title', 'My first post');
    form.set('slug', 'first-post');
    form.set('text', '<!--markdown-->Hello');
    form.set('status', 'publish');
    form.set('allowComment', '1');
    const post = new Request(`${base}/action/contents-post-edit?_=${securityToken('secret', editor, user)}`, {
      method: 'POST', headers: { cookie, origin: base, referer: editor }, body: form,
    });
    const response = await handleAdminContentRequest(db, buildRequestContext(post), 'secret');
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toContain('/admin/write-post.php?cid=3');
  });

  it('rejects a write without a matching CSRF token', async () => {
    const { db } = fakeDb();
    const post = new Request(`${base}/action/contents-post-edit?_=incorrect`, {
      method: 'POST', headers: { cookie, origin: base, referer: `${base}/admin/write-post.php` }, body: new FormData(),
    });
    const response = await handleAdminContentRequest(db, buildRequestContext(post), 'secret');
    expect(response?.status).toBe(403);
  });
});
