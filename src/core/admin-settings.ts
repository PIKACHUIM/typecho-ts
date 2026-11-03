import { findCurrentUser, securityToken } from './auth';
import { escapeHtml } from './common';
import type { Db } from './db';
import { currentRequestUrl, type RequestContext } from './request';
import { renderAdminShell } from './admin-ui';

export async function handleAdminSettingsRequest(db: Db, request: RequestContext, secret: string): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  if (path !== '/admin/options-general.php' && path !== '/action/options-general') return null;
  const user = await findCurrentUser(db, request);
  if (!user) {
    return new Response(null, { status: 303, headers: { location: `${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}` } });
  }
  if (user.group !== 'administrator') return text('Forbidden', 403);
  if (path === '/admin/options-general.php') {
    if (request.method !== 'GET') return text('Method Not Allowed', 405);
    const rows = await db.all<{ name: string; value: string | null }>(
      "SELECT name, value FROM table.options WHERE user = 0 AND name IN ('title','description','siteUrl','timezone','pageSize')"
    );
    const options = Object.fromEntries(rows.map(({ name, value }) => [name, value ?? '']));
    const token = securityToken(secret, currentRequestUrl(request), user);
    const action = `${request.rootUrl}/action/options-general?_=${token}`;
    const themesUrl = escapeHtml(`${request.rootUrl}/admin/themes.php`);
    const body = `<h1>基本设置</h1>${request.query.has('saved') ? '<p role="status">设置已保存。</p>' : ''}<form method="post" action="${escapeHtml(action)}"><label>站点标题<input required name="title" maxlength="150" value="${escapeHtml(options.title)}"></label><label>站点描述<input name="description" maxlength="255" value="${escapeHtml(options.description)}"></label><label>站点地址<input required name="siteUrl" type="url" value="${escapeHtml(options.siteUrl || request.rootUrl)}"></label><label>时区偏移（秒）<input name="timezone" type="number" min="-43200" max="50400" value="${escapeHtml(options.timezone || '28800')}"></label><label>每页文章数<input name="pageSize" type="number" min="1" max="100" value="${escapeHtml(options.pageSize || '10')}"></label><button type="submit">保存设置</button></form><p class="description">前台主题与后台外观已分开管理：<a href="${themesUrl}">打开主题与外观设置</a>。</p>`;
    return new Response(page('基本设置', request, body), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
  }
  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  const form = await request.body?.();
  if (!form || !request.referer) return text('CSRF validation failed', 403);
  const origin = request.headers.get('origin');
  try {
    if ((origin && origin !== request.url.origin) || new URL(request.referer).origin !== request.url.origin) return text('CSRF validation failed', 403);
  } catch {
    return text('CSRF validation failed', 403);
  }
  const token = request.query.get('_') ?? '';
  const expected = securityToken(secret, request.referer, user);
  if (token.length !== expected.length) return text('CSRF validation failed', 403);
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch) return text('CSRF validation failed', 403);

  const title = String(form.get('title') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();
  const siteUrl = String(form.get('siteUrl') ?? '').trim().replace(/\/+$/, '');
  const timezone = Number(form.get('timezone'));
  const pageSize = Number(form.get('pageSize'));
  let parsed: URL;
  try { parsed = new URL(siteUrl); } catch { return text('Invalid site URL.', 400); }
  if (!title || title.length > 150 || description.length > 255) return text('Invalid site title or description.', 400);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.toString().replace(/\/+$/, '') !== siteUrl) return text('Invalid site URL.', 400);
  if (!Number.isInteger(timezone) || timezone < -43200 || timezone > 50400) return text('Invalid timezone.', 400);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return text('Invalid page size.', 400);
  const values = { title, description, siteUrl, timezone: String(timezone), pageSize: String(pageSize) };
  await db.batch(Object.entries(values).map(([name, value]) => ({
    sql: 'INSERT INTO table.options (name, "user", value) VALUES (?, 0, ?) ON CONFLICT(name, "user") DO UPDATE SET value = excluded.value',
    params: [name, value],
  })));
  return new Response(null, { status: 303, headers: { location: `${request.rootUrl}/admin/options-general.php?saved=1` } });
}

function page(title: string, request: RequestContext, body: string): string {
  return renderAdminShell(title, request, body);
}
function text(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
}
