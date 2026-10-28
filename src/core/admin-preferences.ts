import { findCurrentUser, securityToken, type AuthUser } from './auth';
import { escapeHtml } from './common';
import type { Db } from './db';
import { currentRequestUrl, type RequestContext } from './request';

type SettingPage = 'reading' | 'discussion';
const discussionFlags = [
  ['commentsRequireLogin', '只有已登录用户才能评论'],
  ['commentsRequireMail', '访客须填写邮箱'],
  ['commentsRequireUrl', '访客须填写网站'],
  ['commentsThreaded', '允许回复评论'],
  ['commentsRequireModeration', '评论需经审核'],
  ['commentsWhitelist', '首次评论需经审核'],
  ['commentsAutoClose', '到期自动关闭评论'],
] as const;

export async function handleAdminPreferencesRequest(db: Db, request: RequestContext, secret: string): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  const match = /^\/(admin|action)\/options-(reading|discussion)(\.php)?$/.exec(path);
  if (!match || (match[1] === 'admin') !== Boolean(match[3])) return null;
  const page = match[2] as SettingPage;
  const isEdit = match[1] === 'action';
  const user = await findCurrentUser(db, request);
  if (!user) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}`);
  if (user.group !== 'administrator') return text('Forbidden', 403);
  if (!isEdit) {
    if (request.method !== 'GET') return text('Method Not Allowed', 405);
    const rows = await db.all<{ name: string; value: string | null }>('SELECT name, value FROM table.options WHERE "user" = 0');
    const values = Object.fromEntries(rows.map(({ name, value }) => [name, value ?? '']));
    const source = currentRequestUrl(request);
    const action = `${request.rootUrl}/action/options-${page}?_=${securityToken(secret, source, user)}`;
    const body = page === 'reading'
      ? await readingPage(db, request, values, action)
      : discussionPage(request, values, action);
    return new Response(shell(page === 'reading' ? '阅读设置' : '评论设置', request, body), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
  }
  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  const form = await request.body?.();
  if (!form || !csrfValid(request, secret, user, page)) return text('CSRF validation failed', 403);
  let values: Record<string, string>;
  if (page === 'reading') {
    const frontPage = String(form.get('frontPage') ?? 'recent');
    const pageSize = boundedInteger(form, 'pageSize', 1, 100);
    const postsListSize = boundedInteger(form, 'postsListSize', 1, 50);
    const commentsListSize = boundedInteger(form, 'commentsListSize', 1, 50);
    if (pageSize === null || postsListSize === null || commentsListSize === null) return text('Invalid reading settings', 400);
    if (frontPage !== 'recent') {
      const cid = /^page:([1-9]\d*)$/.exec(frontPage)?.[1];
      if (!cid || !Number.isSafeInteger(Number(cid))) return text('Invalid front page', 400);
      const row = await db.first<{ cid: number }>("SELECT cid FROM table.contents WHERE cid = ? AND type = 'page' AND status = 'publish' AND created <= ?", [Number(cid), Math.floor(Date.now() / 1000)]);
      if (!row) return text('Front page does not exist', 400);
    }
    values = { frontPage, pageSize: String(pageSize), postsListSize: String(postsListSize), commentsListSize: String(commentsListSize) };
  } else {
    const interval = boundedInteger(form, 'commentsPostInterval', 0, 3600);
    const timeout = boundedInteger(form, 'commentsPostTimeout', 0, 86400 * 365);
    if (interval === null || timeout === null) return text('Invalid comment settings', 400);
    values = Object.fromEntries(discussionFlags.map(([key]) => [key, form.get(key) === '1' ? '1' : '0']));
    values.commentsPostInterval = String(interval);
    values.commentsPostTimeout = String(timeout);
  }
  await db.batch(Object.entries(values).map(([name, value]) => ({
    sql: 'INSERT INTO table.options (name, "user", value) VALUES (?, 0, ?) ON CONFLICT(name, "user") DO UPDATE SET value = excluded.value',
    params: [name, value],
  })));
  return redirect(`${request.rootUrl}/admin/options-${page}.php?saved=1`);
}

function csrfValid(request: RequestContext, secret: string, user: AuthUser, page: SettingPage): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return false;
  const referer = request.referer;
  try {
    const parsed = new URL(referer);
    if (parsed.origin !== request.url.origin || parsed.pathname !== `/admin/options-${page}.php`) return false;
  } catch { return false; }
  const actual = request.query.get('_') ?? '';
  const expected = securityToken(secret, referer, user);
  if (actual.length !== expected.length) return false;
  let different = 0;
  for (let i = 0; i < actual.length; i++) different |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return different === 0;
}

function boundedInteger(form: FormData, name: string, min: number, max: number): number | null {
  const raw = form.get(name);
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

async function readingPage(db: Db, request: RequestContext, values: Record<string, string>, action: string): Promise<string> {
  const pages = await db.all<{ cid: number; title: string }>("SELECT cid, title FROM table.contents WHERE type = 'page' AND status = 'publish' ORDER BY cid LIMIT 100");
  const selected = (value: string) => values.frontPage === value ? ' selected' : '';
  const options = pages.map(({ cid, title }) => `<option value="page:${cid}"${selected(`page:${cid}`)}>${escapeHtml(title || `页面 ${cid}`)}</option>`).join('');
  return `<h1>阅读设置</h1>${notice(request)}<form method="post" action="${escapeHtml(action)}"><label>首页显示<select name="frontPage"><option value="recent"${selected('recent')}>最新文章</option>${options}</select></label>${numberField('pageSize', '每页文章数', values.pageSize || '10', 1, 100)}${numberField('postsListSize', '近期文章数量', values.postsListSize || '5', 1, 50)}${numberField('commentsListSize', '近期评论数量', values.commentsListSize || '5', 1, 50)}<button type="submit">保存阅读设置</button></form>`;
}

function discussionPage(request: RequestContext, values: Record<string, string>, action: string): string {
  const boxes = discussionFlags.map(([name, label]) => `<label class="checkbox"><input name="${name}" type="checkbox" value="1"${values[name] === '1' ? ' checked' : ''}>${label}</label>`).join('');
  return `<h1>评论设置</h1>${notice(request)}<form method="post" action="${escapeHtml(action)}">${boxes}${numberField('commentsPostInterval', '同一访客的评论间隔（秒）', values.commentsPostInterval || '60', 0, 3600)}${numberField('commentsPostTimeout', '文章评论开放时长（秒，0 表示不限）', values.commentsPostTimeout || '0', 0, 86400 * 365)}<button type="submit">保存评论设置</button></form>`;
}

function numberField(name: string, label: string, value: string, min: number, max: number): string {
  return `<label>${label}<input name="${name}" type="number" min="${min}" max="${max}" required value="${escapeHtml(value)}"></label>`;
}
function notice(request: RequestContext): string {
  return request.query.has('saved') ? '<p role="status">设置已保存。</p>' : '';
}
function shell(title: string, request: RequestContext, body: string): string {
  const root = escapeHtml(request.rootUrl);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Typecho</title><style>body{margin:0;background:#f6f8f9;color:#26333d;font:16px/1.6 system-ui,sans-serif}header{background:#fff;border-bottom:1px solid #e0e7e8;padding:16px max(24px,calc((100vw - 760px)/2))}a{color:#257059;margin-right:16px}main{max-width:760px;margin:32px auto;padding:24px;background:#fff;border:1px solid #e2e8e8;border-radius:12px}form{display:grid;gap:15px}label{display:grid;gap:6px}.checkbox{display:flex;align-items:center}.checkbox input{margin-right:10px}input,select{font:inherit;border:1px solid #cbd6d5;border-radius:6px;padding:8px}button{background:#257059;color:#fff;border:0;border-radius:6px;padding:11px;cursor:pointer}@media(max-width:790px){main{margin:16px;padding:18px}}</style></head><body><header><a href="${root}/admin/">后台</a><a href="${root}/admin/options-general.php">基本设置</a><a href="${root}/admin/options-reading.php">阅读设置</a><a href="${root}/admin/options-discussion.php">评论设置</a></header><main>${body}</main></body></html>`;
}
function text(message: string, status: number): Response { return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } }); }
function redirect(location: string): Response { return new Response(null, { status: 303, headers: { location } }); }
