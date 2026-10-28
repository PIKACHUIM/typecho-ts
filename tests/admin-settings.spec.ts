import { describe, expect, it } from 'vitest';
import { handleAdminSettingsRequest } from '../src/core/admin-settings';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';

const base = 'https://example.test';
const authCode = '0123456789abcdef0123456789abcdef';
const user = { uid: 1, name: 'admin', group: 'administrator', screenName: 'Admin', password: '', mail: 'a@example.test', authCode };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;

function fakeDb() {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const driver = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() { return sql.includes('FROM typecho_users') ? user : null; },
        async all() { return { results: [{ name: 'title', value: 'Example Site' }] }; },
      };
      return statement;
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>) { writes.push(...statements); return []; },
  } as unknown as D1Database;
  return { db: new Db(driver), writes };
}

describe('site settings', () => {
  it('requires an administrator and shows existing site options', async () => {
    const { db } = fakeDb();
    const path = `${base}/admin/options-general.php`;
    const guest = await handleAdminSettingsRequest(db, buildRequestContext(new Request(path)), 'secret');
    expect(guest?.status).toBe(303);
    const admin = await handleAdminSettingsRequest(db, buildRequestContext(new Request(path, { headers: { cookie } })), 'secret');
    expect(admin?.status).toBe(200);
    expect(await admin?.text()).toContain('Example Site');
  });

  it('validates session CSRF and saves values atomically', async () => {
    const { db, writes } = fakeDb();
    const referer = `${base}/admin/options-general.php`;
    const action = `${base}/action/options-general?_=${securityToken('secret', referer, user)}`;
    const form = new FormData();
    for (const [name, value] of Object.entries({ title: 'Updated', description: 'A blog', siteUrl: base, timezone: '0', pageSize: '10', theme: 'default' })) form.set(name, value);
    const request = (url: string) => buildRequestContext(new Request(url, { method: 'POST', headers: { cookie, origin: base, referer }, body: form }));
    const invalid = await handleAdminSettingsRequest(db, request(`${base}/action/options-general?_=wrong`), 'secret');
    expect(invalid?.status).toBe(403);
    const response = await handleAdminSettingsRequest(db, request(action), 'secret');
    expect(response?.status).toBe(303);
    expect(writes.some(({ params }) => params[0] === 'title' && params[1] === 'Updated')).toBe(true);
  });
});
