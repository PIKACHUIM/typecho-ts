import { escapeHtml } from './common';
import { findCurrentUser, securityToken, type AuthUser } from './auth';
import type { Db } from './db';
import type { ContentRow } from '../repo/content';
import { currentRequestUrl, type RequestContext } from './request';

const CONTENT_TYPES = ['post', 'page'] as const;
type ContentType = (typeof CONTENT_TYPES)[number];

export async function handleAdminContentRequest(db: Db, request: RequestContext, secret: string): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  const listType: ContentType | null = path === '/admin/manage-posts.php' ? 'post' : path === '/admin/manage-pages.php' ? 'page' : null;
  const editType: ContentType | null = path === '/admin/write-post.php' ? 'post' : path === '/admin/write-page.php' ? 'page' : null;

  if (listType) {
    const user = await requireAdministrator(db, request);
    if (user instanceof Response) return user;
    if (request.method !== 'GET') return textResponse('Method Not Allowed', 405);
    const page = Math.min(100000, Math.max(1, Number(request.query.get('page') ?? 1) || 1));
    const rows = await db.all<ContentRow>(
      'SELECT * FROM table.contents WHERE type = ? ORDER BY created DESC, cid DESC LIMIT 51 OFFSET ?',
      [listType, (page - 1) * 50]
    );
    return htmlResponse(contentListPage(request, rows, listType, user, secret, page));
  }

  if (editType) {
    const user = await requireAdministrator(db, request);
    if (user instanceof Response) return user;
    if (request.method !== 'GET') return textResponse('Method Not Allowed', 405);
    const cid = Number(request.query.get('cid') ?? 0);
    let row: ContentRow | null = null;
    if (cid > 0 && Number.isSafeInteger(cid)) {
      row = await db.first<ContentRow>('SELECT * FROM table.contents WHERE cid = ? AND type = ?', [cid, editType]);
      if (!row) return textResponse('Content not found', 404);
    } else if (request.query.has('cid')) return textResponse('Invalid content ID', 400);
    const action = `${request.rootUrl}/action/contents-${editType}-edit?_=${securityToken(secret, currentRequestUrl(request), user)}`;
    return htmlResponse(contentEditorPage(request, row, editType, action));
  }

  const saveMatch = /^\/action\/contents-(post|page)-edit$/.exec(path);
  const deleteMatch = /^\/action\/contents-(post|page)-delete$/.exec(path);
  if (!saveMatch && !deleteMatch) return null;
  if (request.method !== 'POST') return textResponse('Method Not Allowed', 405);
  const user = await requireAdministrator(db, request);
  if (user instanceof Response) return user;
  const form = await request.body?.();
  if (!form || !validCsrf(request, form, user, secret)) return textResponse('CSRF validation failed', 403);
  const type = (saveMatch?.[1] ?? deleteMatch?.[1]) as ContentType;
  return saveMatch ? saveContent(db, request, form, user, type) : deleteContent(db, request, form, type);
}

