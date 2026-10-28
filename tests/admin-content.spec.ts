import { describe, expect, it } from 'vitest';
import { handleAdminContentRequest } from '../src/core/admin-content';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';

const base = 'https://example.test';
const authCode = 'abcdef0123456789abcdef0123456789';
const user = { uid: 1, name: 'admin', group: 'administrator', screenName: 'Admin', password: '', mail: 'a@example.test', authCode };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;

type Meta = { mid: number; name: string; type: string; count: number };
function fakeDb(config: { existing?: boolean; relationships?: Array<[number, number]>; defaultCategory?: string } = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const metas: Meta[] = [
    { mid: 1, name: '技术', type: 'category', count: 0 },
    { mid: 2, name: '生活', type: 'category', count: 0 },
    { mid: 7, name: '<测试>', type: 'tag', count: 0 },
    { mid: 8, name: '公告', type: 'tag', count: 0 },
    { mid: 99, name: '其他元数据', type: 'custom', count: 0 },
  ];
  const relationships = new Set((config.relationships ?? []).map(([cid, mid]) => `${cid}:${mid}`));
  const contents = new Map<number, { cid: number; type: string; title: string; slug: string; text: string; status: string; allowComment: string }>();
  if (config.existing) contents.set(3, { cid: 3, type: 'post', title: '原文章', slug: 'original', text: '正文', status: 'publish', allowComment: '1' });
  for (const meta of metas) meta.count = [...relationships].filter((link) => link.endsWith(`:${meta.mid}`)).length;
  const d1 = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() {
          if (sql.includes('FROM typecho_users')) return user;
          if (sql.includes('FROM typecho_options')) return { value: config.defaultCategory ?? '2' };
          if (sql.includes('FROM typecho_contents WHERE cid = ? AND type = ?')) {
            const content = contents.get(Number(statement.params[0]));
            return content?.type === statement.params[1] ? content : null;
          }
          return null;
        },
        async all() {
          if (sql.includes('FROM typecho_metas')) return { results: metas.filter((meta) => meta.type === 'category' || meta.type === 'tag') };
          if (sql.includes('FROM typecho_relationships') && sql.includes('JOIN typecho_metas')) {
            return { results: [...relationships].filter((link) => link.startsWith(`${statement.params[0]}:`))
              .map((link) => ({ mid: Number(link.split(':')[1]) })).filter(({ mid }) => metas.some((meta) => meta.mid === mid && (meta.type === 'category' || meta.type === 'tag'))) };
          }
          if (sql.includes('FROM typecho_relationships')) return { results: [...relationships].filter((link) => link.startsWith(`${statement.params[0]}:`)).map((link) => ({ mid: Number(link.split(':')[1]) })) };
          return { results: [] };
        },
        async run() {
          const params = statement.params;
          statements.push({ sql, params });
          if (sql.startsWith('INSERT INTO typecho_contents')) {
            contents.set(3, { cid: 3, type: String(params[6]), title: String(params[0]), slug: String(params[1]), text: String(params[4]), status: String(params[7]), allowComment: String(params[8]) });
          } else if (sql.startsWith('INSERT INTO typecho_relationships')) {
            const cid = sql.includes('SELECT cid') ? 3 : Number(params[0]);
            const mid = Number(sql.includes('SELECT cid') ? params[0] : params[1]);
            relationships.add(`${cid}:${mid}`);
          } else if (sql.startsWith('DELETE FROM typecho_relationships')) {
            if (params.length === 2) relationships.delete(`${params[0]}:${params[1]}`);
            else for (const link of [...relationships]) if (link.startsWith(`${params[0]}:`)) relationships.delete(link);
          } else if (sql.startsWith('UPDATE typecho_metas SET count')) {
            const meta = metas.find((item) => item.mid === params[1]);
            if (meta) meta.count = [...relationships].filter((link) => link.endsWith(`:${meta.mid}`)).length;
          } else if (sql.startsWith('DELETE FROM typecho_contents')) {
            contents.delete(Number(params[0]));
          }
          return { success: true, results: [], meta: { last_row_id: 3 } };
        },
      };
      return statement;
    },
    async batch(entries: Array<{ run(): Promise<unknown> }>) {
      const results = [];
      for (const entry of entries) results.push(await entry.run());
      return results;
    },
  } as unknown as D1Database;
  return { db: new Db(d1), statements, metas, relationships, contents };
}

function formFor(cid = 0, type: 'post' | 'page' = 'post'): FormData {
  const form = new FormData();
  form.set('cid', String(cid));
  form.set('title', 'My first post');
  form.set('slug', `${type}-${cid}`);
  form.set('text', '<!--markdown-->Hello');
  form.set('status', 'publish');
  form.set('allowComment', '1');
  return form;
}

