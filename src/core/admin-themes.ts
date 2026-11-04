import { findCurrentUser, securityToken, type AuthUser } from './auth';
import { escapeHtml } from './common';
import type { Db } from './db';
import { renderAdminShell } from './admin-ui';
import { currentRequestUrl, type RequestContext } from './request';
import { listThemes, themeMeta } from './theme';
import { parseInstalledThemes } from './package-registry';

const ADMIN_THEMES = ['official', 'green', 'ocean'] as const;
const ADMIN_MODES = ['light', 'dark'] as const;
const ADMIN_LOCALES = ['zh-CN', 'en-US'] as const;

export async function handleAdminThemesRequest(db: Db, request: RequestContext, secret: string): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  if (path !== '/admin/themes.php' && path !== '/action/themes') return null;

  const user = await findCurrentUser(db, request);
  if (!user) {
    return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}`);
  }
  if (user.group !== 'administrator') return text('Forbidden', 403);

  if (path === '/admin/themes.php') {
    if (request.method !== 'GET') return text('Method Not Allowed', 405);
    const [rows, installedRow] = await Promise.all([
      db.all<{ name: string; value: string | null }>(
        "SELECT name, value FROM table.options WHERE user = 0 AND name IN ('theme','adminTheme','adminMode','adminLocale')"
      ),
      db.first<{ value: string | null }>("SELECT value FROM table.options WHERE name = 'installedThemes' AND user = 0"),
    ]);
    const values = Object.fromEntries(rows.map(({ name, value }) => [name, value ?? '']));
    let installedRaw: unknown = [];
    try { installedRaw = JSON.parse(installedRow?.value ?? '[]'); } catch { installedRaw = []; }
    const installed = parseInstalledThemes(installedRaw);
    const availableThemes = listThemes(installed);
    const currentTheme = availableThemes.includes(values.theme) ? values.theme : 'default';
    const currentAdminTheme = ADMIN_THEMES.includes(values.adminTheme as typeof ADMIN_THEMES[number]) ? values.adminTheme : 'official';
    const currentMode = ADMIN_MODES.includes(values.adminMode as typeof ADMIN_MODES[number]) ? values.adminMode : 'light';
    const currentLocale = ADMIN_LOCALES.includes(values.adminLocale as typeof ADMIN_LOCALES[number]) ? values.adminLocale : 'zh-CN';
    const source = currentRequestUrl(request);
    const action = `${request.rootUrl}/action/themes?_=${encodeURIComponent(securityToken(secret, source, user))}`;
    const themeOptions = availableThemes.map((theme) => {
      const meta = themeMeta(theme, installed);
      const name = escapeHtml(meta.name);
      const details = [meta.author, meta.version && `v${meta.version}`].filter(Boolean).map(escapeHtml).join(' · ');
      const selected = theme === currentTheme;
      const dynamic = installed.some((pkg) => pkg.slug === theme);
      const skipDynamic = dynamic ? ' data-i18n-skip' : '';
      return `<label class="theme-card theme-card--public"><input class="theme-card__radio" type="radio" name="theme" value="${escapeHtml(theme)}"${selected ? ' checked' : ''}><span class="theme-card__preview theme-card__preview--site" aria-hidden="true"><i></i><b></b><em></em></span><span class="theme-card__copy"><strong${skipDynamic}>${name}</strong><small${skipDynamic}>${escapeHtml(theme)}${details ? ` · ${details}` : ''}</small>${selected ? '<em class="theme-card__active">当前启用</em>' : ''}</span></label>`;
    }).join('');
    const adminNames: Record<typeof ADMIN_THEMES[number], string> = {
      official: 'Typecho 官方风格', green: '清新绿色', ocean: '海蓝经典',
    };
    const adminDescriptions: Record<typeof ADMIN_THEMES[number], string> = {
      official: '中性灰蓝 · 官方默认', green: '柔和森林绿 · 清爽明亮', ocean: '克制海蓝 · 清晰沉稳',
    };
    const adminOptions = ADMIN_THEMES.map((theme) => {
      const selected = currentAdminTheme === theme;
      return `<label class="theme-card theme-card--${theme}"><input class="theme-card__radio" type="radio" name="adminTheme" value="${theme}"${selected ? ' checked' : ''}><span class="theme-card__preview theme-card__preview--${theme}" aria-hidden="true"><i></i><b></b><em></em><small></small></span><span class="theme-card__copy"><strong>${adminNames[theme]}${theme === 'official' ? '（默认）' : ''}</strong><small>${adminDescriptions[theme]}</small>${selected ? '<em class="theme-card__active">当前启用</em>' : ''}</span></label>`;
    }).join('');
    const body = `<header class="appearance-heading"><p class="appearance-eyebrow">TYPECHO / ADMIN</p><h1>主题与外观</h1><p>分别设置访客看到的站点主题与后台工作环境。配色、明暗和语言互不影响。</p></header>${request.query.has('saved') ? '<p class="appearance-notice" role="status">偏好设置已保存。</p>' : ''}<form class="appearance-form" method="post" action="${escapeHtml(action)}"><section class="appearance-section"><div class="appearance-section__head"><div><h2>前台站点主题</h2><p>访客访问首页时看到的主题样式。</p></div><a href="${escapeHtml(request.rootUrl)}/" target="_blank" rel="noopener">预览站点</a></div><div class="theme-grid theme-grid--public">${themeOptions}</div></section><section class="appearance-section"><div class="appearance-section__head"><div><h2>后台外观</h2><p>选择工作区主色；暗色模式可叠加到任意配色。</p></div></div><div class="theme-grid">${adminOptions}</div></section><section class="appearance-section appearance-section--preferences"><div class="appearance-section__head"><div><h2>显示偏好</h2><p>偏好会保存到站点设置，并应用于所有后台页面。</p></div></div><div class="appearance-preferences"><label class="preference-control preference-control--switch"><span><strong>深色模式</strong><small>使用低亮度背景，减少夜间眩光</small></span><input type="checkbox" name="adminMode" value="dark"${currentMode === 'dark' ? ' checked' : ''}><i aria-hidden="true"></i></label><label class="preference-control"><span><strong>界面语言</strong><small>切换后台导航、表单与提示语言</small></span><select name="adminLocale"><option value="zh-CN"${currentLocale === 'zh-CN' ? ' selected' : ''}>简体中文</option><option value="en-US"${currentLocale === 'en-US' ? ' selected' : ''}>English</option></select></label></div></section><div class="appearance-actions"><button type="submit">保存偏好设置</button><span>设置立即应用于后台所有页面。</span></div></form><section class="help appearance-help"><h2>添加站点主题</h2><p>可通过 <a href="${escapeHtml(request.rootUrl)}/admin/packages.php">扩展安装</a> 上传可信 ZIP，主题 PHP 会由当前 Worker 的受限解释器运行，静态文件通过 R2 提供。安装不会重新部署 Worker；插件仅支持受限的后台菜单 Hook。</p></section>`;
    return html(renderAdminShell('主题与外观', request, body));
  }

  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  const form = await request.body?.();
  if (!form || !validRequest(request, secret, user)) return text('CSRF validation failed', 403);

  const theme = String(form.get('theme') ?? '');
  const adminTheme = String(form.get('adminTheme') ?? '');
  const adminMode = form.get('adminMode') === 'dark' ? 'dark' : 'light';
  const adminLocale = String(form.get('adminLocale') ?? 'zh-CN');
  const installedRow = await db.first<{ value: string | null }>("SELECT value FROM table.options WHERE name = 'installedThemes' AND user = 0");
  let installedRaw: unknown = [];
  try { installedRaw = JSON.parse(installedRow?.value ?? '[]'); } catch { installedRaw = []; }
  if (!listThemes(parseInstalledThemes(installedRaw)).includes(theme)) return text('Invalid theme', 400);
  if (!ADMIN_THEMES.includes(adminTheme as typeof ADMIN_THEMES[number])) return text('Invalid admin theme', 400);
  if (!ADMIN_LOCALES.includes(adminLocale as typeof ADMIN_LOCALES[number])) return text('Invalid admin language', 400);

  await db.batch([
    ['theme', theme],
    ['adminTheme', adminTheme],
    ['adminMode', adminMode],
    ['adminLocale', adminLocale],
  ].map(([name, value]) => ({
    sql: 'INSERT INTO table.options (name, "user", value) VALUES (?, 0, ?) ON CONFLICT(name, "user") DO UPDATE SET value = excluded.value',
    params: [name, value],
  })));
  return redirect(`${request.rootUrl}/admin/themes.php?saved=1`);
}

function validRequest(request: RequestContext, secret: string, user: AuthUser): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return false;
  let referer: URL;
  try {
    referer = new URL(request.referer);
  } catch {
    return false;
  }
  const expectedPath = `${new URL(request.rootUrl).pathname.replace(/\/$/, '')}/admin/themes.php`;
  if (referer.origin !== request.url.origin || referer.pathname !== expectedPath) return false;
  const actual = request.query.get('_') ?? '';
  const expected = securityToken(secret, request.referer, user);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i += 1) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function html(value: string): Response {
  return new Response(value, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
}
function text(value: string, status: number): Response {
  return new Response(value, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
}
function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
