import { describe, expect, it } from 'vitest';
import { applyAdminPreferences } from '../src/app';
import { handleAdminStorageRequest } from '../src/core/admin-storage';
import { handleAdminThemesRequest } from '../src/core/admin-themes';
import { attachmentPublicUrl, normalizeAttachmentUrlPrefix } from '../src/core/attachment-url';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { buildRequestContext, type RequestContext } from '../src/core/request';
import { localizeAdminHtml, localizeAdminText } from '../src/core/admin-i18n';
import { renderAdminShell } from '../src/core/admin-ui';
import { listThemes, themeMeta } from '../src/core/theme';
import type { Env } from '../src/env';

const base = 'https://example.test';
const secret = 'session-secret';
const authCode = '0123456789abcdef0123456789abcdef';
const user = { uid: 1, name: 'admin', group: 'administrator', screenName: 'Admin', password: '', mail: 'a@example.test', authCode };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;

type Write = { sql: string; params: unknown[] };
function fakeDb() {
  const writes: Write[] = [];
  const driver = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() {
          if (sql.includes('FROM typecho_users')) return user;
          return null;
        },
        async all() {
          return { results: [
            { name: 'theme', value: 'default' },
            { name: 'adminTheme', value: 'official' },
          ] };
        },
        async run() {
          writes.push({ sql, params: statement.params });
          return { success: true, meta: {} };
        },
      };
      return statement;
    },
    async batch(statements: Write[]) {
      writes.push(...statements);
      return [];
    },
  } as unknown as D1Database;
  return { db: new Db(driver), writes };
}

