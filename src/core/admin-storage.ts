import { findCurrentUser, securityToken, type AuthUser } from './auth';
import { escapeHtml } from './common';
import type { Db } from './db';
import { normalizeAttachmentUrlPrefix } from './attachment-url';
import { renderAdminShell } from './admin-ui';
import { currentRequestUrl, type RequestContext } from './request';

export async function handleAdminStorageRequest(
  db: Db,
  request: RequestContext,
  secret: string,
  bucket?: R2Bucket
): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  if (path !== '/admin/options-media.php' && path !== '/action/options-media') return null;

  const user = await findCurrentUser(db, request);
  if (!user) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}`);
  if (user.group !== 'administrator') return text('Forbidden', 403);

  if (path === '/admin/options-media.php') {
    if (request.method !== 'GET') return text('Method Not Allowed', 405);
    const row = await db.first<{ value: string | null }>(
      "SELECT value FROM table.options WHERE name = 'attachmentUrlPrefix' AND user = 0"
    );
    const prefix = row?.value ?? '';
    const status = await getR2Status(bucket);
    const statusText = status === 'available'
      ? '<strong class="status-ok">R2 绑定可用</strong>：Worker 可以访问绑定的 Bucket。'
      : status === 'missing'
        ? '<strong class="status-error">未检测到 R2 绑定</strong>：请在 Wrangler/Cloudflare Worker 配置中绑定名为 <code>BUCKET</code> 的 R2 Bucket。'
        : '<strong class="status-warning">R2 探测失败</strong>：请检查 Bucket 绑定与 Worker 权限。';
    const source = currentRequestUrl(request);
    const action = `${request.rootUrl}/action/options-media?_=${encodeURIComponent(securityToken(secret, source, user))}`;
    const body = `<h1>附件存储（R2）</h1>${request.query.has('saved') ? '<p role="status">附件 URL 设置已保存。</p>' : ''}<section class="status-card">${statusText}<p>Bucket 通过 Cloudflare Worker 的 <code>BUCKET</code> 绑定连接，不在这里填写凭据。当前部署配置中的 Bucket 名称：<code>typecho-files</code>。</p></section><form method="post" action="${escapeHtml(action)}"><label for="attachmentUrlPrefix">附件公开 URL 前缀</label><input id="attachmentUrlPrefix" name="attachmentUrlPrefix" type="url" inputmode="url" placeholder="留空则使用本站 Worker 代理，例如 https://cdn.example.com" value="${escapeHtml(prefix)}"><p class="description">留空时使用本站 <code>/usr/uploads/…</code> 地址，由 Worker 从 R2 读取。填写自定义域名时，域名必须已配置为指向此 R2 Bucket；附件文件会使用 <code>uploads/YYYY/MM/random-file-name</code> 对象路径。保存只记录前缀，不会验证域名映射或更改 Bucket。</p><button type="submit">保存附件设置</button></form><section class="help"><h2>配置 R2 绑定</h2><p>本地开发在 <code>wrangler.toml</code> 的 R2 bindings 配置中设置；Cloudflare 部署环境在 Worker 的 Settings → Bindings 中添加 R2 Bucket，并将变量名称设为 <code>BUCKET</code>。Bucket 名称需要与部署配置保持一致。主题和插件不是附件，不会写入此 Bucket。</p></section>`;
    return html(renderAdminShell('附件存储（R2）', request, body));
  }

  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  const form = await request.body?.();
  if (!form || !validRequest(request, secret, user)) return text('CSRF validation failed', 403);
  const rawPrefix = String(form.get('attachmentUrlPrefix') ?? '').trim();
  const prefix = normalizeAttachmentUrlPrefix(rawPrefix);
  if (prefix === null) return text('请输入有效的 HTTPS 附件 URL 前缀。', 400);

  await db.run(
    'INSERT INTO table.options (name, "user", value) VALUES (?, 0, ?) ON CONFLICT(name, "user") DO UPDATE SET value = excluded.value',
    ['attachmentUrlPrefix', prefix]
  );
  return redirect(`${request.rootUrl}/admin/options-media.php?saved=1`);
}

async function getR2Status(bucket?: R2Bucket): Promise<'missing' | 'available' | 'unavailable'> {
  if (!bucket) return 'missing';
  try {
    await bucket.head('__typecho_binding_check__');
    return 'available';
  } catch {
    return 'unavailable';
  }
}

function validRequest(request: RequestContext, secret: string, user: AuthUser): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return false;
  let referer: URL;
  try {
    referer = new URL(request.referer);
  } catch {
    return false;
  }
  const expectedPath = `${new URL(request.rootUrl).pathname.replace(/\/$/, '')}/admin/options-media.php`;
  if (referer.origin !== request.url.origin || referer.pathname !== expectedPath) return false;
  const actual = request.query.get('_') ?? '';
  const expected = securityToken(secret, request.referer, user);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i += 1) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function html(value: string): Response {
  return new Response(value, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
}
function text(value: string, status: number): Response {
  return new Response(value, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
}
function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
