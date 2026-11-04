import { escapeHtml } from './common';
import { findCurrentUser, securityToken, type AuthUser } from './auth';
import type { Db } from './db';
import { renderAdminShell } from './admin-ui';
import { currentRequestUrl, type RequestContext } from './request';

export async function handleAdminRoutingRequest(db: Db, request: RequestContext, secret: string): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  if (path !== '/admin/options-routing.php' && path !== '/action/options-routing') return null;
  const user = await findCurrentUser(db, request);
  if (!user) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}`);
  if (user.group !== 'administrator') return text('Forbidden', 403);

  if (path === '/admin/options-routing.php') {
    if (request.method !== 'GET') return text('Method Not Allowed', 405);
    const row = await db.first<{ value: string | null }>("SELECT value FROM table.options WHERE name = 'rewrite' AND user = 0");
    const enabled = row?.value !== '0';
    const referer = currentRequestUrl(request);
    const token = securityToken(secret, referer, user);
    const action = `${request.rootUrl}/action/options-routing?_=${encodeURIComponent(token)}`;
    const pretty = `${request.rootUrl}/archives/1/`;
    const fallback = `${request.rootUrl}/index.php/archives/1/`;
    const body = `<h1>固定链接</h1>${request.query.has('saved') ? '<p role="status">固定链接设置已保存。</p>' : ''}<p class="description">选择站点内容链接是否使用简洁路径。Worker 路由始终启用；关闭重写只会在链接中保留 <code>index.php</code>。</p><form method="post" action="${escapeHtml(action)}"><label class="check"><input type="checkbox" name="rewrite" value="1"${enabled ? ' checked' : ''}>启用简洁链接</label><section class="help"><h2>链接预览</h2><p>启用：<code>${escapeHtml(pretty)}</code></p><p>关闭：<code>${escapeHtml(fallback)}</code></p></section><button type="submit">保存链接设置</button></form>`;
    return html(renderAdminShell('固定链接', request, body));
  }

  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  const form = await request.body?.();
  if (!form || !validRequest(request, secret, user)) return text('CSRF validation failed', 403);
  const rewrite = form.get('rewrite') === '1' ? '1' : '0';
  await db.run('INSERT INTO table.options (name, "user", value) VALUES (?, 0, ?) ON CONFLICT(name, "user") DO UPDATE SET value = excluded.value', ['rewrite', rewrite]);
  return redirect(`${request.rootUrl}/admin/options-routing.php?saved=1`);
}

function validRequest(request: RequestContext, secret: string, user: AuthUser): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return false;
  let referer: URL;
  try { referer = new URL(request.referer); } catch { return false; }
  const expectedPath = `${new URL(request.rootUrl).pathname.replace(/\/$/, '')}/admin/options-routing.php`;
  if (referer.origin !== request.url.origin || referer.pathname !== expectedPath) return false;
  const actual = request.query.get('_') ?? '';
  const expected = securityToken(secret, request.referer, user);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function html(value: string): Response { return new Response(value, { headers: { 'content-type': 'text/html; charset=UTF-8' } }); }
function text(value: string, status: number): Response { return new Response(value, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } }); }
function redirect(location: string): Response { return new Response(null, { status: 303, headers: { location } }); }