function postRequest(path: string, form: FormData): RequestContext {
  const referer = `${base}${path}`;
  const token = securityToken(secret, referer, user);
  const action = path.includes('themes') ? '/action/themes' : '/action/options-media';
  return buildRequestContext(new Request(`${base}${action}?_=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { cookie, origin: base, referer },
    body: form,
  }));
}

describe('admin appearance application', () => {
  it('localizes plain-text errors from admin forms but leaves public responses unchanged', async () => {
    const values = [{ name: 'adminLocale', value: 'en-US' }];
    const d1 = { prepare() { return { async all() { return { results: values }; } }; } } as unknown as D1Database;
    const env = { DB: d1 } as Env;
    const adminRequest = new Request(`${base}/action/metas-category-edit`, {
      method: 'POST', headers: { referer: `${base}/admin/manage-categories.php` },
    });
    const adminResponse = await applyAdminPreferences(
      env,
      adminRequest,
      new Response('分类不存在。', { status: 404, headers: { 'content-type': 'text/plain; charset=UTF-8' } })
    );
    expect(await adminResponse.text()).toBe('Category not found.');

    const publicRequest = new Request(`${base}/action/comment`, {
      method: 'POST', headers: { referer: `${base}/posts/hello/` },
    });
    const publicResponse = await applyAdminPreferences(
      env,
      publicRequest,
      new Response('分类不存在。', { status: 404, headers: { 'content-type': 'text/plain; charset=UTF-8' } })
    );
    expect(await publicResponse.text()).toBe('分类不存在。');
  });

  it('applies the selected skin, dark mode and English locale to backend pages', async () => {
    const values = [
      { name: 'adminTheme', value: 'ocean' },
      { name: 'adminMode', value: 'dark' },
      { name: 'adminLocale', value: 'en-US' },
    ];
    const d1 = {
      prepare() {
        return { async all() { return { results: values }; } };
      },
    } as unknown as D1Database;
    const request = new Request(`${base}/admin/manage-posts.php`);
    const source = new Response(renderAdminShell('文章管理', buildRequestContext(request), '<h1>文章管理</h1>'), {
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    });
    const result = await applyAdminPreferences({ DB: d1 } as Env, request, source);
    const html = await result.text();

    expect(html).toContain('lang="en-US"');
    expect(html.match(/<html\b[^>]*\blang=/g)).toHaveLength(1);
    expect(html).toContain('data-admin-theme="ocean"');
    expect(html).toContain('data-admin-mode="dark"');
    expect(html).toContain('<h1>Posts</h1>');
  });
});

describe('theme and admin appearance settings', () => {
  it('lists front-end themes separately from the backend appearance', async () => {
    const { db } = fakeDb();
    const response = await handleAdminThemesRequest(
      db,
      buildRequestContext(new Request(`${base}/admin/themes.php`, { headers: { cookie } })),
      secret
    );

    expect(response?.status).toBe(200);
    const html = await response!.text();
    expect(html).toContain('清新绿');
    expect(listThemes()).toContain('green');
    expect(themeMeta('green').name).toBe('清新绿');
    expect(themeMeta('default').name).toBe('Typecho 默认主题');
    expect(html).toContain('Typecho 官方风格');
    expect(html).toContain('分别设置访客看到');
    expect(html).toContain('海蓝经典');
    expect(html).toContain('深色模式');
    expect(html).toContain('界面语言');
    expect(html).toContain('theme-card--ocean');
    expect(html).toContain('npm run gen');
    expect(html).toContain('/admin/css/style.css');
    expect(html).toContain('/admin/css/typecho-work.css');
    expect(html).toContain('/admin/options-media.php');
    const english = localizeAdminHtml(html, 'en-US');
    expect(english).toContain('Themes & Appearance');
    expect(english).toContain('Fresh Green');
    expect(english).toContain('Dark mode');
    expect(english).toContain('Save preferences');
    expect(english).not.toMatch(/\p{Script=Han}/u);
  });

  it('saves the front theme, three-way admin skin, dark mode and locale independently', async () => {
    const { db, writes } = fakeDb();
    const form = new FormData();
    form.set('theme', 'green');
    form.set('adminTheme', 'ocean');
    form.set('adminMode', 'dark');
    form.set('adminLocale', 'en-US');
    const response = await handleAdminThemesRequest(db, postRequest('/admin/themes.php', form), secret);

    expect(response?.status).toBe(303);
    expect(writes).toHaveLength(4);
    expect(writes.map((write) => write.params)).toContainEqual(['theme', 'green']);
    expect(writes.map((write) => write.params)).toContainEqual(['adminTheme', 'ocean']);
    expect(writes.map((write) => write.params)).toContainEqual(['adminMode', 'dark']);
    expect(writes.map((write) => write.params)).toContainEqual(['adminLocale', 'en-US']);
  });

  it('localizes static text while preserving user content and uses four-character Chinese navigation labels', () => {
    const request = buildRequestContext(new Request(`${base}/admin/`));
    const html = renderAdminShell('管理后台', request, '<h1>文章管理</h1><p>访客内容</p>');
    const labels = ['后台首页', '文章管理', '页面管理', '分类管理', '标签管理', '评论管理', '用户管理', '媒体管理', '基本设置', '阅读设置', '评论设置', '主题管理', '插件管理', '附件设置'];
    for (const label of labels) {
      expect([...label].length).toBe(4);
      expect(html).toContain(`>${label}</a>`);
    }
    const english = localizeAdminHtml(html, 'en-US');
    expect(english).toContain('lang="en-US"');
    expect(english).toContain('<title>Admin Dashboard · Typecho</title>');
    expect(english).toContain('Dashboard');
    expect(english).toContain('Posts');
    expect(english).toContain('访客内容');
    const attributes = localizeAdminHtml('<input placeholder="留空自动生成"><p data-uploading-label="上传中…"></p><button onsubmit="return confirm(\'确认删除？\')">删除</button>', 'en-US');
    expect(attributes).toContain('placeholder="Leave blank to generate automatically"');
    expect(attributes).toContain('data-uploading-label="Uploading…"');
    expect(attributes).toContain("confirm('Confirm deletion?')");
    const pluginHtml = localizeAdminHtml('<p>Workers 不能在后台上传后自我部署插件。新增插件需放入项目 <code>plugins/</code>，在 <code>scripts/gen-themes.mjs</code> 中加入受控打包清单，运行 <code>npm run gen</code>、测试后重新部署。当前不是任意 Typecho 插件安装器。</p><p><code>HelloWorld</code>：<span>已启用</span></p>', 'en-US');
    expect(pluginHtml).not.toMatch(/\p{Script=Han}/u);
    expect(pluginHtml).toContain('Enabled');
    expect(localizeAdminText('无效的分类 ID。', 'en-US')).toBe('Invalid category ID.');
    expect(localizeAdminText('标签名称不能为空、包含特殊字符或超过 150 字。', 'en-US'))
      .toBe('Tag name is required, must not contain special characters, and must be 150 characters or fewer.');
    expect(localizeAdminText('8 个子分类', 'en-US')).toBe('8 subcategories');
    expect(localizeAdminText('新闻 的子分类', 'en-US')).toBe('新闻 subcategories');
  });
});

describe('R2 attachment URL settings', () => {
  it('normalizes HTTPS prefixes and rejects unsafe or malformed values', () => {
    expect(normalizeAttachmentUrlPrefix('')).toBe('');
    expect(normalizeAttachmentUrlPrefix('https://CDN.example.test/assets/')).toBe('https://cdn.example.test/assets');
    expect(normalizeAttachmentUrlPrefix('http://cdn.example.test')).toBeNull();
    expect(normalizeAttachmentUrlPrefix('//cdn.example.test')).toBeNull();
    expect(normalizeAttachmentUrlPrefix('https://user:pass@cdn.example.test')).toBeNull();
    expect(normalizeAttachmentUrlPrefix('https://cdn.example.test/a?token=x')).toBeNull();
  });

  it('keeps the internal R2 key while generating a configured public URL', () => {
    const path = '/usr/uploads/2026/11/01234567-89ab-cdef-0123-456789abcdef.png';
    expect(attachmentPublicUrl(base, path, '')).toBe(`${base}${path}`);
    expect(attachmentPublicUrl(base, path, 'https://cdn.example.test/assets'))
      .toBe('https://cdn.example.test/assets/uploads/2026/11/01234567-89ab-cdef-0123-456789abcdef.png');
    expect(attachmentPublicUrl(base, '/usr/uploads/../../secret', 'https://cdn.example.test')).toBe('');
  });

  it('shows the R2 binding probe separately from the public URL setting', async () => {
    const { db } = fakeDb();
    const response = await handleAdminStorageRequest(
      db,
      buildRequestContext(new Request(`${base}/admin/options-media.php`, { headers: { cookie } })),
      secret,
      { head: async () => null } as unknown as R2Bucket
    );

    expect(response?.status).toBe(200);
    const html = await response!.text();
    expect(html).toContain('R2 绑定可用');
    expect(html).toContain('typecho-files');
    expect(html).toContain('不会验证域名映射');
    expect(localizeAdminHtml(html, 'en-US')).not.toMatch(/\p{Script=Han}/u);
  });

  it('saves an optional CDN prefix without replacing the R2 binding', async () => {
    const { db, writes } = fakeDb();
    const form = new FormData();
    form.set('attachmentUrlPrefix', 'https://cdn.example.test/assets/');
    const response = await handleAdminStorageRequest(
      db,
      postRequest('/admin/options-media.php', form),
      secret,
      { head: async () => null } as unknown as R2Bucket
    );

    expect(response?.status).toBe(303);
    expect(writes[0]?.params).toEqual(['attachmentUrlPrefix', 'https://cdn.example.test/assets']);
  });

  it('rejects a non-HTTPS attachment prefix', async () => {
    const { db, writes } = fakeDb();
    const form = new FormData();
    form.set('attachmentUrlPrefix', 'http://cdn.example.test');
    const response = await handleAdminStorageRequest(
      db,
      postRequest('/admin/options-media.php', form),
      secret,
      { head: async () => null } as unknown as R2Bucket
    );

    expect(response?.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});
