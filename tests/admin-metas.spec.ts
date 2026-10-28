import { describe, expect, it } from 'vitest';
import { handleAdminMetasRequest } from '../src/core/admin-metas';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';

const base = 'https://example.test';
const secret = 'test-secret';
const authCode = 'abcdef0123456789abcdef0123456789';
const admin = { uid: 1, name: 'admin', group: 'administrator', screenName: 'Admin', password: '', mail: 'admin@example.test', authCode };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;

type Meta = { mid: number; name: string; slug: string; type: 'category' | 'tag'; description: string; count: number; order: number; parent: number };
const category = (mid: number, name: string, slug: string, parent = 0): Meta => ({ mid, name, slug, type: 'category', description: '', count: 0, order: mid, parent });
const tag = (mid: number, name: string, slug: string): Meta => ({ mid, name, slug, type: 'tag', description: '', count: 0, order: 0, parent: 0 });

function fakeDb(initial: Meta[] = [category(1, '默认', 'default'), category(2, '新闻', 'news'), category(3, '地方', 'local', 2), tag(4, '专题', 'feature')], defaultId: number | null = 1, group = 'administrator') {
  const rows = initial.map((row) => ({ ...row }));
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const relationships = [{ cid: 11, mid: 2 }, { cid: 12, mid: 3 }, { cid: 11, mid: 4 }];
  let selectedDefault = defaultId;
  const d1 = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) { params = values; return stmt; },
        async first() {
          if (sql.includes('FROM typecho_users')) return { ...admin, group };
          if (sql.includes('FROM typecho_options')) return selectedDefault === null ? null : { value: String(selectedDefault) };
          if (sql.includes('ORDER BY mid LIMIT 1')) return rows.filter((r) => r.type === 'category').sort((a, b) => a.mid - b.mid)[0] ?? null;
          if (sql.includes('MAX("order")')) return { maxOrder: Math.max(0, ...rows.filter((r) => r.type === params[0] && r.parent === params[1]).map((r) => r.order)) };
          if (sql.includes('AND slug = ?')) return rows.find((r) => r.type === params[0] && r.slug === params[1] && r.mid !== params[2]) ?? null;
          if (sql.includes('AND name = ?')) return rows.find((r) => r.type === params[0] && r.name === params[1] && r.parent === params[2] && r.mid !== params[3]) ?? null;
          if (sql.includes('WHERE mid = ? AND type = ?')) return rows.find((r) => r.mid === params[0] && r.type === params[1]) ?? null;
          return null;
        },
        async all() {
          return { results: rows.filter((r) => r.type === params[0]).map((r) => ({ ...r })) };
        },
        async run() {
          statements.push({ sql, params: [...params] });
          if (sql.startsWith('INSERT INTO typecho_options')) selectedDefault = Number(params[1]);
          if (sql.startsWith('INSERT INTO typecho_metas')) {
            rows.push({ mid: Math.max(...rows.map((r) => r.mid)) + 1, name: String(params[0]), slug: String(params[1]), type: params[2] as Meta['type'], description: String(params[3]), count: 0, order: Number(params[4]), parent: Number(params[5]) });
          }
          if (sql.startsWith('UPDATE typecho_metas SET name')) {
            const row = rows.find((r) => r.mid === params[5] && r.type === params[6]);
            if (row) Object.assign(row, { name: params[0], slug: params[1], description: params[2], parent: params[3], order: params[4] });
          }
          if (sql.startsWith('UPDATE typecho_metas SET parent')) for (const row of rows) { if (row.type === 'category' && row.parent === params[1]) row.parent = Number(params[0]); }
          if (sql.startsWith('DELETE FROM typecho_relationships')) {
            for (let i = relationships.length - 1; i >= 0; i--) if (relationships[i].mid === params[0]) relationships.splice(i, 1);
          }
          if (sql.startsWith('DELETE FROM typecho_metas')) {
            const index = rows.findIndex((r) => r.mid === params[0] && r.type === params[1]);
            if (index >= 0) rows.splice(index, 1);
          }
          return { success: true };
        },
      };
      return stmt;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) { return Promise.all(statements.map((statement) => statement.run())); },
  } as unknown as D1Database;
  return { db: new Db(d1), rows, statements, relationships, defaultId: () => selectedDefault };
}

