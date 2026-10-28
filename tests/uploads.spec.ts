import { describe, expect, it } from 'vitest';
import { handleUploadRequest } from '../src/core/uploads';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';

const base = 'https://example.test';
const media = `${base}/admin/manage-medias.php`;
const secret = 'secret';
const authCode = 'abcdef0123456789abcdef0123456789';
const admin = { uid: 1, name: 'admin', group: 'administrator', screenName: 'Admin', password: '', mail: 'a@example.test', authCode };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function fakeServices() {
  const rows = new Map<number, { cid: number; title: string; text: string; authorId: number; parent: number; created: number }>();
  const objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let nextCid = 10;
  const fail = { put: false, putAfterStore: false, bucketDelete: false, insert: false, dbDelete: false };
  let group = 'administrator';
  const d1 = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() {
          statements.push({ sql, params: statement.params });
          if (sql.includes('FROM typecho_users')) return { ...admin, group };
          if (sql.includes("type IN ('post', 'page')")) return Number(statement.params[0]) === 2 ? { cid: 2 } : null;
          if (sql.includes("type = 'attachment'")) return rows.get(Number(statement.params[0])) ?? null;
          if (sql.includes('RETURNING cid')) {
            if (fail.insert) throw new Error('D1 insert failed');
            const cid = nextCid++;
            rows.set(cid, { cid, title: String(statement.params[0]), text: String(statement.params[4]), authorId: Number(statement.params[5]), parent: Number(statement.params[6]), created: Number(statement.params[2]) });
            return { cid };
          }
          return null;
        },
        async all() {
          statements.push({ sql, params: statement.params });
          return { results: [...rows.values()].slice(Number(statement.params[0]), Number(statement.params[0]) + 51) };
        },
        async run() {
          statements.push({ sql, params: statement.params });
          if (fail.dbDelete) throw new Error('D1 delete failed');
          if (sql.startsWith('DELETE FROM typecho_contents')) rows.delete(Number(statement.params[0]));
          return { success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  const bucket = {
    async put(key: string, body: ArrayBuffer | Uint8Array, options?: R2PutOptions) {
      if (fail.put) throw new Error('R2 put failed');
      const metadata = options?.httpMetadata;
      const mime = metadata instanceof Headers ? metadata.get('content-type') ?? '' : metadata?.contentType ?? '';
      objects.set(key, { bytes: new Uint8Array(body).slice(), mime });
      if (fail.putAfterStore) throw new Error('R2 put response failed after storing');
      return { key };
    },
    async get(key: string) {
      const stored = objects.get(key);
      if (!stored) return null;
      return { httpMetadata: { contentType: stored.mime }, async arrayBuffer() { return stored.bytes.slice().buffer; } };
    },
    async delete(key: string) {
      if (fail.bucketDelete) throw new Error('R2 delete failed');
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  return { db: new Db(d1), bucket, rows, objects, statements, fail, setGroup: (value: string) => { group = value; } };
}

function makeRequest(path: string, method = 'GET', body?: FormData | URLSearchParams, auth = cookie, referer = media): Request {
  return new Request(`${base}${path}`, {
    method, headers: { ...(auth ? { cookie: auth } : {}), ...(method === 'POST' ? { origin: base, referer } : {}) }, body,
  });
}

function imageForm(name = 'test.png', bytes: Uint8Array<ArrayBufferLike> = png, mime = 'image/png'): FormData {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], name, { type: mime }));
  return form;
}

async function handle(services: ReturnType<typeof fakeServices>, raw: Request): Promise<Response | null> {
  return handleUploadRequest(services.db, buildRequestContext(raw), secret, services.bucket, raw);
}

async function uploaded(services: ReturnType<typeof fakeServices>): Promise<{ cid: number; key: string }> {
  const token = securityToken(secret, media, admin);
  const response = await handle(services, makeRequest(`/action/upload?_=${token}`, 'POST', imageForm()));
  expect(response?.status).toBe(200);
  const result = await response!.json() as [string, { cid: number }];
  return { cid: result[1].cid, key: new URL(result[0]).pathname.slice('/usr/'.length) };
}

describe('D1 + R2 attachment actions', () => {
  it('requires an authenticated administrator before showing or modifying attachments', async () => {
    const services = fakeServices();
    expect((await handle(services, makeRequest('/admin/manage-medias.php', 'GET', undefined, '')))?.status).toBe(303);
    expect((await handle(services, makeRequest('/action/upload', 'POST', imageForm(), '')))?.status).toBe(303);
    services.setGroup('editor');
    expect((await handle(services, makeRequest('/admin/manage-medias.php')))?.status).toBe(403);
    expect((await handle(services, makeRequest('/action/upload', 'POST', imageForm())))?.status).toBe(403);
    expect(services.objects.size).toBe(0);
  });

  it('returns null for routes it does not own and never changes data on GET', async () => {
    const services = fakeServices();
    expect(await handle(services, makeRequest('/other'))).toBeNull();
    expect((await handle(services, makeRequest('/action/upload')))?.status).toBe(405);
    expect((await handle(services, makeRequest('/action/contents-attachment-edit?do=delete&cid=1')))?.status).toBe(405);
    expect(services.statements.some((item) => item.sql.startsWith('DELETE'))).toBe(false);
  });

  it('rejects missing, wrong and cross-site CSRF credentials', async () => {
    const services = fakeServices();
    const token = securityToken(secret, media, admin);
    expect((await handle(services, makeRequest('/action/upload', 'POST', imageForm())))?.status).toBe(403);
    expect((await handle(services, makeRequest('/action/upload?_=incorrect', 'POST', imageForm())))?.status).toBe(403);
    expect((await handle(services, makeRequest(`/action/upload?_=${token}`, 'POST', imageForm(), cookie, 'https://evil.test/admin/')))?.status).toBe(403);
    expect(services.objects.size).toBe(0);
  });

  it('uploads verified images with random public R2 key and Typecho attachment metadata', async () => {
    const services = fakeServices();
    const token = securityToken(secret, media, admin);
    const response = await handle(services, makeRequest(`/action/upload?_=${token}&cid=2`, 'POST', imageForm('hello.png')));
    expect(response?.status).toBe(200);
    const [url, info] = await response!.json() as [string, { cid: number; title: string; type: string; isImage: boolean; permalink: string }];
    expect(url).toMatch(/^https:\/\/example\.test\/usr\/uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(info).toMatchObject({ cid: 10, title: 'hello.png', type: 'png', isImage: true, permalink: `${base}/attachment/10/` });
    const row = services.rows.get(10)!;
    expect(row).toMatchObject({ title: 'hello.png', authorId: 1, parent: 2 });
    const attachment = JSON.parse(row.text) as { path: string; name: string; type: string; mime: string; size: number };
    expect(attachment).toEqual({ name: 'hello.png', path: new URL(url).pathname, type: 'png', mime: 'image/png', size: png.length });
    expect(services.objects.get(new URL(url).pathname.slice('/usr/'.length))?.mime).toBe('image/png');
  });

  it('rejects executable, forged, empty, oversized, invalid-name and nonexistent-parent uploads', async () => {
    const services = fakeServices();
    const token = securityToken(secret, media, admin);
    const upload = (form: FormData, suffix = '') => handle(services, makeRequest(`/action/upload?_=${token}${suffix}`, 'POST', form));
    expect((await upload(imageForm('index.html', png, 'text/html')))?.status).toBe(415);
    expect((await upload(imageForm('inherited.constructor', png, 'application/octet-stream')))?.status).toBe(415);
    expect((await upload(imageForm('fake.png', new TextEncoder().encode('<svg onload=alert(1)>'))))?.status).toBe(415);
    expect((await upload(imageForm('fake.png', png, 'image/jpeg')))?.status).toBe(415);
    expect((await upload(imageForm('empty.png', new Uint8Array())))?.status).toBe(413);
    expect((await upload(imageForm('bad\u0000.png')))?.status).toBe(400);
    expect((await upload(imageForm('<img onerror=alert(1)>.png')))?.status).toBe(400);
    expect((await upload(imageForm('bad&#60;name.png')))?.status).toBe(400);
    expect((await upload(imageForm('good.png'), '&cid=999'))?.status).toBe(404);
    expect((await upload(imageForm('good.png'), '&cid=1%20OR%201=1'))?.status).toBe(400);
    expect((await upload(imageForm('good.png'), '&do=modify&cid=2'))?.status).toBe(400);
    const big = imageForm('big.png', new Uint8Array(5 * 1024 * 1024 + 1));
    expect((await upload(big))?.status).toBe(413);
    expect(services.objects.size).toBe(0);
    expect(services.rows.size).toBe(0);
  });

  it('enforces a byte cap even without Content-Length', async () => {
    const services = fakeServices();
    const token = securityToken(secret, media, admin);
    const raw = makeRequest(`/action/upload?_=${token}`, 'POST', imageForm('big.png', new Uint8Array(5 * 1024 * 1024 + 64 * 1024)));
    raw.headers.delete('content-length');
    expect((await handle(services, raw))?.status).toBe(413);
    expect(services.rows.size).toBe(0);
  });

  it('cleans up the R2 object if D1 insertion fails, and never inserts metadata if R2 fails', async () => {
    const services = fakeServices();
    const token = securityToken(secret, media, admin);
    services.fail.insert = true;
    expect((await handle(services, makeRequest(`/action/upload?_=${token}`, 'POST', imageForm())))?.status).toBe(500);
    expect(services.objects.size).toBe(0);
    services.fail.insert = false;
    services.fail.put = true;
    expect((await handle(services, makeRequest(`/action/upload?_=${token}`, 'POST', imageForm())))?.status).toBe(500);
    services.fail.put = false;
    services.fail.putAfterStore = true;
    expect((await handle(services, makeRequest(`/action/upload?_=${token}`, 'POST', imageForm())))?.status).toBe(500);
    expect(services.objects.size).toBe(0);
    expect(services.rows.size).toBe(0);
  });

  it('lists escaped file names and only deletes owned storage paths on authorized POST', async () => {
    const services = fakeServices();
    const { cid, key } = await uploaded(services);
    const token = securityToken(secret, media, admin);
    services.rows.get(cid)!.title = '<img src=x onerror=alert(1)>';
    const list = await handle(services, makeRequest('/admin/manage-medias.php'));
    expect(await list?.text()).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect((await handle(services, makeRequest(`/action/contents-attachment-edit?_=${token}`, 'POST', new URLSearchParams({ do: 'delete', cid: String(cid) }), cookie, 'https://evil.test')))?.status).toBe(403);
    expect((await handle(services, makeRequest(`/action/contents-attachment-edit?_=${token}`, 'POST', new URLSearchParams({ do: 'delete', cid: '999' }))))?.status).toBe(404);
    expect(services.objects.has(key)).toBe(true);
    const result = await handle(services, makeRequest(`/action/contents-attachment-edit?_=${token}`, 'POST', new URLSearchParams({ do: 'delete', cid: String(cid) })));
    expect(result?.status).toBe(303);
    expect(services.rows.has(cid)).toBe(false);
    expect(services.objects.has(key)).toBe(false);
  });

  it('preserves the D1 row if R2 deletion fails and restores R2 on D1 deletion failure', async () => {
    const services = fakeServices();
    const { cid, key } = await uploaded(services);
    const token = securityToken(secret, media, admin);
    const remove = () => handle(services, makeRequest(`/action/contents-attachment-edit?_=${token}`, 'POST', new URLSearchParams({ do: 'delete', cid: String(cid) })));
    services.fail.bucketDelete = true;
    expect((await remove())?.status).toBe(500);
    expect(services.rows.has(cid)).toBe(true);
    expect(services.objects.has(key)).toBe(true);
    services.fail.bucketDelete = false;
    services.fail.dbDelete = true;
    expect((await remove())?.status).toBe(500);
    expect(services.rows.has(cid)).toBe(true);
    expect(services.objects.get(key)?.bytes).toEqual(png);
  });

  it('does not delete arbitrary R2 keys from corrupted or legacy attachment data', async () => {
    const services = fakeServices();
    services.rows.set(3, { cid: 3, title: 'legacy', text: JSON.stringify({ name: 'legacy', path: '/usr/uploads/../../secret', size: 1, type: 'png', mime: 'image/png' }), authorId: 1, parent: 0, created: 1 });
    const token = securityToken(secret, media, admin);
    const response = await handle(services, makeRequest(`/action/contents-attachment-edit?_=${token}`, 'POST', new URLSearchParams({ do: 'delete', cid: '3' })));
    expect(response?.status).toBe(409);
    expect(services.rows.has(3)).toBe(true);
  });
});
