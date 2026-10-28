import { escapeHtml } from './common';
import { findCurrentUser, securityToken, type AuthUser } from './auth';
import type { Db } from './db';
import { currentRequestUrl, type RequestContext } from './request';

type MetaType = 'category' | 'tag';

interface MetaRow {
  mid: number;
  name: string;
  slug: string;
  type: MetaType;
  description: string | null;
  count: number;
  order: number;
  parent: number;
}

export async function handleAdminMetasRequest(db: Db, request: RequestContext, secret: string): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  const type: MetaType | null = path === '/admin/manage-categories.php' || path === '/admin/category.php' || path === '/action/metas-category-edit'
    ? 'category' : path === '/admin/manage-tags.php' || path === '/action/metas-tag-edit' ? 'tag' : null;
  if (!type) return null;

  const user = await findCurrentUser(db, request);
  if (!user) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}`);
  if (user.group !== 'administrator') return text('Forbidden', 403);

  if (path.startsWith('/admin/')) {
    if (request.method !== 'GET') return text('Method Not Allowed', 405);
    const rows = await db.all<MetaRow>(
      'SELECT mid, name, slug, type, description, count, "order", parent FROM table.metas WHERE type = ? ORDER BY "order", mid',
      [type]
    );
    if (path === '/admin/category.php') {
      const mid = request.query.get('mid');
      if (mid !== null && !positiveId(mid)) return text('Invalid category ID.', 400);
      const current = mid === null ? null : rows.find((row) => row.mid === Number(mid));
      if (mid !== null && !current) return text('Category not found.', 404);
      const rawParent = request.query.get('parent');
      if (rawParent !== null && (!nonnegativeId(rawParent) || (Number(rawParent) !== 0 && !rows.some((row) => row.mid === Number(rawParent))))) {
        return text('Parent category not found.', 404);
      }
      return html(page('分类', request, categoryEditor(request, user, secret, rows, current ?? null, Number(rawParent ?? '0'))));
    }
    if (type === 'category') {
      const rawParent = request.query.get('parent');
      if (rawParent !== null && (!nonnegativeId(rawParent) || (Number(rawParent) !== 0 && !rows.some((row) => row.mid === Number(rawParent))))) {
        return text('Parent category not found.', 404);
      }
      const defaultMid = await getDefaultCategoryId(db);
      return html(page('分类管理', request, categoryList(request, user, secret, rows, Number(rawParent ?? '0'), defaultMid)));
    }
    const mid = request.query.get('mid');
    if (mid !== null && !positiveId(mid)) return text('Invalid tag ID.', 400);
    const current = mid === null ? null : rows.find((row) => row.mid === Number(mid));
    if (mid !== null && !current) return text('Tag not found.', 404);
    return html(page('标签管理', request, tagList(request, user, secret, rows, current ?? null)));
  }

  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  const form = await request.body?.();
  if (!form || !validCsrf(request, form, user, secret, type)) return text('CSRF validation failed', 403);
  const queryAction = request.query.get('do');
  const formAction = form.get('do');
  if (queryAction && formAction && queryAction !== formAction) return text('Conflicting action.', 400);
  const action = queryAction ?? formAction;
  if (action === 'insert' || action === 'update') return saveMeta(db, request, form, type, action);
  if (action === 'delete') return deleteMetas(db, request, form, type);
  if (action === 'default' && type === 'category') return setDefaultCategory(db, request, form);
  return text('Unsupported metadata action.', 400);
}

function validCsrf(request: RequestContext, form: FormData, user: AuthUser, secret: string, type: MetaType): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return false;
  if (!request.referer) return false;
  try {
    const source = new URL(request.referer);
    if (source.origin !== request.url.origin) return false;
    const categorySource = source.pathname.endsWith('/admin/category.php') || source.pathname.endsWith('/admin/manage-categories.php');
    const tagSource = source.pathname.endsWith('/admin/manage-tags.php');
    if (type === 'category' ? !categorySource : !tagSource) return false;
  } catch {
    return false;
  }
  const token = request.query.get('_') ?? (typeof form.get('_') === 'string' ? String(form.get('_')) : '');
  const expected = securityToken(secret, request.referer, user);
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

async function saveMeta(db: Db, request: RequestContext, form: FormData, type: MetaType, action: 'insert' | 'update'): Promise<Response> {
  const noun = type === 'category' ? '分类' : '标签';
  const rawMid = form.get('mid');
  if (action === 'update' && (typeof rawMid !== 'string' || !positiveId(rawMid))) return text(`无效的${noun} ID。`, 400);
  const mid = action === 'update' ? Number(rawMid) : 0;
  const nameValue = form.get('name');
  const slugValue = form.get('slug');
  if (typeof nameValue !== 'string' || (slugValue !== null && typeof slugValue !== 'string')) return text(`无效的${noun}名称或缩略名。`, 400);
  const name = nameValue.trim();
  const slug = slugName(slugValue?.trim() || name);
  if (!name || Array.from(name).length > 150 || /[<>\u0000-\u001f]/u.test(name)) return text(`${noun}名称不能为空、包含特殊字符或超过 150 字。`, 400);
  if (!slug || Array.from(slug).length > 128) return text(`${noun}缩略名无效或超过 128 字。`, 400);
  let description = '';
  let parent = 0;
  if (type === 'category') {
    const descriptionValue = form.get('description');
    const parentValue = form.get('parent');
    if (descriptionValue !== null && typeof descriptionValue !== 'string') return text('分类描述无效。', 400);
    description = (descriptionValue ?? '').trim();
    if (Array.from(description).length > 150) return text('分类描述不能超过 150 字。', 400);
    if (parentValue !== null && (typeof parentValue !== 'string' || !nonnegativeId(parentValue))) return text('父级分类无效。', 400);
    parent = Number(parentValue ?? '0');
  }
  const current = mid ? await db.first<MetaRow>('SELECT * FROM table.metas WHERE mid = ? AND type = ?', [mid, type]) : null;
  if (mid && !current) return text(`${noun}不存在。`, 404);
  if (parent) {
    const seen = new Set([mid]);
    let cursor = parent;
    while (cursor) {
      if (seen.has(cursor)) return text('不能将分类移入自身或子分类。', 400);
      seen.add(cursor);
      const ancestor = await db.first<{ parent: number }>('SELECT parent FROM table.metas WHERE mid = ? AND type = ?', [cursor, 'category']);
      if (!ancestor) return text('父级分类不存在。', 404);
      cursor = Number(ancestor.parent);
    }
  }
  const conflict = await db.first<{ mid: number }>(
    'SELECT mid FROM table.metas WHERE type = ? AND slug = ? AND mid != ? LIMIT 1', [type, slug, mid]
  );
  if (conflict) return text('缩略名已经存在。', 409);
  const duplicate = await db.first<{ mid: number }>(
    'SELECT mid FROM table.metas WHERE type = ? AND name = ? AND parent = ? AND mid != ? LIMIT 1', [type, name, parent, mid]
  );
  if (duplicate) return text(`${noun}名称已经存在。`, 409);
  if (mid) {
    const order = type === 'category' && current?.parent !== parent
      ? Number((await db.first<{ maxOrder: number }>('SELECT MAX("order") AS maxOrder FROM table.metas WHERE type = ? AND parent = ?', [type, parent]))?.maxOrder ?? 0) + 1
      : Number(current?.order ?? 0);
    await db.run('UPDATE table.metas SET name = ?, slug = ?, description = ?, parent = ?, "order" = ? WHERE mid = ? AND type = ?',
      [name, slug, description, parent, order, mid, type]);
  } else {
    const order = type === 'category'
      ? Number((await db.first<{ maxOrder: number }>('SELECT MAX("order") AS maxOrder FROM table.metas WHERE type = ? AND parent = ?', [type, parent]))?.maxOrder ?? 0) + 1
      : 0;
    await db.run('INSERT INTO table.metas (name, slug, type, description, count, "order", parent) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [name, slug, type, description, order, parent]);
  }
  const list = type === 'category' ? 'manage-categories.php' : 'manage-tags.php';
  return redirect(`${request.rootUrl}/admin/${list}${type === 'category' && parent ? `?parent=${parent}&saved=1` : '?saved=1'}`);
}

async function deleteMetas(db: Db, request: RequestContext, form: FormData, type: MetaType): Promise<Response> {
  const rawIds = [...form.getAll('mid[]'), ...form.getAll('mid')];
  if (!rawIds.length || rawIds.some((id) => typeof id !== 'string' || !positiveId(id))) return text('请选择有效的分类或标签。', 400);
  const ids = [...new Set(rawIds.map(Number))];
  const rows = await db.all<MetaRow>('SELECT mid, name, slug, type, description, count, "order", parent FROM table.metas WHERE type = ?', [type]);
  const byId = new Map(rows.map((row) => [row.mid, row]));
  if (ids.some((id) => !byId.has(id))) return text('分类或标签不存在。', 404);
  if (type === 'category') {
    const defaultMid = await getDefaultCategoryId(db);
    const fallback = rows.reduce((smallest, row) => Math.min(smallest, row.mid), Infinity);
    if (ids.includes(defaultMid ?? fallback)) return text('不能删除默认分类，请先设置其他默认分类。', 409);
    ids.sort((a, b) => {
      const depth = (mid: number) => {
        let current = byId.get(mid)?.parent ?? 0;
        const seen = new Set([mid]);
        while (current && !seen.has(current)) { seen.add(current); current = byId.get(current)?.parent ?? 0; }
        return seen.size;
      };
      return depth(b) - depth(a);
    });
  }
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  for (const mid of ids) {
    if (type === 'category') {
      statements.push({ sql: "UPDATE table.metas SET parent = ? WHERE parent = ? AND type = 'category'", params: [byId.get(mid)!.parent, mid] });
    }
    statements.push({ sql: 'DELETE FROM table.relationships WHERE mid = ?', params: [mid] });
    statements.push({ sql: 'DELETE FROM table.metas WHERE mid = ? AND type = ?', params: [mid, type] });
  }
  await db.batch(statements);
  return redirect(`${request.rootUrl}/admin/manage-${type === 'category' ? 'categories' : 'tags'}.php?deleted=1`);
}

async function getDefaultCategoryId(db: Db): Promise<number | null> {
  const option = await db.first<{ value: string }>("SELECT value FROM table.options WHERE name = 'defaultCategory' AND \"user\" = 0");
  if (option && positiveId(option.value)) return Number(option.value);
  const first = await db.first<{ mid: number }>("SELECT mid FROM table.metas WHERE type = 'category' ORDER BY mid LIMIT 1");
  return first?.mid ?? null;
}

async function setDefaultCategory(db: Db, request: RequestContext, form: FormData): Promise<Response> {
  const mid = form.get('mid');
  if (typeof mid !== 'string' || !positiveId(mid)) return text('无效的分类 ID。', 400);
  const row = await db.first<{ mid: number }>('SELECT mid FROM table.metas WHERE mid = ? AND type = ?', [Number(mid), 'category']);
  if (!row) return text('分类不存在。', 404);
  await db.run('INSERT INTO table.options (name, "user", value) VALUES (?, 0, ?) ON CONFLICT(name, "user") DO UPDATE SET value = excluded.value',
    ['defaultCategory', mid]);
  return redirect(`${request.rootUrl}/admin/manage-categories.php?default=1`);
}

function categoryList(request: RequestContext, user: AuthUser, secret: string, rows: MetaRow[], parent: number, defaultMid: number | null): string {
  const children = rows.filter((row) => row.parent === parent);
  const title = parent ? `${rows.find((row) => row.mid === parent)?.name ?? ''} 的子分类` : '分类管理';
  const source = currentRequestUrl(request);
  const action = escapeHtml(`${request.rootUrl}/action/metas-category-edit?_=${securityToken(secret, source, user)}`);
  const entries = children.map((row) => {
    const count = rows.filter((item) => item.parent === row.mid).length;
    const sub = count ? `<a href="${escapeHtml(request.rootUrl)}/admin/manage-categories.php?parent=${row.mid}">${count} 个子分类</a>` : `<a href="${escapeHtml(request.rootUrl)}/admin/category.php?parent=${row.mid}">新增子分类</a>`;
    const defaultControl = row.mid === defaultMid ? '默认' : `<form method="post" action="${action}"><input type="hidden" name="do" value="default"><input type="hidden" name="mid" value="${row.mid}"><button type="submit">设为默认</button></form>`;
    const deleteControl = row.mid === defaultMid ? '默认分类不可删除' : `<form method="post" action="${action}"><input type="hidden" name="do" value="delete"><input type="hidden" name="mid[]" value="${row.mid}"><button type="submit" class="danger">删除</button></form>`;
    return `<tr><td><a href="${escapeHtml(request.rootUrl)}/admin/category.php?mid=${row.mid}">${escapeHtml(row.name)}</a></td><td>${escapeHtml(row.slug)}</td><td>${sub}</td><td>${Number(row.count) || 0}</td><td>${defaultControl}</td><td>${deleteControl}</td></tr>`;
  }).join('');
  const back = parent ? `<a href="${escapeHtml(request.rootUrl)}/admin/manage-categories.php${rows.find((row) => row.mid === parent)?.parent ? `?parent=${rows.find((row) => row.mid === parent)?.parent}` : ''}">返回上级分类</a>` : '';
  return `<h1>${escapeHtml(title)}</h1>${notice(request)}<p><a href="${escapeHtml(request.rootUrl)}/admin/category.php${parent ? `?parent=${parent}` : ''}">新增分类</a> ${back}</p><table><thead><tr><th>名称</th><th>缩略名</th><th>子分类</th><th>文章数</th><th>默认分类</th><th>操作</th></tr></thead><tbody>${entries || '<tr><td colspan="6">没有任何分类</td></tr>'}</tbody></table>`;
}

function categoryEditor(request: RequestContext, user: AuthUser, secret: string, rows: MetaRow[], current: MetaRow | null, parent: number): string {
  const source = currentRequestUrl(request);
  const action = escapeHtml(`${request.rootUrl}/action/metas-category-edit?_=${securityToken(secret, source, user)}`);
  const selectedParent = current?.parent ?? parent;
  const options = rows.filter((row) => {
    if (!current) return true;
    const seen = new Set<number>();
    let cursor = row.mid;
    while (cursor && !seen.has(cursor)) { if (cursor === current.mid) return false; seen.add(cursor); cursor = rows.find((item) => item.mid === cursor)?.parent ?? 0; }
    return true;
  }).map((row) => `<option value="${row.mid}"${row.mid === selectedParent ? ' selected' : ''}>${escapeHtml(row.name)}</option>`).join('');
  return `<h1>${current ? '编辑分类' : '新增分类'}</h1><form method="post" action="${action}"><input type="hidden" name="do" value="${current ? 'update' : 'insert'}"><input type="hidden" name="mid" value="${current?.mid ?? ''}"><label>分类名称<input required maxlength="150" name="name" value="${escapeHtml(current?.name ?? '')}"></label><label>分类缩略名<input maxlength="128" name="slug" value="${escapeHtml(current?.slug ?? '')}" placeholder="留空按名称生成"></label><label>父级分类<select name="parent"><option value="0">不选择</option>${options}</select></label><label>分类描述<textarea name="description" maxlength="150" rows="4">${escapeHtml(current?.description ?? '')}</textarea></label><button type="submit">${current ? '编辑分类' : '增加分类'}</button></form><p><a href="${escapeHtml(request.rootUrl)}/admin/manage-categories.php">返回分类管理</a></p>`;
}

function tagList(request: RequestContext, user: AuthUser, secret: string, rows: MetaRow[], current: MetaRow | null): string {
  const action = escapeHtml(`${request.rootUrl}/action/metas-tag-edit?_=${securityToken(secret, currentRequestUrl(request), user)}`);
  const entries = rows.map((row) => `<tr><td><a href="${escapeHtml(request.rootUrl)}/admin/manage-tags.php?mid=${row.mid}">${escapeHtml(row.name)}</a></td><td>${escapeHtml(row.slug)}</td><td>${Number(row.count) || 0}</td><td><form method="post" action="${action}"><input type="hidden" name="do" value="delete"><input type="hidden" name="mid[]" value="${row.mid}"><button type="submit" class="danger">删除</button></form></td></tr>`).join('');
  const editor = `<h2>${current ? '编辑标签' : '新增标签'}</h2><form method="post" action="${action}"><input type="hidden" name="do" value="${current ? 'update' : 'insert'}"><input type="hidden" name="mid" value="${current?.mid ?? ''}"><label>标签名称<input required maxlength="150" name="name" value="${escapeHtml(current?.name ?? '')}"></label><label>标签缩略名<input maxlength="128" name="slug" value="${escapeHtml(current?.slug ?? '')}" placeholder="留空按名称生成"></label><button type="submit">${current ? '编辑标签' : '增加标签'}</button></form>${current ? `<p><a href="${escapeHtml(request.rootUrl)}/admin/manage-tags.php">取消编辑</a></p>` : ''}`;
  return `<h1>标签管理</h1>${notice(request)}<table><thead><tr><th>名称</th><th>缩略名</th><th>文章数</th><th>操作</th></tr></thead><tbody>${entries || '<tr><td colspan="4">没有任何标签</td></tr>'}</tbody></table>${editor}`;
}

function slugName(value: string): string {
  return (value.normalize('NFC').match(/[\p{L}\p{N}_-]+/gu) ?? []).join('-').replace(/^[-_]+|[-_]+$/g, '');
}
function positiveId(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}
function nonnegativeId(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
}
function notice(request: RequestContext): string {
  if (request.query.has('saved')) return '<p role="status">保存成功。</p>';
  if (request.query.has('deleted')) return '<p role="status">删除成功。</p>';
  if (request.query.has('default')) return '<p role="status">默认分类已更新。</p>';
  return '';
}
function page(title: string, request: RequestContext, body: string): string {
  const root = escapeHtml(request.rootUrl);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Typecho</title><style>body{margin:0;background:#f6f8f9;color:#26333d;font:16px/1.6 system-ui,sans-serif}header{background:#fff;border-bottom:1px solid #e0e7e8;padding:16px max(24px,calc((100vw - 860px)/2))}header a{margin-right:18px}a{color:#257059}main{max-width:860px;margin:32px auto;padding:24px;background:#fff;border:1px solid #e2e8e8;border-radius:12px}h1{margin:0 0 22px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #e8eeee;padding:12px;text-align:left}form{display:grid;gap:12px}td form{display:inline}label{display:grid;gap:7px}input,textarea,select{font:inherit;border:1px solid #cbd6d5;border-radius:6px;padding:9px}button{border:0;background:#257059;color:#fff;border-radius:6px;padding:9px 14px;cursor:pointer}.danger{background:#a64e49}@media(max-width:900px){main{margin:16px;padding:16px}}</style></head><body><header><a href="${root}/admin/">后台</a><a href="${root}/admin/manage-posts.php">文章</a><a href="${root}/admin/manage-categories.php">分类</a><a href="${root}/admin/manage-tags.php">标签</a><a href="${root}/">查看站点</a></header><main>${body}</main></body></html>`;
}
function html(body: string): Response { return new Response(body, { headers: { 'content-type': 'text/html; charset=UTF-8' } }); }
function text(message: string, status: number): Response { return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } }); }
function redirect(location: string): Response { return new Response(null, { status: 303, headers: { location } }); }
