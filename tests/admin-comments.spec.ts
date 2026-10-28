import { describe, expect, it } from 'vitest';
import { handleAdminCommentsRequest } from '../src/core/admin-comments';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';

const base = 'https://example.test';
const list = `${base}/admin/manage-comments.php`;
const authCode = 'abcdef0123456789abcdef0123456789';
const user = { uid: 1, name: 'admin', group: 'administrator', screenName: 'Admin', password: '', mail: 'admin@example.test', authCode };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;

interface Comment { coid: number; cid: number; created: number; author: string; mail: string; text: string; type: string; status: string; title: string }
function comment(coid: number, cid: number, status: string, type = 'comment'): Comment {
  return { coid, cid, created: 1000 + coid, author: 'Someone', mail: 'user@example.test', text: 'Hello', type, status, title: 'Post' };
}

function fakeDb(rows: Comment[] = [comment(1, 12, 'approved'), comment(2, 12, 'waiting'), comment(3, 19, 'approved')]) {
  const comments = new Map(rows.map((row) => [row.coid, { ...row }]));
  const counts = new Map<number, number>([...new Set(rows.map(({ cid }) => cid))].map((cid) => [cid, rows.filter((row) => row.cid === cid && row.type === 'comment' && row.status === 'approved').length]));
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let account = { ...user };
  const d1 = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() {
          statements.push({ sql, params: statement.params });
          if (sql.includes('FROM typecho_users')) return account;
          if (sql.includes('FROM typecho_comments')) return comments.get(Number(statement.params[0])) ?? null;
          return null;
        },
        async all() {
          statements.push({ sql, params: statement.params });
          const [status, limit, offset] = statement.params as [string, number, number];
          return { results: [...comments.values()].filter((row) => row.status === status).sort((a, b) => b.coid - a.coid).slice(offset, offset + limit) };
        },
      };
      return statement;
    },
    async batch(entries: Array<{ sql: string; params: unknown[] }>) {
      for (const { sql, params } of entries) {
        statements.push({ sql, params });
        if (sql.startsWith('UPDATE typecho_comments')) {
          const row = comments.get(Number(params[1]));
          if (row) row.status = String(params[0]);
        } else if (sql.startsWith('DELETE FROM typecho_comments')) {
          comments.delete(Number(params[0]));
        } else if (sql.startsWith('UPDATE typecho_contents SET commentsNum')) {
          const cid = Number(params[0]);
          counts.set(cid, [...comments.values()].filter((row) => row.cid === cid && row.type === 'comment' && row.status === 'approved').length);
        }
      }
      return entries.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
  return { db: new Db(d1), comments, counts, statements, changeGroup(group: string) { account = { ...account, group }; } };
}

function get(url = list, authorized = true) {
  return buildRequestContext(new Request(url, { headers: authorized ? { cookie } : {} }));
}

function post(action: string, ids: string[] = ['1'], referer = list, token = securityToken('secret', referer, user), headers: Record<string, string> = {}) {
  const body = new FormData();
  for (const id of ids) body.append(ids.length > 1 ? 'coid[]' : 'coid', id);
  return buildRequestContext(new Request(`${base}/action/comments-edit?do=${action}&_=${token}`, {
    method: 'POST', headers: { cookie, origin: base, referer, ...headers }, body,
  }));
}

async function handle(db: Db, request: ReturnType<typeof get>) {
  return handleAdminCommentsRequest(db, request, 'secret');
}

