import { findCurrentUser, securityToken, type AuthUser } from './auth';
import { escapeHtml } from './common';
import type { Db } from './db';
import { currentRequestUrl, type RequestContext } from './request';

type CommentStatus = 'approved' | 'waiting' | 'spam';
type CommentAction = CommentStatus | 'delete';

interface CommentRow {
  coid: number;
  cid: number;
  created: number;
  author: string | null;
  mail: string | null;
  text: string | null;
  type: string;
  status: string;
  title: string | null;
}

const actions: CommentAction[] = ['approved', 'waiting', 'spam', 'delete'];
const pageSize = 20;

export async function handleAdminCommentsRequest(db: Db, request: RequestContext, secret: string): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  if (path !== '/admin/manage-comments.php' && path !== '/action/comments-edit') return null;
  const user = await findCurrentUser(db, request);
  if (!user) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}`);
  if (user.group !== 'administrator') return text('Forbidden', 403);

  if (path === '/admin/manage-comments.php') {
    if (request.method !== 'GET') return text('Method Not Allowed', 405);
    const status = request.query.get('status') ?? 'approved';
    if (!['approved', 'waiting', 'spam'].includes(status)) return text('Invalid comment status', 400);
    const rawPage = request.query.get('page') ?? '1';
    if (!/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage)) || Number(rawPage) > 10000) {
      return text('Invalid page number', 400);
    }
    const page = Number(rawPage);
    const rows = await db.all<CommentRow>(
      `SELECT c.coid, c.cid, c.created, c.author, c.mail, c.text, c.type, c.status, p.title
       FROM table.comments AS c LEFT JOIN table.contents AS p ON p.cid = c.cid
       WHERE c.status = ? ORDER BY c.coid DESC LIMIT ? OFFSET ?`,
      [status, pageSize + 1, (page - 1) * pageSize]
    );
    return new Response(listPage(request, user, secret, status as CommentStatus, page, rows), {
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    });
  }

  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  const action = request.query.get('do');
  if (!actions.includes(action as CommentAction)) return text('Invalid comment action', 400);
  const form = await request.body?.();
  if (!form || !validCsrf(request, form, user, secret)) return text('CSRF validation failed', 403);
  const submittedIds = [...form.getAll('coid'), ...form.getAll('coid[]')];
  const ids = submittedIds.length ? submittedIds : request.query.getAll('coid');
  if (!ids.length || ids.length > 50 || ids.some((id) => typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    return text('Invalid comment ID', 400);
  }
  const uniqueIds = [...new Set(ids.map(Number))];
  const comments = await Promise.all(uniqueIds.map((coid) =>
    db.first<Pick<CommentRow, 'cid' | 'status'>>('SELECT cid, status FROM table.comments WHERE coid = ?', [coid])
  ));
  if (comments.some((comment) => !comment)) return text('Comment not found', 404);

  const updates = uniqueIds.map((coid) => action === 'delete'
    ? { sql: 'DELETE FROM table.comments WHERE coid = ?', params: [coid] }
    : { sql: 'UPDATE table.comments SET status = ? WHERE coid = ?', params: [action, coid] });
  const cids = [...new Set(comments.map((comment) => comment!.cid))];
  await db.batch([
    ...updates,
    ...cids.map((cid) => ({
      sql: `UPDATE table.contents SET commentsNum = (
        SELECT COUNT(*) FROM table.comments WHERE cid = ? AND type = 'comment' AND status = 'approved'
      ) WHERE cid = ?`,
      params: [cid, cid],
    })),
  ]);
  return redirect(`${request.rootUrl}/admin/manage-comments.php?status=${action === 'delete' ? 'approved' : action}&saved=1`);
}

function validCsrf(request: RequestContext, form: FormData, user: AuthUser, secret: string): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return false;
  if (!request.referer) return false;
  let referer: URL;
  try {
    referer = new URL(request.referer);
  } catch {
    return false;
  }
  if (referer.origin !== request.url.origin || referer.pathname !== `${new URL(request.rootUrl).pathname.replace(/\/+$/, '')}/admin/manage-comments.php`) return false;
  const token = request.query.get('_') ?? (typeof form.get('_') === 'string' ? String(form.get('_')) : '');
  const expected = securityToken(secret, request.referer, user);
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

function listPage(request: RequestContext, user: AuthUser, secret: string, status: CommentStatus, page: number, rows: CommentRow[]): string {
  const root = escapeHtml(request.rootUrl);
  const token = securityToken(secret, currentRequestUrl(request), user);
  const labels: Record<CommentAction, string> = { approved: '通过', waiting: '待审核', spam: '垃圾', delete: '删除' };
  const list = `${root}/admin/manage-comments.php`;
  const tabs = (['approved', 'waiting', 'spam'] as const).map((item) =>
    `<a href="${list}?status=${item}"${item === status ? ' aria-current="page"' : ''}>${labels[item]}</a>`
  ).join('');
  const entries = rows.slice(0, pageSize).map((row) => {
    const controls = actions.filter((action) => action === 'delete' || action !== row.status).map((action) =>
      `<form method="post" action="${root}/action/comments-edit?do=${action}&amp;_=${token}"><input type="hidden" name="coid" value="${row.coid}"><button type="submit">${labels[action]}</button></form>`
    ).join('');
    return `<tr><td>${escapeHtml(row.author ?? '')}<small>${escapeHtml(row.mail ?? '')}</small></td><td>${escapeHtml(row.title ?? `#${row.cid}`)}<small>#${row.coid} · ${escapeHtml(row.type)}</small></td><td class="comment">${escapeHtml(row.text ?? '')}</td><td>${controls}</td></tr>`;
  }).join('');
  const previous = page > 1 ? `<a href="${list}?status=${status}&amp;page=${page - 1}">上一页</a>` : '';
  const next = rows.length > pageSize ? `<a href="${list}?status=${status}&amp;page=${page + 1}">下一页</a>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>评论管理 · Typecho</title><style>body{margin:0;background:#f6f8f9;color:#26333d;font:16px/1.6 system-ui,sans-serif}header{background:#fff;border-bottom:1px solid #e0e7e8;padding:16px max(24px,calc((100vw - 900px)/2))}a{color:#257059;margin-right:16px}main{max-width:900px;margin:32px auto;padding:24px;background:#fff;border:1px solid #e2e8e8;border-radius:12px}h1{margin:0 0 16px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #e8eeee;padding:12px;text-align:left;vertical-align:top}small{display:block;color:#788}.comment{white-space:pre-wrap;overflow-wrap:anywhere;max-width:360px}td form{display:inline-block;margin:2px}button{border:0;background:#257059;color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer}nav{margin-top:20px}@media(max-width:900px){main{margin:16px;padding:16px}table{display:block;overflow-x:auto}}</style></head><body><header><a href="${root}/admin/">后台</a><a href="${root}/admin/manage-posts.php">文章</a><a href="${root}/admin/manage-comments.php">评论</a><a href="${root}/">查看站点</a></header><main><h1>评论管理</h1>${request.query.has('saved') ? '<p role="status">评论已更新。</p>' : ''}<nav>${tabs}</nav><table><thead><tr><th>作者</th><th>文章</th><th>评论</th><th>操作</th></tr></thead><tbody>${entries || '<tr><td colspan="4">暂无评论</td></tr>'}</tbody></table><nav>${previous} ${next}</nav></main></body></html>`;
}

function text(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
