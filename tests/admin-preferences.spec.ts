import { describe, expect, it } from 'vitest';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { handleAdminPreferencesRequest } from '../src/core/admin-preferences';
import { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';

const base = 'https://example.test';
const user = { uid: 1, authCode: '0123456789abcdef0123456789abcdef', name: 'admin', password: '', mail: 'owner@example.test', screenName: 'Owner', group: 'administrator' };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(user.authCode, 'abcdef123'))}`;

function fakeDb() {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const d1 = {
    prepare(sql: string) {
      const statement = {
        sql, params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() { return sql.includes('FROM typecho_users') ? user : null; },
        async all() { return { results: sql.includes('FROM typecho_options') ? [{ name: 'commentsRequireModeration', value: '1' }] : [] }; },
      };
      return statement;
    },
    async batch(prepared: Array<{ sql: string; params: unknown[] }>) { writes.push(...prepared); return []; },
  } as unknown as D1Database;
  return { db: new Db(d1), writes };
}

describe('reading and discussion settings', () => {
  it('requires admin session and renders comment moderation options', async () => {
    const { db } = fakeDb();
    const path = `${base}/admin/options-discussion.php`;
    expect((await handleAdminPreferencesRequest(db, buildRequestContext(new Request(path)), 'secret'))?.status).toBe(303);
    const response = await handleAdminPreferencesRequest(db, buildRequestContext(new Request(path, { headers: { cookie } })), 'secret');
    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain('评论需经审核');
  });

  it('saves reading settings with a session-bound token and validates limits', async () => {
    const { db, writes } = fakeDb();
    const referer = `${base}/admin/options-reading.php`;
    const action = `${base}/action/options-reading?_=${securityToken('secret', referer, user)}`;
    const submit = (size: string) => {
      const form = new URLSearchParams({ pageSize: size, postsListSize: '5', commentsListSize: '5', frontPage: 'recent' });
      return buildRequestContext(new Request(action, { method: 'POST', headers: { cookie, referer, origin: base }, body: form }));
    };
    expect((await handleAdminPreferencesRequest(db, submit('0'), 'secret'))?.status).toBe(400);
    expect((await handleAdminPreferencesRequest(db, submit('10'), 'secret'))?.status).toBe(303);
    expect(writes.some(({ params }) => params[0] === 'pageSize' && params[1] === '10')).toBe(true);
    const csrf = await handleAdminPreferencesRequest(db, buildRequestContext(new Request(`${base}/action/options-reading?_=wrong`, {
      method: 'POST', headers: { cookie, referer, origin: base }, body: new URLSearchParams({ pageSize: '10' }),
    })), 'secret');
    expect(csrf?.status).toBe(403);
  });
});