describe('comment administration', () => {
  it('routes only comment management paths and requires an administrator', async () => {
    const state = fakeDb();
    expect(await handle(state.db, get(`${base}/admin/manage-posts.php`))).toBeNull();
    const unauthenticated = await handle(state.db, get(list, false));
    expect(unauthenticated?.status).toBe(303);
    expect(unauthenticated?.headers.get('location')).toContain('/admin/login.php?referer=');
    state.changeGroup('subscriber');
    expect((await handle(state.db, get()))?.status).toBe(403);
    expect((await handle(state.db, post('delete')))?.status).toBe(403);
    expect(state.counts.get(12)).toBe(1);
  });

  it('lists escaped comments, status tabs and PHP-compatible form actions', async () => {
    const state = fakeDb([comment(1, 12, 'approved'), { ...comment(2, 12, 'waiting'), author: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script>', title: 'A < B' }]);
    const response = await handle(state.db, get(`${list}?status=waiting`));
    expect(response?.status).toBe(200);
    const html = await response!.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A &lt; B');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('/action/comments-edit?do=approved&amp;_=');
    expect(html).toContain('name="coid" value="2"');
    expect(html).not.toContain('name="coid" value="1"');
    expect(state.statements.find(({ sql }) => sql.includes('ORDER BY c.coid DESC'))?.params).toEqual(['waiting', 21, 0]);
  });

  it('paginates approved comments and rejects invalid filters without a query', async () => {
    const state = fakeDb(Array.from({ length: 43 }, (_, i) => comment(i + 1, 12, 'approved')));
    const response = await handle(state.db, get());
    expect(await response?.text()).toContain('status=approved&amp;page=2');
    await handle(state.db, get(`${list}?status=approved&page=2`));
    expect(state.statements.filter(({ sql }) => sql.includes('ORDER BY c.coid DESC')).at(-1)?.params).toEqual(['approved', 21, 20]);
    const before = state.statements.length;
    for (const url of [`${list}?status=private`, `${list}?page=0`, `${list}?page=1.5`, `${list}?page=10001`]) {
      expect((await handle(state.db, get(url)))?.status).toBe(400);
    }
    expect(state.statements.length).toBe(before + 4);
  });

  it('approves waiting and restores a spam comment, keeping exact approved count', async () => {
    const state = fakeDb([comment(1, 12, 'waiting'), comment(2, 12, 'spam'), comment(3, 12, 'approved'), comment(4, 12, 'approved', 'pingback')]);
    const response = await handle(state.db, post('approved', ['1', '2']));
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toContain('status=approved');
    expect(state.comments.get(1)?.status).toBe('approved');
    expect(state.comments.get(2)?.status).toBe('approved');
    expect(state.counts.get(12)).toBe(3);
    expect(state.statements.filter(({ sql }) => sql.includes('UPDATE typecho_contents SET commentsNum'))).toHaveLength(1);
    expect(state.statements.find(({ sql }) => sql.includes('UPDATE typecho_contents SET commentsNum'))?.params).toEqual([12, 12]);
  });

  it('accepts the PHP single-comment coid query parameter with a valid token', async () => {
    const state = fakeDb();
    const request = buildRequestContext(new Request(`${base}/action/comments-edit?do=waiting&coid=1&_=${securityToken('secret', list, user)}`, {
      method: 'POST', headers: { cookie, origin: base, referer: list }, body: new FormData(),
    }));
    expect((await handle(state.db, request))?.status).toBe(303);
    expect(state.comments.get(1)?.status).toBe('waiting');
    expect(state.counts.get(12)).toBe(0);
  });

  it('moves approved comments to waiting/spam and deletes idempotently across content IDs', async () => {
    const state = fakeDb();
    expect((await handle(state.db, post('waiting', ['1'])))?.status).toBe(303);
    expect(state.counts.get(12)).toBe(0);
    expect((await handle(state.db, post('spam', ['3'])))?.status).toBe(303);
    expect(state.counts.get(19)).toBe(0);
    expect((await handle(state.db, post('delete', ['1', '2', '3'])))?.status).toBe(303);
    expect(state.comments.size).toBe(0);
    expect(state.counts.get(12)).toBe(0);
    expect(state.counts.get(19)).toBe(0);
    expect((await handle(state.db, post('delete', ['1'])))?.status).toBe(404);
  });

  it('rejects forged forms, cross-origin referrers and wrong methods without updates', async () => {
    const state = fakeDb();
    expect((await handle(state.db, post('delete', ['1'], list, 'wrong')))?.status).toBe(403);
    expect((await handle(state.db, post('delete', ['1'], 'https://evil.test/admin/manage-comments.php')))?.status).toBe(403);
    expect((await handle(state.db, post('delete', ['1'], '')))?.status).toBe(403);
    expect((await handle(state.db, post('delete', ['1'], list, undefined, { origin: 'https://evil.test' })))?.status).toBe(403);
    expect((await handle(state.db, get(`${base}/action/comments-edit?do=delete`)))?.status).toBe(405);
    expect((await handle(state.db, get(`${base}/admin/manage-comments.php`, true)))?.status).toBe(200);
    expect(state.statements.every(({ sql }) => !sql.includes('DELETE FROM typecho_comments'))).toBe(true);
  });

  it('rejects unknown actions, malformed IDs and nonexistent batch members atomically', async () => {
    const state = fakeDb();
    expect((await handle(state.db, post('reply')))?.status).toBe(400);
    for (const ids of [[], ['-1'], ['1', '2.5'], ['9007199254740992'], Array.from({ length: 51 }, () => '1')]) {
      expect((await handle(state.db, post('approved', ids)))?.status).toBe(400);
    }
    expect((await handle(state.db, post('delete', ['1', '999'])))?.status).toBe(404);
    expect(state.comments.size).toBe(3);
    expect(state.statements.every(({ sql }) => !sql.startsWith('DELETE FROM typecho_comments'))).toBe(true);
  });
});