async function requireAdministrator(db: Db, request: RequestContext): Promise<AuthUser | Response> {
  const user = await findCurrentUser(db, request);
  if (!user) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}`);
  if (user.group !== 'administrator') return textResponse('Forbidden', 403);
  return user;
}

function validCsrf(request: RequestContext, form: FormData, user: AuthUser, secret: string): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return false;
  if (!request.referer) return false;
  try {
    if (new URL(request.referer).origin !== request.url.origin) return false;
  } catch {
    return false;
  }
  const token = request.query.get('_') ?? String(form.get('_') ?? '');
  const expected = securityToken(secret, request.referer, user);
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

async function saveContent(db: Db, request: RequestContext, form: FormData, user: AuthUser, type: ContentType): Promise<Response> {
  const rawCid = String(form.get('cid') ?? '0');
  if (!/^\d+$/.test(rawCid)) return textResponse('Invalid content ID', 400);
  const cid = Number(rawCid);
  if (!Number.isSafeInteger(cid)) return textResponse('Invalid content ID', 400);
  const title = String(form.get('title') ?? '').trim();
  const text = String(form.get('text') ?? '');
  const status = String(form.get('status') ?? 'publish');
  const slug = String(form.get('slug') ?? '').trim() || `${type}-${crypto.randomUUID().slice(0, 12)}`;
  const allowComment = form.get('allowComment') === '1' ? '1' : '0';
  if (!title || title.length > 150) return textResponse('Title is required and must not exceed 150 characters.', 400);
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(slug)) return textResponse('Slug must contain only letters, numbers, hyphens, and underscores.', 400);
  if (!['publish', 'draft', 'private'].includes(status)) return textResponse('Invalid content status', 400);
  if (new TextEncoder().encode(text).length > 1024 * 1024) return textResponse('Content exceeds 1 MB.', 413);
  const conflict = await db.first<{ cid: number }>('SELECT cid FROM table.contents WHERE slug = ? AND cid != ?', [slug, cid]);
  if (conflict) return textResponse('Slug already exists.', 409);
  const now = Math.floor(Date.now() / 1000);
  let targetCid = cid;
  if (cid) {
    const existing = await db.first<{ cid: number }>('SELECT cid FROM table.contents WHERE cid = ? AND type = ?', [cid, type]);
    if (!existing) return textResponse('Content not found', 404);
    await db.run('UPDATE table.contents SET title = ?, slug = ?, modified = ?, text = ?, status = ?, allowComment = ? WHERE cid = ? AND type = ?',
      [title, slug, now, text, status, allowComment, cid, type]);
  } else {
    const result = await db.first<{ cid: number }>(
      `INSERT INTO table.contents (title, slug, created, modified, text, "order", authorId, template, type, status, password, commentsNum, allowComment, allowPing, allowFeed, parent)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, NULL, 0, ?, '1', '1', 0) RETURNING cid`,
      [title, slug, now, now, text, user.uid, type, status, allowComment]
    );
    targetCid = Number(result?.cid ?? 0);
    if (!targetCid) return textResponse('Could not save content.', 500);
    if (type === 'post') {
      const category = await db.first<{ mid: number }>("SELECT mid FROM table.metas WHERE type = 'category' ORDER BY mid LIMIT 1");
      if (category) {
        await db.batch([
          { sql: 'INSERT INTO table.relationships (cid, mid) VALUES (?, ?)', params: [targetCid, category.mid] },
          { sql: 'UPDATE table.metas SET count = count + 1 WHERE mid = ?', params: [category.mid] },
        ]);
      }
    }
  }
  return redirect(`${request.rootUrl}/admin/write-${type}.php?cid=${targetCid}&saved=1`);
}

async function deleteContent(db: Db, request: RequestContext, form: FormData, type: ContentType): Promise<Response> {
  const rawCid = String(form.get('cid') ?? '');
  if (!/^[1-9]\d*$/.test(rawCid) || !Number.isSafeInteger(Number(rawCid))) return textResponse('Invalid content ID', 400);
  const cid = Number(rawCid);
  const existing = await db.first<{ cid: number }>('SELECT cid FROM table.contents WHERE cid = ? AND type = ?', [cid, type]);
  if (!existing) return textResponse('Content not found', 404);
  await db.batch([
    { sql: 'UPDATE table.metas SET count = MAX(0, count - 1) WHERE mid IN (SELECT mid FROM table.relationships WHERE cid = ?)', params: [cid] },
    { sql: 'DELETE FROM table.relationships WHERE cid = ?', params: [cid] },
    { sql: 'DELETE FROM table.fields WHERE cid = ?', params: [cid] },
    { sql: 'DELETE FROM table.comments WHERE cid = ?', params: [cid] },
    { sql: 'DELETE FROM table.contents WHERE cid = ? AND type = ?', params: [cid, type] },
  ]);
  return redirect(`${request.rootUrl}/admin/manage-${type === 'post' ? 'posts' : 'pages'}.php?deleted=1`);
}

function contentListPage(request: RequestContext, rows: ContentRow[], type: ContentType, user: AuthUser, secret: string, page: number): string {
  const title = type === 'post' ? '文章' : '页面';
  const listPath = `manage-${type === 'post' ? 'posts' : 'pages'}.php`;
  const visible = rows.slice(0, 50);
  const entries = visible.map((row) => {
    const editor = `${request.rootUrl}/admin/write-${type}.php?cid=${row.cid}`;
    const action = `${request.rootUrl}/action/contents-${type}-delete?_=${securityToken(secret, currentRequestUrl(request), user)}`;
    return `<tr><td><a href="${escapeHtml(editor)}">${escapeHtml(row.title ?? '(无标题)')}</a><small>${escapeHtml(row.slug ?? '')}</small></td><td>${escapeHtml(row.status)}</td><td><form method="post" action="${escapeHtml(action)}" onsubmit="return confirm('确认删除？')"><input type="hidden" name="cid" value="${row.cid}"><button class="danger" type="submit">删除</button></form></td></tr>`;
  }).join('');
  const previous = page > 1 ? `<a href="${escapeHtml(request.rootUrl)}/admin/${listPath}?page=${page - 1}">上一页</a>` : '';
  const next = rows.length > 50 ? `<a href="${escapeHtml(request.rootUrl)}/admin/${listPath}?page=${page + 1}">下一页</a>` : '';
  const body = `<h1>${title}管理</h1><p><a href="${escapeHtml(request.rootUrl)}/admin/write-${type}.php">新建${title}</a></p><table><thead><tr><th>标题 / 缩略名</th><th>状态</th><th>操作</th></tr></thead><tbody>${entries || `<tr><td colspan="3">暂无${title}</td></tr>`}</tbody></table><nav>${previous} ${next}</nav>`;
  return adminPage(`${title}管理`, request, body);
}

function contentEditorPage(request: RequestContext, row: ContentRow | null, type: ContentType, action: string): string {
  const noun = type === 'post' ? '文章' : '页面';
  const status = row?.status ?? 'publish';
  const option = (value: string, label: string) => `<option value="${value}"${status === value ? ' selected' : ''}>${label}</option>`;
  const body = `<h1>${row ? '编辑' : '新建'}${noun}</h1>${request.query.has('saved') ? '<p role="status">已保存。</p>' : ''}<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="cid" value="${row?.cid ?? 0}"><label>标题<input required maxlength="150" name="title" value="${escapeHtml(row?.title ?? '')}"></label><label>缩略名<input maxlength="150" name="slug" value="${escapeHtml(row?.slug ?? '')}" placeholder="留空自动生成"></label><label>正文<textarea rows="18" name="text">${escapeHtml(row?.text ?? '<!--markdown-->')}</textarea></label><label>状态<select name="status">${option('publish', '公开')}${option('draft', '草稿')}${option('private', '私密')}</select></label><label class="check"><input type="checkbox" name="allowComment" value="1"${row?.allowComment === '1' || !row ? ' checked' : ''}>允许评论</label><button type="submit">保存${noun}</button></form>`;
  return adminPage(`${row ? '编辑' : '新建'}${noun}`, request, body);
}

function adminPage(title: string, request: RequestContext, body: string): string {
  const root = escapeHtml(request.rootUrl);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Typecho</title><style>body{margin:0;background:#f6f8f9;color:#26333d;font:16px/1.6 system-ui,sans-serif}header{background:#fff;border-bottom:1px solid #e0e7e8;padding:16px max(24px,calc((100vw - 860px)/2))}header a,nav a{margin-right:18px;color:#257059}main{max-width:860px;margin:32px auto;padding:24px;background:#fff;border:1px solid #e2e8e8;border-radius:12px}h1{margin:0 0 22px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #e8eeee;padding:12px;text-align:left}td small{display:block;color:#788}form{display:grid;gap:16px}td form{display:block}label{display:grid;gap:7px}input,textarea,select{font:inherit;border:1px solid #cbd6d5;border-radius:6px;padding:9px}textarea{width:100%;resize:vertical;box-sizing:border-box}.check{display:flex;align-items:center}button{border:0;background:#257059;color:#fff;border-radius:6px;padding:9px 18px;cursor:pointer}.danger{background:#a64e49}nav{margin-top:20px}@media(max-width:900px){main{margin:16px;padding:16px}} </style></head><body><header><a href="${root}/admin/">后台</a><a href="${root}/admin/manage-posts.php">文章</a><a href="${root}/admin/manage-pages.php">页面</a><a href="${root}/">查看站点</a></header><main>${body}</main></body></html>`;
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
}
function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
}
function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
