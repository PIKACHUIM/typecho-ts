import { describe, expect, it } from 'vitest';
import { cookiePrefix, createLoginCookies, findCurrentUser, hashPassword, passwordNeedsRehash, securityToken, type AuthUser, typechoHash, verifyPassword } from '../src/core/auth';
import { Db } from '../src/core/db';
import { handleAuthRequest } from '../src/core/install-auth';
import { SiteOptions } from '../src/core/options';
import { buildRequestContext, currentRequestUrl } from '../src/core/request';

const root = 'https://example.test';
const secret = 'site-secret';

function mockDb(password: string) {
  const user: AuthUser = {
    uid: 7, name: 'owner', password, mail: 'owner@example.test',
    screenName: 'Owner', group: 'administrator', authCode: '',
  };
  const updates: string[] = [];
  const d1 = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() {
          if (sql.includes('WHERE name = ?')) return statement.params[0] === user.name ? { ...user } : null;
          if (sql.includes('WHERE mail = ?')) return statement.params[0] === user.mail ? { ...user } : null;
          if (sql.includes('WHERE uid = ?')) return statement.params[0] === user.uid ? { ...user } : null;
          return null;
        },
        async run() {
          updates.push(sql);
          if (sql.includes('SET password =')) user.password = String(statement.params[0]);
          if (sql.includes('SET logged =')) user.authCode = String(statement.params[1]);
          if (sql.includes("SET authCode = ''")) user.authCode = '';
          return { success: true, meta: {} };
        },
        async all() { return { results: [] }; },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db: new Db(d1), user, updates };
}

function cookieHeader(headers: Headers): string {
  const prefix = cookiePrefix(root);
  const value = headers.get('set-cookie') ?? '';
  const uid = new RegExp(`${prefix}__typecho_uid=([^;,]+)`).exec(value)?.[1];
  const auth = new RegExp(`${prefix}__typecho_authCode=([^;,]+)`).exec(value)?.[1];
  expect(uid).toBeTruthy();
  expect(auth).toBeTruthy();
  return `${prefix}__typecho_uid=${uid}; ${prefix}__typecho_authCode=${auth}`;
}

async function loginPage(db: Db, referer = `${root}/admin/`) {
  const pageUrl = `${root}/admin/login.php?referer=${encodeURIComponent(referer)}`;
  const response = await handleAuthRequest(db, buildRequestContext(new Request(pageUrl)), secret);
  const html = await response!.text();
  const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1];
  expect(action).toBeTruthy();
  return { html, pageUrl, action: action! };
}

async function loginPost(db: Db, pageUrl: string, action: string, name: string, password: string, referer = `${root}/admin/`) {
  const form = new FormData();
  form.set('name', name);
  form.set('password', password);
  form.set('referer', referer);
  form.set('remember', '1');
  return handleAuthRequest(db, buildRequestContext(new Request(action, {
    method: 'POST', body: form, headers: { origin: root, referer: pageUrl },
  })), secret);
}

describe('Typecho authentication compatibility', () => {
  it('matches the PHP Typecho hash format and known vector', () => {
    expect(typechoHash('password', 'abcdef123')).toBe('$T$abcdef123792257193e60e0710529e62f474618bb');
  });

  it('validates legacy Typecho, phpass and MD5 hashes, then upgrades them', async () => {
    const stored = typechoHash('legacy-password', 'Abc123xyz');
    expect(await verifyPassword('legacy-password', stored)).toBe(true);
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
    const phpass = '$P$5H8salt12YR5r3peDE56yNf7f2BGKl0';
    expect(await verifyPassword('php-legacy-密碼', phpass)).toBe(true);
    expect(await verifyPassword('php-legacy-密碼', `$H$${phpass.slice(3)}`)).toBe(true);
    expect(await verifyPassword('wrong', phpass)).toBe(false);
    expect(await verifyPassword('md5-password', '14b94f2bc9a25d8b183218dd7c45feb8')).toBe(true);
    expect(passwordNeedsRehash(stored)).toBe(true);
    expect(passwordNeedsRehash(phpass)).toBe(true);
    expect(await verifyPassword('password', '$P$broken')).toBe(false);
  });

  it('accepts PHP $2y$ bcrypt and hashes new passwords as bcrypt', async () => {
    const stored = await hashPassword('new-password');
    expect(stored).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword('new-password', stored)).toBe(true);
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
    expect(await verifyPassword('new-password', `$2y$${stored.slice(4)}`)).toBe(true);
    expect(passwordNeedsRehash(stored)).toBe(false);
  });

  it('binds security tokens to the request and login session', () => {
    const user = { uid: 7, authCode: '0123456789abcdef0123456789abcdef' };
    const loggedInToken = securityToken(secret, `${root}/admin/`, user);
    expect(loggedInToken).toBe('0edadfe57fa22e828ad8098dd8cde172');
    expect(loggedInToken).not.toBe(securityToken(secret, `${root}/admin/`));
    expect(loggedInToken).not.toBe(securityToken(secret, `${root}/action/logout`, user));
    expect(cookiePrefix(root)).toMatch(/^[a-f0-9]{32}$/);
  });

  it('uses secure HttpOnly cookies limited to the installation path', async () => {
    const cookies = await createLoginCookies(`${root}/blog`, 7, 'session-secret', true, true);
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toContain('Path=/blog/');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Max-Age=2592000');
      expect(cookie).toContain('Secure');
    }
  });

  it('signs option action URLs using the real request URL on subpath installations', () => {
    const url = `${root}/blog/admin/login.php?referer=%2Fblog%2Fadmin%2F`;
    const request = buildRequestContext(new Request(url), { basePath: '/blog' });
    expect(currentRequestUrl(request)).toBe(url);
    const user = { uid: 7, authCode: 'active-session' } as AuthUser;
    const options = new SiteOptions({ values: { secret }, request, echo: () => {}, user });
    expect(options.currentUser).toBe(user);
    expect(new SiteOptions({ values: { secret }, request, echo: () => {} }).currentUser).toBeNull();
    expect(new URL(options.get('loginAction')).searchParams.get('_')).toBe(securityToken(secret, url));
    expect(new URL(options.get('logoutUrl')).searchParams.get('_')).toBe(securityToken(secret, url, user));
    expect(options.get('loginAction')).toContain(`${root}/blog/action/login`);
  });
});

