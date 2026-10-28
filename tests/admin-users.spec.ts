import { compare } from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { handleAdminUsersRequest } from '../src/core/admin-users';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';

const base = 'https://example.test';
const secret = 'users-secret';
const authCode = 'abcdef0123456789abcdef0123456789';
type User = { uid: number; name: string; password: string; mail: string; screenName: string; group: string; authCode: string; created: number; activated: number; logged: number };
const user = (uid: number, name: string, group: string, password = 'old-hash'): User => ({ uid, name, group, password, mail: `${name}@example.test`, screenName: name, authCode: uid === 1 ? authCode : '', created: 0, activated: 0, logged: 0 });
const actor = user(1, 'admin', 'administrator');
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;

function fakeDb(initial: User[] = [actor, user(2, 'writer', 'editor')]) {
  const users = initial.map((row) => ({ ...row }));
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const contents = [{ authorId: 2 }];
  const comments = [{ ownerId: 2, authorId: 2 }];
  const options = [{ user: 2 }];
  const d1 = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) { params = values; return stmt; },
        async first() {
          if (sql.includes('COUNT(*) AS num')) return { num: users.filter((row) => row.group === 'administrator').length };
          if (sql.includes('WHERE (mail = ? OR name = ?)')) return users.find((row) => (row.mail === params[0] || row.name === params[1]) && row.uid !== params[2]) ?? null;
          if (sql.includes('WHERE uid = ?')) return users.find((row) => row.uid === Number(params[0])) ?? null;
          return null;
        },
        async all() { return { results: users.map((row) => ({ ...row })) }; },
        async run() {
          statements.push({ sql, params: [...params] });
          let changes = 0;
          if (sql.startsWith('INSERT INTO typecho_users')) {
            users.push({ uid: Math.max(...users.map((row) => row.uid)) + 1, name: String(params[0]), password: String(params[1]), mail: String(params[2]), screenName: String(params[4]), created: Number(params[5]), group: String(params[6]), authCode: String(params[7]), activated: 0, logged: 0 });
            changes = 1;
          } else if (sql.startsWith('UPDATE typecho_users')) {
            const target = users.find((row) => row.uid === Number(params.at(-1)));
            if (target && !(sql.includes('COUNT(*)') && users.filter((row) => row.group === 'administrator').length <= 1)) {
              if (sql.includes('"group" = ?')) { target.mail = String(params[0]); target.screenName = String(params[1]); target.group = String(params[2]); }
              else { target.mail = String(params[0]); target.screenName = String(params[1]); }
              if (sql.includes('password = ?')) {
                const offset = sql.includes('"group" = ?') ? 3 : 2;
                target.password = String(params[offset]); target.authCode = String(params[offset + 1]);
              }
              changes = 1;
            }
          } else if (sql.startsWith('DELETE FROM typecho_users')) {
            const index = users.findIndex((row) => row.uid === Number(params[0]));
            if (index !== -1 && !(users[index].group === 'administrator' && users.filter((row) => row.group === 'administrator').length <= 1)) { users.splice(index, 1); changes = 1; }
          } else if (sql.startsWith('UPDATE typecho_contents')) { for (const row of contents) if (row.authorId === params[1]) row.authorId = Number(params[0]); }
          else if (sql.startsWith('UPDATE typecho_comments SET ownerId')) { for (const row of comments) if (row.ownerId === params[1]) row.ownerId = Number(params[0]); }
          else if (sql.startsWith('UPDATE typecho_comments SET authorId')) { for (const row of comments) if (row.authorId === params[0]) row.authorId = 0; }
          else if (sql.startsWith('DELETE FROM typecho_options')) { for (let i = options.length - 1; i >= 0; i--) if (options[i].user === params[0]) options.splice(i, 1); }
          return { success: true, meta: { changes } };
        },
      };
      return stmt;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) { return Promise.all(statements.map((stmt) => stmt.run())); },
  } as unknown as D1Database;
  return { db: new Db(d1), users, statements, contents, comments, options };
}

