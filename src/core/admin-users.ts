import { clearLoginCookies, findCurrentUser, hashPassword, securityToken, type AuthUser, typechoRandomString, verifyPassword } from './auth';
import { escapeHtml } from './common';
import type { Db } from './db';
import { currentRequestUrl, type RequestContext } from './request';

const groups = ['administrator', 'editor', 'contributor', 'visitor'] as const;
type Group = typeof groups[number];
type UserRow = AuthUser & { created: number; activated: number; logged: number };

export async function handleAdminUsersRequest(db: Db, request: RequestContext, secret: string): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  const pages = ['/admin/manage-users.php', '/admin/user.php', '/admin/profile.php'];
  const actions = ['/action/users-edit', '/action/users-profile'];
  if (!pages.includes(path) && !actions.includes(path)) return null;

  const actor = await findCurrentUser(db, request);
  if (!actor) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}`);
  if (path !== '/admin/profile.php' && path !== '/action/users-profile' && actor.group !== 'administrator') return text('Forbidden', 403);

  if (pages.includes(path)) {
    if (request.method !== 'GET') return text('Method Not Allowed', 405);
    if (path === '/admin/profile.php') return html(page('个人资料', request, profileForm(request, actor, secret)));
    if (path === '/admin/manage-users.php') {
      const users = await db.all<UserRow>('SELECT uid, name, mail, screenName, "group", created, activated, logged FROM table.users ORDER BY uid');
      return html(page('用户管理', request, usersList(request, actor, secret, users)));
    }
    const rawUid = request.query.get('uid');
    if (rawUid !== null && !positiveId(rawUid)) return text('Invalid user ID', 400);
    const selected = rawUid === null ? null : await db.first<UserRow>('SELECT uid, name, mail, screenName, "group", created, activated, logged FROM table.users WHERE uid = ?', [Number(rawUid)]);
    if (rawUid !== null && !selected) return text('User not found', 404);
    return html(page(selected ? '编辑用户' : '新增用户', request, userForm(request, actor, secret, selected)));
  }

  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  const form = await request.body?.();
  if (!form || !validCsrf(request, form, actor, secret, path)) return text('CSRF validation failed', 403);
  if (path === '/action/users-profile') return saveProfile(db, request, form, actor);
  const queryAction = request.query.get('do');
  const formAction = field(form, 'do');
  if (queryAction && formAction && queryAction !== formAction) return text('Conflicting action', 400);
  const action = queryAction ?? formAction;
  if (action === 'insert') return addUser(db, request, form);
  if (action === 'update') return updateUser(db, request, form, actor);
  if (action === 'delete') return deleteUsers(db, request, form, actor);
  return text('Invalid user action', 400);
}

function validCsrf(request: RequestContext, form: FormData, user: AuthUser, secret: string, path: string): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return false;
  if (!request.referer) return false;
  try {
    const source = new URL(request.referer);
    const base = new URL(request.rootUrl).pathname.replace(/\/+$/, '');
    const allowed = path === '/action/users-profile'
      ? [`${base}/admin/profile.php`]
      : [`${base}/admin/user.php`, `${base}/admin/manage-users.php`];
    if (source.origin !== request.url.origin || !allowed.includes(source.pathname)) return false;
  } catch {
    return false;
  }
  const queryToken = request.query.get('_');
  const formToken = field(form, '_');
  if (queryToken && formToken && queryToken !== formToken) return false;
  const token = queryToken ?? formToken ?? '';
  const expected = securityToken(secret, request.referer, user);
  if (token.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < token.length; index++) difference |= token.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function field(form: FormData, name: string): string | null {
  const values = form.getAll(name);
  return values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
}

function validMail(mail: string): boolean {
  return mail.length <= 150 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mail);
}

function validName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,32}$/.test(name);
}

function validScreenName(name: string): boolean {
  return !!name && Array.from(name).length <= 32 && !/[<>\u0000-\u001f\u007f]/u.test(name);
}

function validPassword(password: string): boolean {
  const length = new TextEncoder().encode(password).length;
  return password.length >= 8 && length <= 72;
}

function passwordFrom(form: FormData, required: boolean): string | Response | null {
  const password = field(form, 'password');
  const confirm = field(form, 'confirm');
  if (password === null || confirm === null) return text('Invalid password fields', 400);
  if (!password && !confirm && !required) return null;
  if (!validPassword(password)) return text('Password must contain at least 8 characters and at most 72 UTF-8 bytes', 400);
  if (password !== confirm) return text('Passwords do not match', 400);
  return password;
}

async function uniqueUser(db: Db, mail: string, name: string | null, uid: number): Promise<boolean> {
  const other = await db.first<{ uid: number }>(
    'SELECT uid FROM table.users WHERE (mail = ? OR name = ?) AND uid != ? LIMIT 1', [mail, name ?? '', uid]
  );
  return !other;
}

async function addUser(db: Db, request: RequestContext, form: FormData): Promise<Response> {
  const name = field(form, 'name')?.trim() ?? '';
  const mail = field(form, 'mail')?.trim() ?? '';
  const screenName = field(form, 'screenName')?.trim() ?? '';
  const group = field(form, 'group');
  const password = passwordFrom(form, true);
  if (password instanceof Response) return password;
  if (!validName(name) || !validMail(mail) || !validScreenName(screenName) || !groups.includes(group as Group)) return text('Invalid user information', 400);
  if (!await uniqueUser(db, mail, name, 0)) return text('Username or email is already in use', 409);
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.run('INSERT INTO table.users (name, password, mail, url, screenName, created, activated, logged, "group", authCode) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)',
      [name, await hashPassword(password!), mail, '', screenName, now, group, '']);
  } catch (error) {
    if (String(error).includes('UNIQUE')) return text('Username or email is already in use', 409);
    throw error;
  }
  return redirect(`${request.rootUrl}/admin/manage-users.php?saved=1`);
}

async function updateUser(db: Db, request: RequestContext, form: FormData, actor: AuthUser): Promise<Response> {
  const rawUid = field(form, 'uid');
  if (!rawUid || !positiveId(rawUid)) return text('Invalid user ID', 400);
  const uid = Number(rawUid);
  const target = await db.first<UserRow>('SELECT uid, name, password, mail, screenName, "group", authCode FROM table.users WHERE uid = ?', [uid]);
  if (!target) return text('User not found', 404);
  const mail = field(form, 'mail')?.trim() ?? '';
  const screenName = field(form, 'screenName')?.trim() ?? '';
  const group = field(form, 'group');
  if (!validMail(mail) || !validScreenName(screenName) || !groups.includes(group as Group)) return text('Invalid user information', 400);
  const password = passwordFrom(form, false);
  if (password instanceof Response) return password;
  if (!await uniqueUser(db, mail, null, uid)) return text('Email is already in use', 409);
  if (target.group === 'administrator' && group !== 'administrator') {
    const count = await db.count('SELECT COUNT(*) AS num FROM table.users WHERE "group" = ?', ['administrator']);
    if (count <= 1) return text('Cannot remove the last administrator', 409);
  }
  if (uid === actor.uid && password && !await verifyPassword(field(form, 'oldPassword') ?? '', actor.password)) {
    return text('Current password is incorrect', 403);
  }
  const guard = target.group === 'administrator' && group !== 'administrator'
    ? ' AND (SELECT COUNT(*) FROM table.users WHERE "group" = \'administrator\') > 1' : '';
  try {
    const result = password
      ? await db.run(`UPDATE table.users SET mail = ?, screenName = ?, "group" = ?, password = ?, authCode = ? WHERE uid = ?${guard}`,
        [mail, screenName, group, await hashPassword(password), typechoRandomString(32), uid])
      : await db.run(`UPDATE table.users SET mail = ?, screenName = ?, "group" = ? WHERE uid = ?${guard}`,
        [mail, screenName, group, uid]);
    if (result.meta?.changes === 0) return text('Cannot remove the last administrator', 409);
  } catch (error) {
    if (String(error).includes('UNIQUE')) return text('Email is already in use', 409);
    throw error;
  }
  if (uid === actor.uid && password) return passwordChanged(request);
  if (uid === actor.uid && group !== 'administrator') return redirect(`${request.rootUrl}/admin/profile.php?saved=1`);
  return redirect(`${request.rootUrl}/admin/manage-users.php?saved=1`);
}

async function saveProfile(db: Db, request: RequestContext, form: FormData, actor: AuthUser): Promise<Response> {
  const mail = field(form, 'mail')?.trim() ?? '';
  const screenName = field(form, 'screenName')?.trim() ?? '';
  if (!validMail(mail) || !validScreenName(screenName)) return text('Invalid profile information', 400);
  const password = passwordFrom(form, false);
  if (password instanceof Response) return password;
  if (!await uniqueUser(db, mail, null, actor.uid)) return text('Email is already in use', 409);
  if (password && !await verifyPassword(field(form, 'oldPassword') ?? '', actor.password)) return text('Current password is incorrect', 403);
  try {
    if (password) {
      await db.run('UPDATE table.users SET mail = ?, screenName = ?, password = ?, authCode = ? WHERE uid = ?',
        [mail, screenName, await hashPassword(password), typechoRandomString(32), actor.uid]);
    } else {
      await db.run('UPDATE table.users SET mail = ?, screenName = ? WHERE uid = ?', [mail, screenName, actor.uid]);
    }
  } catch (error) {
    if (String(error).includes('UNIQUE')) return text('Email is already in use', 409);
    throw error;
  }
  return password ? passwordChanged(request) : redirect(`${request.rootUrl}/admin/profile.php?saved=1`);
}

function passwordChanged(request: RequestContext): Response {
  const headers = new Headers({ location: `${request.rootUrl}/admin/login.php?password_changed=1` });
  for (const cookie of clearLoginCookies(request.rootUrl, request.isSecure)) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

async function deleteUsers(db: Db, request: RequestContext, form: FormData, actor: AuthUser): Promise<Response> {
  const submitted = [...form.getAll('uid[]'), ...form.getAll('uid')];
  if (!submitted.length || submitted.length > 50 || submitted.some((value) => typeof value !== 'string' || !positiveId(value))) {
    return text('Invalid user ID', 400);
  }
  const ids = [...new Set(submitted.map(Number))];
  if (ids.includes(actor.uid)) return text('Cannot delete your own account', 409);
  const targets = await Promise.all(ids.map((uid) => db.first<{ uid: number; group: string }>('SELECT uid, "group" FROM table.users WHERE uid = ?', [uid])));
  if (targets.some((target) => !target)) return text('User not found', 404);
  const administrators = targets.filter((target) => target!.group === 'administrator').length;
  if (administrators) {
    const count = await db.count('SELECT COUNT(*) AS num FROM table.users WHERE "group" = ?', ['administrator']);
    if (count - administrators < 1) return text('Cannot delete the last administrator', 409);
  }
  for (const uid of ids) {
    const results = await db.batch([
      { sql: 'UPDATE table.contents SET authorId = ? WHERE authorId = ?', params: [actor.uid, uid] },
      { sql: 'UPDATE table.comments SET ownerId = ? WHERE ownerId = ?', params: [actor.uid, uid] },
      { sql: 'UPDATE table.comments SET authorId = 0 WHERE authorId = ?', params: [uid] },
      { sql: 'DELETE FROM table.options WHERE "user" = ?', params: [uid] },
      { sql: 'DELETE FROM table.users WHERE uid = ? AND ("group" != \'administrator\' OR (SELECT COUNT(*) FROM table.users WHERE "group" = \'administrator\') > 1)', params: [uid] },
    ]);
    if (results.at(-1)?.meta?.changes === 0) return text('Cannot delete the last administrator', 409);
  }
  return redirect(`${request.rootUrl}/admin/manage-users.php?deleted=1`);
}

function positiveId(value: string): boolean { return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)); }

function usersList(request: RequestContext, actor: AuthUser, secret: string, users: UserRow[]): string {
  const root = escapeHtml(request.rootUrl);
  const action = `${root}/action/users-edit?_=${securityToken(secret, currentRequestUrl(request), actor)}`;
  const entries = users.map((user) => {
    const control = user.uid === actor.uid ? '当前用户' : `<form method="post" action="${action}"><input type="hidden" name="do" value="delete"><input type="hidden" name="uid" value="${user.uid}"><button type="submit">删除</button></form>`;
    return `<tr><td><a href="${root}/admin/user.php?uid=${user.uid}">${escapeHtml(user.name)}</a></td><td>${escapeHtml(user.screenName || '')}</td><td>${escapeHtml(user.mail || '')}</td><td>${escapeHtml(user.group)}</td><td>${control}</td></tr>`;
  }).join('');
  return `<h1>用户管理</h1>${notice(request)}<p><a href="${root}/admin/user.php">新增用户</a></p><table><thead><tr><th>用户名</th><th>显示名称</th><th>邮箱</th><th>用户组</th><th>操作</th></tr></thead><tbody>${entries || '<tr><td colspan="5">暂无用户</td></tr>'}</tbody></table>`;
}

function userForm(request: RequestContext, actor: AuthUser, secret: string, selected: UserRow | null): string {
  const root = escapeHtml(request.rootUrl);
  const action = `${root}/action/users-edit?_=${securityToken(secret, currentRequestUrl(request), actor)}`;
  const options = groups.map((group) => `<option value="${group}"${(selected?.group ?? 'contributor') === group ? ' selected' : ''}>${group}</option>`).join('');
  const own = selected?.uid === actor.uid;
  return `<h1>${selected ? '编辑用户' : '新增用户'}</h1><form method="post" action="${action}"><input type="hidden" name="do" value="${selected ? 'update' : 'insert'}">${selected ? `<input type="hidden" name="uid" value="${selected.uid}"><p>用户名：${escapeHtml(selected.name)}</p>` : '<label>用户名<input name="name" maxlength="32" required autocomplete="off"></label>'}<label>显示名称<input name="screenName" maxlength="32" required value="${escapeHtml(selected?.screenName ?? '')}"></label><label>邮箱<input name="mail" type="email" maxlength="150" required value="${escapeHtml(selected?.mail ?? '')}"></label><label>用户组<select name="group">${options}</select></label>${own ? '<label>当前密码（修改密码时必填）<input name="oldPassword" type="password" autocomplete="current-password"></label>' : ''}<label>${selected ? '新密码（留空不修改）' : '密码'}<input name="password" type="password" ${selected ? '' : 'required'} autocomplete="new-password"></label><label>确认密码<input name="confirm" type="password" ${selected ? '' : 'required'} autocomplete="new-password"></label><button type="submit">保存用户</button></form><p><a href="${root}/admin/manage-users.php">返回用户管理</a></p>`;
}

function profileForm(request: RequestContext, actor: AuthUser, secret: string): string {
  const root = escapeHtml(request.rootUrl);
  const action = `${root}/action/users-profile?_=${securityToken(secret, currentRequestUrl(request), actor)}`;
  return `<h1>个人资料</h1>${notice(request)}<p>用户名：${escapeHtml(actor.name)}</p><form method="post" action="${action}"><label>显示名称<input name="screenName" maxlength="32" required value="${escapeHtml(actor.screenName || '')}"></label><label>邮箱<input name="mail" type="email" maxlength="150" required value="${escapeHtml(actor.mail || '')}"></label><label>当前密码（修改密码时必填）<input name="oldPassword" type="password" autocomplete="current-password"></label><label>新密码（留空不修改）<input name="password" type="password" autocomplete="new-password"></label><label>确认新密码<input name="confirm" type="password" autocomplete="new-password"></label><button type="submit">保存资料</button></form>`;
}

function notice(request: RequestContext): string {
  if (request.query.has('saved')) return '<p role="status">保存成功。</p>';
  if (request.query.has('deleted')) return '<p role="status">删除成功。</p>';
  return '';
}

function page(title: string, request: RequestContext, body: string): string {
  const root = escapeHtml(request.rootUrl);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Typecho</title><style>body{margin:0;background:#f6f8f9;color:#26333d;font:16px/1.6 system-ui,sans-serif}header{background:#fff;border-bottom:1px solid #e0e7e8;padding:16px max(24px,calc((100vw - 860px)/2))}a{color:#257059;margin-right:16px}main{max-width:860px;margin:32px auto;padding:24px;background:#fff;border:1px solid #e2e8e8;border-radius:12px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #e8eeee;padding:12px;text-align:left}form{display:grid;gap:12px}td form{display:inline}label{display:grid;gap:7px}input,select{font:inherit;border:1px solid #cbd6d5;border-radius:6px;padding:9px}button{border:0;background:#257059;color:#fff;border-radius:6px;padding:9px 14px;cursor:pointer}@media(max-width:900px){main{margin:16px;padding:16px}table{display:block;overflow-x:auto}}</style></head><body><header><a href="${root}/admin/">后台</a><a href="${root}/admin/manage-users.php">用户管理</a><a href="${root}/admin/profile.php">个人资料</a><a href="${root}/">查看站点</a></header><main>${body}</main></body></html>`;
}
function html(body: string): Response { return new Response(body, { headers: { 'content-type': 'text/html; charset=UTF-8' } }); }
function text(message: string, status: number): Response { return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } }); }
function redirect(location: string): Response { return new Response(null, { status: 303, headers: { location } }); }