describe('login and logout integration', () => {
  it('logs in with an old password, renews its hash, authenticates the cookie and logs out', async () => {
    const { db, user, updates } = mockDb(typechoHash('legacy-password', 'Abc123xyz'));
    const target = `${root}/admin/?tab=posts`;
    const { html, pageUrl, action } = await loginPage(db, target);
    expect(html).toContain('value="https://example.test/admin/?tab=posts"');
    expect(new URL(action).searchParams.get('_')).toBe(securityToken(secret, pageUrl));
    const response = await loginPost(db, pageUrl, action, 'owner@example.test', 'legacy-password', target);
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe(target);
    expect(response?.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await verifyPassword('legacy-password', user.password)).toBe(true);
    expect(passwordNeedsRehash(user.password)).toBe(false);
    expect(updates).toHaveLength(2);

    const cookie = cookieHeader(response!.headers);
    const authenticated = await findCurrentUser(db, buildRequestContext(new Request(`${root}/admin/`, { headers: { cookie } })));
    expect(authenticated?.uid).toBe(7);
    const adminUrl = `${root}/admin/`;
    const admin = await handleAuthRequest(db, buildRequestContext(new Request(adminUrl, { headers: { cookie } })), secret);
    const adminHtml = await admin!.text();
    expect(adminHtml).toContain('/admin/manage-posts.php');
    expect(adminHtml).toContain('/admin/manage-pages.php');
    expect(adminHtml).toContain('/admin/manage-categories.php');
    expect(adminHtml).toContain('/admin/manage-tags.php');
    expect(adminHtml).toContain('/admin/manage-comments.php');
    expect(adminHtml).toContain('/admin/manage-medias.php');
    expect(adminHtml).toContain('/admin/manage-users.php');
    expect(adminHtml).toContain('/admin/options-general.php');
    const logoutUrl = /href="([^" ]*\/action\/logout\?_[^" ]*)"/.exec(adminHtml)?.[1];
    expect(logoutUrl).toBeTruthy();
    const rejected = await handleAuthRequest(db, buildRequestContext(new Request(logoutUrl!, {
      headers: { cookie, referer: `${root}/admin/other` },
    })), secret);
    expect(rejected?.status).toBe(403);
    const logout = await handleAuthRequest(db, buildRequestContext(new Request(logoutUrl!, {
      headers: { cookie, referer: adminUrl },
    })), secret);
    expect(logout?.status).toBe(303);
    expect(logout?.headers.get('set-cookie')).toContain('Max-Age=0; HttpOnly');
    expect(user.authCode).toBe('');
    expect(await findCurrentUser(db, buildRequestContext(new Request(adminUrl, { headers: { cookie } })))).toBeNull();
  });

  it('shows login errors and keeps safe return URLs after rejected credentials', async () => {
    const { db, updates } = mockDb(await hashPassword('correct-password'));
    const target = `${root}/admin/?tab=posts`;
    const { pageUrl, action } = await loginPage(db, target);
    const response = await loginPost(db, pageUrl, action, 'owner', 'wrong-password', target);
    expect(response?.status).toBe(303);
    const location = response?.headers.get('location') ?? '';
    expect(new URL(location).searchParams.get('error')).toBe('invalid');
    expect(new URL(location).searchParams.get('referer')).toBe(target);
    const errorPage = await handleAuthRequest(db, buildRequestContext(new Request(location)), secret);
    expect(await errorPage?.text()).toContain('用户名或密码不正确。');
    expect(updates).toHaveLength(0);
    const forbidden = await loginPost(db, pageUrl, `${root}/action/login?_=invalid`, 'owner', 'correct-password');
    expect(forbidden?.status).toBe(403);
  });

  it('does not redirect successful logins to foreign sites', async () => {
    const { db } = mockDb(await hashPassword('correct-password'));
    const { pageUrl, action } = await loginPage(db, 'https://outside.test/path');
    const response = await loginPost(db, pageUrl, action, 'owner', 'correct-password', 'https://outside.test/path');
    expect(response?.headers.get('location')).toBe(`${root}/admin/`);
  });
});