async function submit(db: Db, form: FormData, type: 'post' | 'page' = 'post', action: 'edit' | 'delete' = 'edit') {
  const editor = `${base}/admin/write-${type}.php`;
  const referer = action === 'delete' ? `${base}/admin/manage-${type === 'post' ? 'posts' : 'pages'}.php` : editor;
  const post = new Request(`${base}/action/contents-${type}-${action}?_=${securityToken('secret', referer, user)}`, {
    method: 'POST', headers: { cookie, origin: base, referer }, body: form,
  });
  return handleAdminContentRequest(db, buildRequestContext(post), 'secret');
}

describe('content administration', () => {
  it('requires authentication for list and edit pages', async () => {
    const { db } = fakeDb();
    const response = await handleAdminContentRequest(db, buildRequestContext(new Request(`${base}/admin/manage-posts.php`)), 'secret');
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toContain('/admin/login.php');
  });

  it('shows existing categories and tags, marks the configured default, and saves chosen relationships', async () => {
    const { db, metas, relationships } = fakeDb();
    const get = await handleAdminContentRequest(db, buildRequestContext(new Request(`${base}/admin/write-post.php`, { headers: { cookie } })), 'secret');
    expect(get?.status).toBe(200);
    const html = await get?.text();
    expect(html).toContain('name="category[]" value="2" checked');
    expect(html).toContain('生活（默认分类）');
    expect(html).toContain('name="tags[]" value="7"');
    expect(html).toContain('&lt;测试&gt;');
    expect(html).not.toContain('<测试>');

    const form = formFor();
    form.append('category[]', '1');
    form.append('category[]', '2');
    form.append('tags[]', '7');
    form.append('tags[]', '7');
    const response = await submit(db, form);
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toContain('/admin/write-post.php?cid=3');
    expect([...relationships].sort()).toEqual(['3:1', '3:2', '3:7']);
    expect(metas.map((meta) => meta.count)).toEqual([1, 1, 1, 0, 0]);
  });

  it('uses the valid default category when no category is selected, never a wrong-type or deleted option', async () => {
    const fixture = fakeDb({ defaultCategory: '7' });
    expect((await submit(fixture.db, formFor()))?.status).toBe(303);
    expect([...fixture.relationships]).toEqual(['3:1']);
    expect(fixture.metas[0].count).toBe(1);
  });

  it('edits only changed post taxonomies and preserves unrelated relationships', async () => {
    const fixture = fakeDb({ existing: true, relationships: [[3, 1], [3, 7], [3, 99], [4, 1], [4, 7]] });
    const editor = await handleAdminContentRequest(fixture.db, buildRequestContext(new Request(`${base}/admin/write-post.php?cid=3`, { headers: { cookie } })), 'secret');
    const html = await editor?.text();
    expect(html).toContain('name="category[]" value="1" checked');
    expect(html).toContain('name="tags[]" value="7" checked');
    expect(html).not.toContain('name="category[]" value="2" checked');

    const form = formFor(3);
    form.append('category[]', '2');
    form.append('tags[]', '7');
    form.append('tags[]', '8');
    expect((await submit(fixture.db, form))?.status).toBe(303);
    expect([...fixture.relationships].sort()).toEqual(['3:2', '3:7', '3:8', '3:99', '4:1', '4:7']);
    expect(fixture.metas.map((meta) => meta.count)).toEqual([1, 1, 2, 1, 1]);
    expect((await submit(fixture.db, form))?.status).toBe(303);
    expect(fixture.metas.map((meta) => meta.count)).toEqual([1, 1, 2, 1, 1]);
  });

  it('rejects malformed, nonexistent, or wrong-type metadata before writing', async () => {
    const { db, statements } = fakeDb({ existing: true });
    for (const [name, value] of [['category[]', 'abc'], ['category[]', '7'], ['tags[]', '2'], ['tags[]', '1000'], ['tags[]', '9007199254740992']]) {
      const form = formFor(3);
      form.append(name, value);
      expect((await submit(db, form))?.status).toBe(400);
    }
    expect(statements).toEqual([]);
  });

  it('deletes just the chosen content and recounts affected metadata', async () => {
    const fixture = fakeDb({ existing: true, relationships: [[3, 1], [3, 7], [3, 99], [4, 1], [4, 7]] });
    const form = new FormData();
    form.set('cid', '3');
    expect((await submit(fixture.db, form, 'post', 'delete'))?.status).toBe(303);
    expect([...fixture.relationships].sort()).toEqual(['4:1', '4:7']);
    expect(fixture.metas.map((meta) => meta.count)).toEqual([1, 0, 1, 0, 0]);
    expect(fixture.contents.has(3)).toBe(false);
    expect(fixture.statements.filter(({ sql }) => sql.startsWith('DELETE FROM typecho_')).every(({ params }) => params[0] === 3)).toBe(true);
  });

  it('keeps page editing independent from post taxonomies', async () => {
    const { db, relationships } = fakeDb();
    const page = await handleAdminContentRequest(db, buildRequestContext(new Request(`${base}/admin/write-page.php`, { headers: { cookie } })), 'secret');
    expect(await page?.text()).not.toContain('category[]');
    expect((await submit(db, formFor(0, 'page'), 'page'))?.status).toBe(303);
    expect(relationships.size).toBe(0);
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