function request(path: string, options: RequestInit = {}) {
  return buildRequestContext(new Request(`${base}${path}`, { ...options, headers: { cookie, ...options.headers } }));
}
function post(path: string, source: string, data: Record<string, string | string[]>, options: { token?: string; origin?: string; cookie?: string } = {}) {
  const form = new FormData();
  for (const [key, values] of Object.entries(data)) for (const value of Array.isArray(values) ? values : [values]) form.append(key, value);
  const token = options.token ?? securityToken(secret, `${base}${source}`, admin);
  return buildRequestContext(new Request(`${base}${path}?_=${token}`, {
    method: 'POST', headers: { cookie: options.cookie ?? cookie, origin: options.origin ?? base, referer: `${base}${source}` }, body: form,
  }));
}
const handle = (db: Db, req: ReturnType<typeof request>) => handleAdminMetasRequest(db, req, secret);

describe('分类与标签后台', () => {
  it('未命中路径返回 null，游客跳转登录，非管理员被拒绝', async () => {
    const { db } = fakeDb();
    expect(await handle(db, request('/unrelated'))).toBeNull();
    const guest = buildRequestContext(new Request(`${base}/admin/manage-categories.php`));
    expect((await handle(db, guest))?.headers.get('location')).toContain('/admin/login.php');
    expect((await handle(fakeDb(undefined, 1, 'editor').db, request('/admin/manage-tags.php')))?.status).toBe(403);
    expect((await handle(fakeDb(undefined, 1, 'editor').db, post('/action/metas-category-edit', '/admin/category.php', { do: 'delete', mid: '2' })))?.status).toBe(403);
  });

  it('按 Typecho 路径列出分类，在 category.php 编辑，标签在管理页编辑且转义内容', async () => {
    const { db } = fakeDb([category(1, '默认', 'default'), category(2, '<新闻>', 'news'), category(3, '子分类', 'child', 2), tag(4, '<script>', 'tag')]);
    const categories = await handle(db, request('/admin/manage-categories.php'));
    const categoryHtml = await categories?.text();
    expect(categories?.status).toBe(200);
    expect(categoryHtml).toContain('/admin/category.php?mid=2');
    expect(categoryHtml).toContain('/admin/manage-categories.php?parent=2');
    const subcategories = await handle(db, request('/admin/manage-categories.php?parent=2'));
    expect(await subcategories?.text()).toContain('/admin/category.php?parent=3');
    expect(categoryHtml).not.toContain('<新闻>');
    expect(categoryHtml).toContain('默认分类不可删除');
    const editor = await handle(db, request('/admin/category.php?mid=2'));
    expect(await editor?.text()).toContain('value="update"');
    const tags = await handle(db, request('/admin/manage-tags.php?mid=4'));
    const tagHtml = await tags?.text();
    expect(tagHtml).toContain('编辑标签');
    expect(tagHtml).toContain('&lt;script&gt;');
    expect(tagHtml).not.toContain('<script>');
    expect((await handle(db, request('/admin/category.php?mid=99')))?.status).toBe(404);
  });

  it('新增、更新分类并按父级排序，不能形成自身与后代循环', async () => {
    const { db, rows, statements } = fakeDb();
    const added = await handle(db, post('/action/metas-category-edit', '/admin/category.php?parent=2', { do: 'insert', name: '中文 测试', slug: '', description: '描述', parent: '2' }));
    expect(added?.status).toBe(303);
    expect(added?.headers.get('location')).toContain('/admin/manage-categories.php?parent=2&saved=1');
    expect(rows.at(-1)).toMatchObject({ slug: '中文-测试', type: 'category', parent: 2, order: 4 });
    const updated = await handle(db, post('/action/metas-category-edit', '/admin/category.php?mid=3', { do: 'update', mid: '3', name: '地方新版', slug: 'local-new', parent: '0' }));
    expect(updated?.status).toBe(303);
    expect(rows.find((r) => r.mid === 3)).toMatchObject({ name: '地方新版', slug: 'local-new', parent: 0 });
    expect(statements.some((s) => s.sql.startsWith('UPDATE typecho_metas SET name'))).toBe(true);
    expect((await handle(db, post('/action/metas-category-edit', '/admin/category.php?mid=2', { do: 'update', mid: '2', name: '新闻', slug: 'news', parent: '2' })))?.status).toBe(400);
    expect((await handle(db, post('/action/metas-category-edit', '/admin/category.php?mid=2', { do: 'update', mid: '2', name: '新闻', slug: 'news', parent: String(rows.at(-1)?.mid) })))?.status).toBe(400);
  });

  it('同类型 slug 不允许重复，分类同一父级名称不能重复，允许标签同名不同类型', async () => {
    const { db } = fakeDb();
    expect((await handle(db, post('/action/metas-category-edit', '/admin/category.php', { do: 'insert', name: '另一个', slug: 'news', parent: '0' })))?.status).toBe(409);
    expect((await handle(db, post('/action/metas-category-edit', '/admin/category.php', { do: 'insert', name: '新闻', slug: 'news2', parent: '0' })))?.status).toBe(409);
    expect((await handle(db, post('/action/metas-category-edit', '/admin/category.php', { do: 'insert', name: '新闻', slug: 'news-child', parent: '2' })))?.status).toBe(303);
    expect((await handle(db, post('/action/metas-tag-edit', '/admin/manage-tags.php', { do: 'insert', name: '专题二', slug: 'feature' })))?.status).toBe(409);
    expect((await handle(db, post('/action/metas-tag-edit', '/admin/manage-tags.php', { do: 'insert', name: '新闻', slug: 'news' })))?.status).toBe(303);
  });

  it('设置默认分类后阻止删除，并在缺少选项时保护首个分类', async () => {
    const { db, rows, defaultId } = fakeDb();
    expect((await handle(db, post('/action/metas-category-edit', '/admin/manage-categories.php', { do: 'default', mid: '2' })))?.status).toBe(303);
    expect(defaultId()).toBe(2);
    const attempt = await handle(db, post('/action/metas-category-edit', '/admin/manage-categories.php', { do: 'delete', 'mid[]': ['2', '3'] }));
    expect(attempt?.status).toBe(409);
    expect(rows.some((row) => row.mid === 2)).toBe(true);
    const missingOption = fakeDb(undefined, null);
    expect((await handle(missingOption.db, post('/action/metas-category-edit', '/admin/manage-categories.php', { do: 'delete', mid: '1' })))?.status).toBe(409);
  });

  it('删除时移除关联并将子分类上提；标签仅删除目标标签关联', async () => {
    const { db, rows, relationships } = fakeDb();
    const removed = await handle(db, post('/action/metas-category-edit', '/admin/manage-categories.php', { do: 'delete', 'mid[]': ['2'] }));
    expect(removed?.status).toBe(303);
    expect(rows.find((row) => row.mid === 3)?.parent).toBe(0);
    expect(relationships.some((row) => row.mid === 2)).toBe(false);
    expect(relationships.some((row) => row.mid === 3)).toBe(true);
    expect((await handle(db, post('/action/metas-tag-edit', '/admin/manage-tags.php', { do: 'delete', mid: '4' })))?.status).toBe(303);
    expect(relationships.some((row) => row.mid === 4)).toBe(false);
    expect(rows.some((row) => row.mid === 4)).toBe(false);
  });

  it('拒绝无效令牌、跨源请求、非法操作和非 POST 修改', async () => {
    const { db, statements } = fakeDb();
    const form = { do: 'delete', mid: '2' };
    expect((await handle(db, post('/action/metas-category-edit', '/admin/manage-categories.php', form, { token: 'bad' })))?.status).toBe(403);
    expect((await handle(db, post('/action/metas-category-edit', '/admin/manage-categories.php', form, { origin: 'https://evil.test' })))?.status).toBe(403);
    const badReferer = post('/action/metas-category-edit', '/admin/manage-tags.php', form);
    expect((await handle(db, badReferer))?.status).toBe(403);
    expect((await handle(db, post('/action/metas-tag-edit', '/admin/manage-tags.php', { do: 'unsupported' })))?.status).toBe(400);
    expect((await handle(db, request('/action/metas-category-edit')))?.status).toBe(405);
    expect((await handle(db, post('/action/metas-tag-edit', '/admin/manage-tags.php', { do: 'delete', mid: '2' })))?.status).toBe(404);
    expect(statements).toEqual([]);
  });
});