function request(path: string, method: RequestInit = {}, sentCookie = cookie) {
  return buildRequestContext(new Request(`${base}${path}`, { ...method, headers: { cookie: sentCookie, ...method.headers } }));
}
function post(path: string, source: string, data: Record<string, string | string[]>, overrides: { token?: string; origin?: string; cookie?: string; referer?: string } = {}) {
  const form = new FormData();
  for (const [key, values] of Object.entries(data)) for (const value of Array.isArray(values) ? values : [values]) form.append(key, value);
  const reference = overrides.referer ?? `${base}${source}`;
  const token = overrides.token ?? securityToken(secret, `${base}${source}`, actor);
  return request(`${path}?_=${token}`, {
    method: 'POST', headers: { origin: overrides.origin ?? base, referer: reference }, body: form,
  }, overrides.cookie ?? cookie);
}
const handle = (db: Db, req: ReturnType<typeof request>) => handleAdminUsersRequest(db, req, secret);
const update = (uid = '2') => ({ do: 'update', uid, mail: 'new@example.test', screenName: 'New Name', group: 'editor', password: '', confirm: '' });

describe('后台用户管理', () => {
  it('保留无关路由，游客登录重定向，非管理员只能编辑自身资料', async () => {
    const { db, users } = fakeDb();
    expect(await handle(db, request('/no-such-route'))).toBeNull();
    expect((await handle(db, request('/admin/manage-users.php', {}, '')))?.headers.get('location')).toContain('/admin/login.php');
    users[0].group = 'editor';
    expect((await handle(db, request('/admin/user.php')))?.status).toBe(403);
    expect((await handle(db, post('/action/users-edit', '/admin/user.php', { do: 'delete', uid: '2' })))?.status).toBe(403);
    expect((await handle(db, request('/admin/profile.php')))?.status).toBe(200);
  });

  it('渲染转义后的列表、用户表单、个人资料，拒绝 GET 删除', async () => {
    const { db, users, statements } = fakeDb();
    users[1].screenName = '<script>alert(1)</script>';
    const listing = await handle(db, request('/admin/manage-users.php'));
    const markup = await listing?.text();
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).not.toContain('<script>alert(1)</script>');
    expect(markup).toContain('/admin/user.php?uid=2');
    expect(markup).toContain('method="post"');
    expect((await handle(db, request('/admin/user.php?uid=abc')))?.status).toBe(400);
    expect((await handle(db, request('/admin/user.php?uid=999')))?.status).toBe(404);
    expect(await (await handle(db, request('/admin/profile.php')))?.text()).toContain('当前密码');
    expect((await handle(db, request('/action/users-edit?do=delete&uid=2')))?.status).toBe(405);
    expect((await handle(db, request('/admin/manage-users.php', { method: 'POST' })))?.status).toBe(405);
    expect(statements).toEqual([]);
  });

  it('新增用户 bcrypt 密码，拒绝无效字段及重复邮箱和用户名', async () => {
    const { db, users } = fakeDb();
    const data = { do: 'insert', name: 'new_user', mail: 'new@example.test', screenName: '新用户', group: 'contributor', password: 'very-secure-password', confirm: 'very-secure-password' };
    expect((await handle(db, post('/action/users-edit', '/admin/user.php', data)))?.status).toBe(303);
    expect(users.at(-1)).toMatchObject({ name: 'new_user', group: 'contributor', authCode: '' });
    expect(await compare(data.password, users.at(-1)!.password)).toBe(true);
    expect((await handle(db, post('/action/users-edit', '/admin/user.php', data)))?.status).toBe(409);
    expect((await handle(db, post('/action/users-edit', '/admin/user.php', { ...data, name: 'evil<script>', mail: 'unused@example.test' })))?.status).toBe(400);
    expect((await handle(db, post('/action/users-edit', '/admin/user.php', { ...data, name: 'no-mail', mail: 'bad' })))?.status).toBe(400);
    expect((await handle(db, post('/action/users-edit', '/admin/user.php', { ...data, name: 'no-password', mail: 'other@example.test', password: 'short', confirm: 'short' })))?.status).toBe(400);
    expect((await handle(db, post('/action/users-edit', '/admin/user.php', { ...data, name: 'no-group', mail: 'another@example.test', group: 'root' })))?.status).toBe(400);
  });

  it('更新邮箱和权限并阻止降级最后一个管理员', async () => {
    const { db, users } = fakeDb();
    expect((await handle(db, post('/action/users-edit', '/admin/user.php?uid=2', update())))?.status).toBe(303);
    expect(users[1]).toMatchObject({ mail: 'new@example.test', screenName: 'New Name', group: 'editor' });
    const demote = { ...update('1'), group: 'editor', mail: 'admin@example.test' };
    expect((await handle(db, post('/action/users-edit', '/admin/user.php?uid=1', demote)))?.status).toBe(409);
    expect(users[0].group).toBe('administrator');
    users.push(user(3, 'otherAdmin', 'administrator'));
    expect((await handle(db, post('/action/users-edit', '/admin/user.php?uid=3', { ...update('3'), group: 'editor', mail: 'otherAdmin@example.test' })))?.status).toBe(303);
    expect(users[2].group).toBe('editor');
  });

  it('删除非本人账号并转移文章与评论，保护本人和最后管理员', async () => {
    const { db, users, contents, comments, options } = fakeDb();
    expect((await handle(db, post('/action/users-edit', '/admin/manage-users.php', { do: 'delete', uid: '1' })))?.status).toBe(409);
    expect((await handle(db, post('/action/users-edit', '/admin/manage-users.php', { do: 'delete', uid: '999' })))?.status).toBe(404);
    expect((await handle(db, post('/action/users-edit', '/admin/manage-users.php', { do: 'delete', 'uid[]': ['2'] })))?.status).toBe(303);
    expect(users.map((row) => row.uid)).toEqual([1]);
    expect(contents).toEqual([{ authorId: 1 }]);
    expect(comments).toEqual([{ ownerId: 1, authorId: 0 }]);
    expect(options).toEqual([]);
  });

  it('普通用户仅可更新自身邮箱和显示名称，不可修改用户组', async () => {
    const { db, users } = fakeDb();
    users[0].group = 'editor';
    const saved = await handle(db, post('/action/users-profile', '/admin/profile.php', {
      mail: 'editor@example.test', screenName: '编辑者', group: 'administrator', password: '', confirm: '',
    }));
    expect(saved?.status).toBe(303);
    expect(saved?.headers.get('location')).toContain('/admin/profile.php?saved=1');
    expect(users[0]).toMatchObject({ group: 'editor', mail: 'editor@example.test', screenName: '编辑者', authCode });
    expect((await handle(db, post('/action/users-profile', '/admin/profile.php', {
      mail: 'writer@example.test', screenName: '编辑者', password: '', confirm: '',
    })))?.status).toBe(409);
  });

  it('修改自己密码验证旧密码并清除 cookie、轮换 authCode 以使全部会话失效', async () => {
    const { db, users } = fakeDb();
    const profile = { mail: 'changed@example.test', screenName: 'Changed', oldPassword: 'old-password', password: 'new-password-123', confirm: 'new-password-123' };
    expect((await handle(db, post('/action/users-profile', '/admin/profile.php', profile)))?.status).toBe(403);
    users[0].password = typechoHash('old-password', 'abcdef123');
    const success = await handle(db, post('/action/users-profile', '/admin/profile.php', profile));
    expect(success?.status).toBe(303);
    expect(success?.headers.get('location')).toContain('/admin/login.php?password_changed=1');
    expect(success?.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(users[0].authCode).not.toBe(authCode);
    expect(await compare('new-password-123', users[0].password)).toBe(true);
    expect((await handle(db, request('/admin/profile.php')))?.headers.get('location')).toContain('/admin/login.php');
  });

  it('管理员重设其他账户密码后令其旧会话失效，不允许自己绕过旧密码', async () => {
    const { db, users } = fakeDb();
    const other = { ...update(), password: 'another-password-123', confirm: 'another-password-123' };
    expect((await handle(db, post('/action/users-edit', '/admin/user.php?uid=2', other)))?.status).toBe(303);
    expect(await compare(other.password, users[1].password)).toBe(true);
    expect(users[1].authCode).not.toBe('');
    expect((await handle(db, post('/action/users-edit', '/admin/user.php?uid=1', { ...update('1'), group: 'administrator', mail: actor.mail, password: 'another-password-123', confirm: 'another-password-123' })))?.status).toBe(403);
  });

  it('跨源、错误令牌、错误 Referer、非法动作均不能写入数据库', async () => {
    const { db, statements } = fakeDb();
    const data = { do: 'delete', uid: '2' };
    expect((await handle(db, post('/action/users-edit', '/admin/manage-users.php', data, { token: 'bad' })))?.status).toBe(403);
    expect((await handle(db, post('/action/users-edit', '/admin/manage-users.php', data, { origin: 'https://evil.test' })))?.status).toBe(403);
    expect((await handle(db, post('/action/users-edit', '/admin/manage-users.php', data, { referer: `${base}/admin/profile.php` })))?.status).toBe(403);
    expect((await handle(db, post('/action/users-edit', '/admin/manage-users.php', { do: 'unknown', uid: '2' })))?.status).toBe(400);
    expect((await handle(db, post('/action/users-profile', '/admin/user.php', { ...update(), oldPassword: '' })))?.status).toBe(403);
    expect(statements).toEqual([]);
  });
});
