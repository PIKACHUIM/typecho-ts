import { escapeHtml } from './common';
import { Db } from './db';
import {
  clearLoginCookies,
  createLoginCookies,
  findCurrentUser,
  hashPassword,
  passwordNeedsRehash,
  securityToken,
  type AuthUser,
  typechoRandomString,
  verifyPassword,
} from './auth';
import type { RequestContext } from './request';

const DEFAULT_ROUTES = {
  index: { url: '/', widget: '\\Widget\\Archive', action: 'render' },
  archive: { url: '/blog/', widget: '\\Widget\\Archive', action: 'render' },
  do: { url: '/action/[action:alpha]', widget: '\\Widget\\Action', action: 'action' },
  post: { url: '/archives/[cid:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  attachment: { url: '/attachment/[cid:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  category: { url: '/category/[slug:alpha]/', widget: '\\Widget\\Archive', action: 'render' },
  category_page: { url: '/category/[slug:alpha]/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  tag: { url: '/tag/[slug:alpha]/', widget: '\\Widget\\Archive', action: 'render' },
  tag_page: { url: '/tag/[slug:alpha]/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  author: { url: '/author/[uid:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  author_page: { url: '/author/[uid:digital]/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  search_page: { url: '/search/[keywords:string]/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  search: { url: '/search/[keywords:string]/', widget: '\\Widget\\Archive', action: 'render' },
  index_page: { url: '/page/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  page: { url: '/[slug:alpha].html', widget: '\\Widget\\Archive', action: 'render' },
  archive_page: { url: '/blog/page/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  archive_year: { url: '/[year:digital:4]/', widget: '\\Widget\\Archive', action: 'render' },
  archive_month: { url: '/[year:digital:4]/[month:digital:2]/', widget: '\\Widget\\Archive', action: 'render' },
  archive_day: { url: '/[year:digital:4]/[month:digital:2]/[day:digital:2]/', widget: '\\Widget\\Archive', action: 'render' },
  archive_year_page: { url: '/[year:digital:4]/page/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  archive_month_page: { url: '/[year:digital:4]/[month:digital:2]/page/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  archive_day_page: { url: '/[year:digital:4]/[month:digital:2]/[day:digital:2]/page/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  comment_page: { url: '[permalink:string]/comment-page-[commentPage:digital]', widget: '\\Widget\\CommentPage', action: 'action' },
  feed: { url: '/feed[feed:string:0]', widget: '\\Widget\\Feed', action: 'render' },
  feedback: { url: '[permalink:string]/[type:alpha]', widget: '\\Widget\\Feedback', action: 'action' },
};

const INSTALL_OPTIONS: Array<[string, string]> = [
  ['theme', 'default'],
  ['rewrite', '1'],
  ['pageSize', '10'],
  ['postsListSize', '5'],
  ['commentsListSize', '5'],
  ['commentsShowCommentOnly', '1'],
  ['commentsThreaded', '1'],
  ['charset', 'UTF-8'],
  ['contentType', 'text/html'],
  ['version', '1.3.1'],
  ['generator', 'Typecho 1.3.1'],
  ['allowXmlRpc', '0'],
  ['frontPage', 'recent'],
  ['postDateFormat', 'F j, Y'],
  ['commentDateFormat', 'F jS, Y \\a\\t h:ia'],
  ['plugins', JSON.stringify({ activated: {}, handles: {} })],
  ['actionTable', '{}'],
  ['panelTable', '{}'],
];

export async function isInstallationComplete(db: Db): Promise<boolean> {
  const installed = await db.first<{ value: string | null }>(
    `SELECT value FROM table.options WHERE name = 'installed' AND user = 0`
  );
  if (installed?.value !== '1') return false;
  const admin = await db.first<{ uid: number }>(
    `SELECT uid FROM table.users WHERE "group" = 'administrator' LIMIT 1`
  );
  return Boolean(admin);
}

export async function hasExistingSiteData(db: Db): Promise<boolean> {
  const row = await db.first<{ occupied: number }>(`SELECT
    EXISTS(SELECT 1 FROM table.users) OR EXISTS(SELECT 1 FROM table.options) OR
    EXISTS(SELECT 1 FROM table.contents) OR EXISTS(SELECT 1 FROM table.metas) OR
    EXISTS(SELECT 1 FROM table.comments) OR EXISTS(SELECT 1 FROM table.relationships) OR
    EXISTS(SELECT 1 FROM table.fields) AS occupied`);
  return Boolean(row?.occupied);
}

export async function renderInstaller(db: Db, request: RequestContext): Promise<Response> {
  if (await isInstallationComplete(db)) return redirect(`${request.rootUrl}/`);
  if (await hasExistingSiteData(db)) {
    return textResponse('数据库中已存在数据，安装已停止以保护现有数据。请检查 installed 配置或恢复备份。', 409);
  }
  if (request.method.toUpperCase() !== 'POST') {
    const token = randomToken();
    const html = installerHtml(request, token);
    const headers = new Headers({ 'content-type': 'text/html; charset=UTF-8' });
    headers.append('set-cookie', `typecho_install_token=${token}; Path=${cookiePath(request.rootUrl)}; Max-Age=3600; HttpOnly; SameSite=Strict${request.isSecure ? '; Secure' : ''}`);
    return new Response(html, { headers });
  }

  if (!sameOriginRequest(request)) return textResponse('跨站请求已拒绝，请从当前站点重新打开安装页面。', 403);
  const submittedToken = request.cookies.get('typecho_install_token') ?? '';
  const form = await request.body?.();
  const formToken = String(form?.get('_') ?? '');
  if (!/^[a-f0-9]{64}$/.test(submittedToken) || !constantTimeEquals(submittedToken, formToken)) {
    return textResponse('安装验证已过期，请刷新页面后重试。', 403);
  }
  if (await hasExistingSiteData(db)) {
    return textResponse('数据库中已存在数据，安装已停止以保护现有数据。请检查 installed 配置或恢复备份。', 409);
  }

  const title = String(form?.get('title') ?? '').trim();
  const description = String(form?.get('description') ?? '').trim();
  const username = String(form?.get('name') ?? '').trim();
  const screenName = String(form?.get('screenName') ?? '').trim() || username;
  const email = String(form?.get('mail') ?? '').trim();
  const password = String(form?.get('password') ?? '');
  const confirm = String(form?.get('confirm') ?? '');
  const siteUrl = normalizeSiteUrl(String(form?.get('siteUrl') ?? ''), request.rootUrl);
  const timezone = Number(form?.get('timezone') ?? 28800);
  const validation = validateInstallInput({ title, description, username, screenName, email, password, confirm, siteUrl, timezone });
  if (validation) return renderInstallError(request, validation, tokenCookie(request));

  const now = Math.floor(Date.now() / 1000);
  const secret = typechoRandomString(32, true);
  const passwordHash = await hashPassword(password);
  const options: Array<[string, string]> = [
    ['title', title],
    ['description', description],
    ['siteUrl', siteUrl],
    ['timezone', String(timezone)],
    ['secret', secret],
    ['routingTable', JSON.stringify(DEFAULT_ROUTES)],
    ...INSTALL_OPTIONS,
    ['installed', '1'],
  ];
  const statements = [
    {
      sql: `INSERT INTO table.users (uid, name, password, mail, url, screenName, created, activated, logged, "group", authCode)
            VALUES (1, ?, ?, ?, '', ?, ?, ?, 0, 'administrator', '')`,
      params: [username, passwordHash, email, screenName, now, now],
    },
    {
      sql: `INSERT INTO table.metas (mid, name, slug, type, description, count, "order", parent)
            VALUES (1, '默认分类', 'default', 'category', '', 1, 1, 0)`,
    },
    {
      sql: `INSERT INTO table.contents (cid, title, slug, created, modified, text, "order", authorId, template, type, status, password, commentsNum, allowComment, allowPing, allowFeed, parent)
            VALUES (1, '欢迎使用 Typecho', 'start', ?, ?, '<!--markdown-->欢迎来到你的新站点。你可以登录后台，开始撰写文章。', 0, 1, NULL, 'post', 'publish', NULL, 1, '1', '1', '1', 0)`,
      params: [now, now],
    },
    {
      sql: `INSERT INTO table.contents (cid, title, slug, created, modified, text, "order", authorId, template, type, status, password, commentsNum, allowComment, allowPing, allowFeed, parent)
            VALUES (2, '关于', 'start-page', ?, ?, '<!--markdown-->在这里介绍你的站点。', 0, 1, NULL, 'page', 'publish', NULL, 0, '1', '1', '1', 0)`,
      params: [now, now],
    },
    { sql: `INSERT INTO table.relationships (cid, mid) VALUES (1, 1)` },
    {
      sql: `INSERT INTO table.comments (coid, cid, created, author, authorId, ownerId, mail, url, ip, agent, text, type, status, parent)
            VALUES (1, 1, ?, 'Typecho', 0, 1, 'hello@typecho.org', 'https://typecho.org', '127.0.0.1', 'Typecho', '欢迎加入 Typecho 大家族', 'comment', 'approved', 0)`,
      params: [now],
    },
    ...options.map(([name, value]) => ({
      sql: `INSERT INTO table.options (name, "user", value) VALUES (?, 0, ?)`,
      params: [name, value],
    })),
  ];

  try {
    await db.batch(statements);
  } catch {
    if (await hasExistingSiteData(db)) {
      return textResponse('数据库中已存在数据，安装已停止以保护现有数据。请检查 installed 配置或恢复备份。', 409);
    }
    return textResponse('初始化未能完成，数据库没有被覆盖。请确认迁移已执行后重试。', 500);
  }
  const headers = new Headers({ location: `${request.rootUrl}/admin/login.php?installed=1` });
  headers.append('set-cookie', `typecho_install_token=; Path=${cookiePath(request.rootUrl)}; Max-Age=0; HttpOnly; SameSite=Strict${request.isSecure ? '; Secure' : ''}`);
  return new Response(null, { status: 303, headers });
}

export async function handleAuthRequest(db: Db, request: RequestContext, secret: string): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  if (path === '/admin') {
    if (request.method.toUpperCase() !== 'GET') return textResponse('Method Not Allowed', 405);
    const user = await findCurrentUser(db, request);
    if (!user) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(`${request.rootUrl}/admin/`)}`);
    const logoutUrl = `${request.rootUrl}/action/logout?_=${securityToken(secret, currentPageUrl(request), user)}`;
    return new Response(adminHomeHtml(request, user, logoutUrl), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
  }
  if (path === '/admin/login.php') {
    if (request.method.toUpperCase() !== 'GET') return textResponse('Method Not Allowed', 405);
    if (await findCurrentUser(db, request)) return redirect(`${request.rootUrl}/admin/`);
    return new Response(loginHtml(request, secret, request.url.searchParams.get('error') ?? ''), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
  }
  if (path === '/action/login') {
    if (request.method.toUpperCase() !== 'POST') return textResponse('Method Not Allowed', 405);
    return login(db, request, secret);
  }
  if (path === '/action/logout') {
    if (request.method.toUpperCase() !== 'GET' && request.method.toUpperCase() !== 'POST') return textResponse('Method Not Allowed', 405);
    return logout(db, request, secret);
  }
  return null;
}

async function login(db: Db, request: RequestContext, secret: string): Promise<Response> {
  const form = await request.body?.();
  if (!sameOriginRequest(request)) return textResponse('CSRF validation failed', 403);
  const referer = request.referer;
  const token = new URL(request.url).searchParams.get('_') ?? String(form?.get('_') ?? '');
  if (!referer || !constantTimeEquals(token, securityToken(secret, referer))) {
    return textResponse('CSRF validation failed', 403);
  }

  const name = String(form?.get('name') ?? '').trim();
  const password = String(form?.get('password') ?? '');
  const remember = String(form?.get('remember') ?? '') !== '';
  const submittedReferer = String(form?.get('referer') ?? '');
  if (!name || !password) return redirect(loginLocation(request, 'missing', submittedReferer));
  const user = await db.first<AuthUser>(
    `SELECT uid, name, password, mail, screenName, "group", authCode FROM table.users WHERE name = ? LIMIT 1`,
    [name]
  ) ?? (name.includes('@')
    ? await db.first<AuthUser>(`SELECT uid, name, password, mail, screenName, "group", authCode FROM table.users WHERE mail = ? LIMIT 1`, [name])
    : null);
  if (!user || !user.password || !await verifyPassword(password, user.password)) return redirect(loginLocation(request, 'invalid', submittedReferer));

  if (passwordNeedsRehash(user.password)) {
    const upgraded = await hashPassword(password);
    await db.run(`UPDATE table.users SET password = ? WHERE uid = ?`, [upgraded, user.uid]);
  }
  const authCode = randomToken(16);
  const now = Math.floor(Date.now() / 1000);
  await db.run(`UPDATE table.users SET logged = ?, authCode = ? WHERE uid = ?`, [now, authCode, user.uid]);

  const headers = new Headers({ location: safeLoginRedirect(submittedReferer, request) });
  const cookies = await createLoginCookies(request.rootUrl, user.uid, authCode, remember, request.isSecure);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

async function logout(db: Db, request: RequestContext, secret: string): Promise<Response> {
  if (!sameOriginRequest(request)) return textResponse('CSRF validation failed', 403);
  const user = await findCurrentUser(db, request);
  const referer = request.referer;
  const token = new URL(request.url).searchParams.get('_') ?? '';
  if (!user || !referer || !constantTimeEquals(token, securityToken(secret, referer, user))) {
    return textResponse('CSRF validation failed', 403);
  }
  await db.run(`UPDATE table.users SET authCode = '', logged = 0 WHERE uid = ?`, [user.uid]);
  const headers = new Headers({ location: `${request.rootUrl}/admin/login.php?logged_out=1` });
  for (const cookie of clearLoginCookies(request.rootUrl, request.isSecure)) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function loginHtml(request: RequestContext, secret: string, error = ''): string {
  const refererParam = request.url.searchParams.get('referer') ?? '';
  const referer = safeLoginRedirect(refererParam, request);
  const action = `${request.rootUrl}/action/login?_=${securityToken(secret, currentPageUrl(request))}`;
  const messages: Record<string, string> = {
    missing: '请输入用户名和密码。',
    invalid: '用户名或密码不正确。',
  };
  const message = messages[error] ?? (request.url.searchParams.has('logged_out') ? '你已安全退出。' : '');
  return pageHtml('登录', `<main class="card"><p class="eyebrow">TYPECHO</p><h1>登录</h1><p class="muted">使用管理员账户继续。</p>${message ? `<p class="message" role="status">${escapeHtml(message)}</p>` : ''}<form method="post" action="${escapeHtml(action)}"><label>用户名或邮箱<input name="name" autocomplete="username" required autofocus></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><input type="hidden" name="referer" value="${escapeHtml(referer)}"><label class="remember"><input type="checkbox" name="remember" value="1">保持登录 30 天</label><button type="submit">登录</button></form><a class="back" href="${escapeHtml(request.rootUrl)}/">返回站点</a></main>`);
}

function adminHomeHtml(request: RequestContext, user: AuthUser, logoutUrl: string): string {
  const root = escapeHtml(request.rootUrl);
  const body = `<main class="card"><p class="eyebrow">TYPECHO ADMIN</p><h1>欢迎，${escapeHtml(user.screenName || user.name)}</h1><p class="muted">管理员账户已登录。</p><nav aria-label="管理菜单"><a class="back" href="${root}/admin/manage-posts.php">管理文章</a><a class="back" href="${root}/admin/manage-pages.php">管理页面</a><a class="back" href="${root}/admin/manage-categories.php">管理分类</a><a class="back" href="${root}/admin/manage-tags.php">管理标签</a><a class="back" href="${root}/admin/manage-comments.php">审核评论</a><a class="back" href="${root}/admin/manage-medias.php">管理媒体</a><a class="back" href="${root}/admin/manage-users.php">管理用户</a><a class="back" href="${root}/admin/options-general.php">站点设置</a></nav><a class="back" href="${root}/">查看站点</a><a class="back" href="${escapeHtml(logoutUrl)}">退出登录</a></main>`;
  return pageHtml('管理后台', body);
}

function installerHtml(request: RequestContext, token: string, error = ''): string {
  const errorBlock = error ? `<p class="message" role="alert">${escapeHtml(error)}</p>` : '';
  return pageHtml('初始化', `<main class="card wide"><p class="eyebrow">TYPECHO</p><h1>开始使用</h1><p class="muted">先设置站点信息和管理员账户，完成后即可登录。</p>${errorBlock}<form method="post" action="${escapeHtml(request.rootUrl)}/install.php"><input type="hidden" name="_" value="${escapeHtml(token)}"><label>站点标题<input name="title" maxlength="150" required value="${escapeHtml(request.url.searchParams.get('title') ?? '')}"></label><label>站点描述<input name="description" maxlength="255" value=""></label><label>站点地址<input name="siteUrl" type="url" required value="${escapeHtml(request.rootUrl)}"></label><div class="grid"><label>管理员用户名<input name="name" maxlength="32" autocomplete="username" required></label><label>显示名称<input name="screenName" maxlength="32" required></label></div><label>邮箱<input name="mail" type="email" maxlength="150" autocomplete="email" required></label><div class="grid"><label>密码<input name="password" type="password" minlength="8" autocomplete="new-password" required></label><label>确认密码<input name="confirm" type="password" minlength="8" autocomplete="new-password" required></label></div><label>时区偏移（秒）<input name="timezone" type="number" value="28800" min="-43200" max="50400" required><small>中国标准时间为 28800 秒（UTC+8）。</small></label><button type="submit">安装 Typecho</button></form></main>`);
}

function renderInstallError(request: RequestContext, error: string, cookie: string): Response {
  const headers = new Headers({ 'content-type': 'text/html; charset=UTF-8' });
  headers.append('set-cookie', cookie);
  return new Response(installerHtml(request, request.cookies.get('typecho_install_token') ?? '', error), { status: 400, headers });
}

function validateInstallInput(input: {
  title: string;
  description: string;
  username: string;
  screenName: string;
  email: string;
  password: string;
  confirm: string;
  siteUrl: string;
  timezone: number;
}): string | null {
  if (!input.title || input.title.length > 150) return '站点标题不能为空，且不能超过 150 个字符。';
  if (input.description.length > 255) return '站点描述不能超过 255 个字符。';
  if (!/^[A-Za-z0-9_]{1,32}$/.test(input.username)) return '管理员用户名只能包含英文字母、数字和下划线，长度为 1–32 位。';
  if (!input.screenName || input.screenName.length > 32) return '显示名称不能为空，且不能超过 32 个字符。';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 150) return '请输入有效邮箱地址。';
  if (input.password.length < 8) return '管理员密码至少需要 8 个字符。';
  if (new TextEncoder().encode(input.password).length > 72) return '管理员密码最多可使用 72 个 UTF-8 字节。';
  if (input.password !== input.confirm) return '两次输入的密码不一致。';
  if (!input.siteUrl) return '站点地址必须是有效的 HTTP 或 HTTPS URL。';
  if (!Number.isInteger(input.timezone) || input.timezone < -43200 || input.timezone > 50400) return '时区偏移超出允许范围。';
  return null;
}

function normalizeSiteUrl(value: string, fallback: string): string {
  try {
    const url = new URL(value.trim() || fallback);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function sameOriginRequest(request: RequestContext): boolean {
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== request.url.origin) return false;
    } catch {
      return false;
    }
  }
  if (request.referer) {
    try {
      return new URL(request.referer).origin === request.url.origin;
    } catch {
      return false;
    }
  }
  return Boolean(origin);
}

function safeLoginRedirect(target: string, request: RequestContext): string {
  if (!target) return `${request.rootUrl}/admin/`;
  try {
    const parsed = new URL(target, `${request.rootUrl}/`);
    if (parsed.origin !== request.url.origin) return `${request.rootUrl}/admin/`;
    const rootPath = new URL(request.rootUrl).pathname.replace(/\/+$/, '');
    if (rootPath && parsed.pathname !== rootPath && !parsed.pathname.startsWith(`${rootPath}/`)) return `${request.rootUrl}/admin/`;
    return parsed.toString();
  } catch {
    return `${request.rootUrl}/admin/`;
  }
}

function loginLocation(request: RequestContext, error: string, referer: string): string {
  const params = new URLSearchParams({ error, referer: safeLoginRedirect(referer, request) });
  return `${request.rootUrl}/admin/login.php?${params}`;
}

function currentPageUrl(request: RequestContext): string {
  return `${request.url.origin}${request.url.pathname}${request.url.search}`;
}

function pageHtml(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Typecho</title><style>:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#24313d;background:#f3f6f8;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px}.card{width:min(100%,430px);padding:38px;background:#fff;border:1px solid #e2e8ed;border-radius:18px;box-shadow:0 18px 55px #26394b12}.card.wide{width:min(100%,640px)}.eyebrow{color:#407c69;font-size:12px;font-weight:700;letter-spacing:.18em;margin:0 0 10px}h1{font-size:28px;margin:0 0 8px}.muted{color:#697784;margin:0 0 26px}form{display:grid;gap:18px}label{display:grid;gap:7px;font-size:14px;font-weight:600}input{width:100%;border:1px solid #ccd6dd;border-radius:8px;padding:11px 12px;font:inherit;color:inherit;background:#fff}input:focus{outline:3px solid #4d9b7b30;border-color:#4d9b7b}small{font-size:12px;color:#75838d;font-weight:400}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.remember{display:flex;align-items:center;gap:9px;font-weight:400}.remember input{width:auto}.message{padding:11px 13px;color:#7c342b;background:#fff1ed;border-radius:8px;font-size:14px}button{border:0;border-radius:8px;padding:12px 16px;background:#31785f;color:#fff;font:inherit;font-weight:700;cursor:pointer}button:hover{background:#28664f}.back{display:block;text-align:center;margin-top:20px;color:#597365;text-decoration:none;font-size:14px}@media(max-width:520px){body{padding:14px}.card{padding:26px 20px}.grid{grid-template-columns:1fr;gap:18px}}</style></head><body>${body}</body></html>`;
}

function tokenCookie(request: RequestContext): string {
  return `typecho_install_token=${request.cookies.get('typecho_install_token') ?? ''}; Path=${cookiePath(request.rootUrl)}; Max-Age=3600; HttpOnly; SameSite=Strict${request.isSecure ? '; Secure' : ''}`;
}

function cookiePath(rootUrl: string): string {
  const path = new URL(rootUrl).pathname.replace(/\/+$/, '');
  return `${path || ''}/`;
}

function randomToken(bytes = 32): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
}
