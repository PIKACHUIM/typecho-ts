import { describe, expect, it } from 'vitest';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { handleAdminRoutingRequest } from '../src/core/admin-routing';
import { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';

const base = 'https://example.test';
const secret = 'routing-secret';
const authCode = '0123456789abcdef0123456789abcdef';
const admin = { uid: 1, name: 'admin', group: 'administrator', screenName: 'Admin', password: '', mail: 'admin@example.test', authCode };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;

function fakeDb(rewrite = '1') {
  let current = rewrite;
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const driver = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() {
          if (sql.includes('FROM typecho_users')) return admin;
          if (sql.includes("name = 'rewrite'")) return { value: current };
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          writes.push({ sql, params: statement.params });
          current = String(statement.params[1]);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db: new Db(driver), writes, value: () => current };
}

function postForm(value: boolean): Request {
  const referer = `${base}/admin/options-routing.php`;
  const token = securityToken(secret, referer, admin);
  const form = new FormData();
  if (value) form.set('rewrite', '1');
  return new Request(`${base}/action/options-routing?_=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { cookie, origin: base, referer }, body: form,
  });
}

describe('admin permalink settings', () => {
  it('shows current rewrite mode and both URL examples', async () => {
    const services = fakeDb('1');
    const request = buildRequestContext(new Request(`${base}/admin/options-routing.php`, { headers: { cookie } }));
    const response = await handleAdminRoutingRequest(services.db, request, secret);
    const html = await response?.text();
    expect(response?.status).toBe(200);
    expect(html).toContain('name="rewrite" value="1" checked');
    expect(html).toContain(`${base}/archives/1/`);
    expect(html).toContain(`${base}/index.php/archives/1/`);
  });

  it.each([{ enabled: true, expected: '1' }, { enabled: false, expected: '0' }])(
    'saves rewrite mode $enabled', async ({ enabled, expected }) => {
      const services = fakeDb();
      const request = buildRequestContext(postForm(enabled));
      const response = await handleAdminRoutingRequest(services.db, request, secret);
      expect(response?.status).toBe(303);
      expect(services.value()).toBe(expected);
      expect(services.writes[0]?.params).toEqual(['rewrite', expected]);
    }
  );

  it('rejects invalid CSRF tokens without modifying rewrite', async () => {
    const services = fakeDb('1');
    const raw = new Request(`${base}/action/options-routing?_=invalid`, {
      method: 'POST', headers: { cookie, origin: base, referer: `${base}/admin/options-routing.php` },
      body: new URLSearchParams({ rewrite: '0' }),
    });
    const response = await handleAdminRoutingRequest(services.db, buildRequestContext(raw), secret);
    expect(response?.status).toBe(403);
    expect(services.value()).toBe('1');
    expect(services.writes).toHaveLength(0);
  });
});
