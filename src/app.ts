import { Hono } from 'hono';
import { Interpreter } from '../php-compat/interpreter';
import { createRuntime, type ExecContext, type Runtime } from '../php-compat/index';
import { PhpError } from '../php-compat/errors';
import { toStr } from '../php-compat/values';
import type { Env } from './env';
import { Db } from './core/db';
import { buildRequestContext, type RequestContext } from './core/request';
import { localizeAdminHtml, localizeAdminText } from './core/admin-i18n';
import { loadOptions, type SiteOptions } from './core/options';
import { createSchema, isMissingTableError } from './core/schema';
import { RuntimeThemeStore, makeIncludeResolver, normalize, type ThemeFileStore } from './core/theme';
import { parseInstalledThemes, validSlug } from './core/package-registry';
import { listCategories, listContents, listPages, listRecentComments } from './repo/content';
import { handleAuthRequest, isInstallationComplete, renderInstaller } from './core/install-auth';
import { handleAdminContentRequest } from './core/admin-content';
import { handleAdminSettingsRequest } from './core/admin-settings';
import { handleAdminRoutingRequest } from './core/admin-routing';
import { handleAdminThemesRequest } from './core/admin-themes';
import { handleAdminStorageRequest } from './core/admin-storage';
import { handleAdminPackagesRequest } from './core/admin-packages';
import { handleFeed } from './core/feed';
import { handleCommentRequest } from './core/comment-action';
import { handleUploadRequest } from './core/uploads';
import { handleAdminMetasRequest } from './core/admin-metas';
import { handleAdminCommentsRequest } from './core/admin-comments';
import { handleAdminUsersRequest } from './core/admin-users';
import { handleAdminPreferencesRequest } from './core/admin-preferences';
import { Archive } from './widgets/archive';
import { CommentsWidget } from './widgets/comments';
import { RowsWidget } from './widgets/rows';
import { dateArchiveRows } from './widgets/date-archive';

export interface RenderDeps {
  env: Env;
  db: Db;
  request: RequestContext;
  echo: (value: unknown) => void;
}

/**
 * Loads site options, creating the schema first when the D1 database is empty
 * or was reset. Without this a fresh database answers 500 (`no such table`)
 * instead of reaching the installer.
 */
async function loadSiteOptions(
  db: Db,
  request: RequestContext,
  echo: (value: unknown) => void,
  siteUrl?: string
): Promise<SiteOptions> {
  try {
    return await loadOptions(db, request, echo, siteUrl);
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    await createSchema(db);
    return loadOptions(db, request, echo, siteUrl);
  }
}

/**
 * Renders a site request through the theme templates.
 */
export async function renderSite(env: Env, rawRequest: Request): Promise<Response> {
  const request = buildRequestContext(rawRequest);
  const db = new Db(env.DB, env.DB_PREFIX ?? 'typecho_');
  const out: string[] = [];
  const echo = (value: unknown) => out.push(toStr(value));
  const options = await loadSiteOptions(db, request, echo, env.SITE_URL);

  if (!(await isInstallationComplete(db))) return renderInstaller(db, request);

  const authResponse = await handleAuthRequest(db, request, String(options.get('secret') ?? ''), options, env.BUCKET);
  if (authResponse) return authResponse;
  const contentResponse = await handleAdminContentRequest(db, request, String(options.get('secret') ?? ''));
  if (contentResponse) return contentResponse;
  const settingsResponse = await handleAdminSettingsRequest(db, request, String(options.get('secret') ?? ''));
  if (settingsResponse) return settingsResponse;
  const routingResponse = await handleAdminRoutingRequest(db, request, String(options.get('secret') ?? ''));
  if (routingResponse) return routingResponse;
  const packagesResponse = await handleAdminPackagesRequest(db, request, String(options.get('secret') ?? ''), env.BUCKET, rawRequest);
  if (packagesResponse) return packagesResponse;
  const themesResponse = await handleAdminThemesRequest(db, request, String(options.get('secret') ?? ''));
  if (themesResponse) return themesResponse;
  const storageResponse = await handleAdminStorageRequest(db, request, String(options.get('secret') ?? ''), env.BUCKET);
  if (storageResponse) return storageResponse;
  const preferencesResponse = await handleAdminPreferencesRequest(db, request, String(options.get('secret') ?? ''));
  if (preferencesResponse) return preferencesResponse;
  const uploadResponse = await handleUploadRequest(db, request, String(options.get('secret') ?? ''), env.BUCKET, rawRequest);
  if (uploadResponse) return uploadResponse;
  const metasResponse = await handleAdminMetasRequest(db, request, String(options.get('secret') ?? ''));
  if (metasResponse) return metasResponse;
  const commentsResponse = await handleAdminCommentsRequest(db, request, String(options.get('secret') ?? ''));
  if (commentsResponse) return commentsResponse;
  const usersResponse = await handleAdminUsersRequest(db, request, String(options.get('secret') ?? ''));
  if (usersResponse) return usersResponse;
  const feedResponse = await handleFeed(db, request, options);
  if (feedResponse) return feedResponse;
  const commentResponse = await handleCommentRequest(db, request, options);
  if (commentResponse) return commentResponse;
  if ((request.isPost && !request.pathInfo.startsWith('/admin/') && !request.pathInfo.startsWith('/action/')) ||
      (request.pathInfo === '/' && request.query.has('s'))) {
    const form = request.isPost ? await request.body?.() : null;
    const submitted = form?.get('s') ?? (request.pathInfo === '/' ? request.query.get('s') : null);
    if (submitted !== null) {
      if (typeof submitted !== 'string' || !submitted.trim() || [...submitted.trim()].length > 200) {
        return new Response('Invalid search query', { status: 400 });
      }
      if (!options.router.get('search')) return new Response('Search route is not configured', { status: 404 });
      const destination = options.router.url('search', { keywords: encodeURIComponent(submitted.trim()) }, options.derived.index);
      return new Response(null, { status: 303, headers: { location: destination } });
    }
    if (request.pathInfo === '/') return new Response('Invalid search query', { status: 400 });
  }

  const match = options.router.match(request.pathInfo);
  if (!match) return renderNotFound(env, db, request, echo, out, options);

  if (match.route.name === 'comment_page') {
    const permalink = match.params?.permalink ?? (match.params?.cid
      ? options.router.url('post', { cid: match.params.cid }, '') : '');
    const parent = options.router.match(permalink.startsWith('/') ? permalink : `/${permalink}`);
    if (!parent || !['post', 'page', 'attachment'].includes(parent.route.name)) {
      return renderNotFound(env, db, request, echo, out, options);
    }
    return renderArchive({ env, db, request, echo }, options, out, parent.route.name, parent.params);
  }

  const widgetName = String(match.route.widget ?? '');
  if (widgetName.endsWith('\\Archive') || widgetName === 'Widget\\Archive') {
    return renderArchive({ env, db, request, echo }, options, out, match.route.name, match.params);
  }

  if (widgetName.endsWith('\\Action')) {
    return new Response('Action not implemented yet', { status: 501 });
  }

  return new Response('Not Found', { status: 404 });
}

async function renderArchive(
  deps: RenderDeps,
  options: SiteOptions,
  out: string[],
  routeName: string,
  params: Record<string, string> | null
): Promise<Response> {
  const { env, db, request, echo } = deps;
  const theme = String(options.get('theme') ?? 'default');
  const installedThemes = parseInstalledThemes(options.get('installedThemes'));
  const store = new RuntimeThemeStore(env.BUCKET, installedThemes);
  const encoder = new TextEncoder();
  let renderedBytes = 0;
  const themeEcho = (value: unknown) => {
    const text = toStr(value);
    renderedBytes += encoder.encode(text).byteLength;
    if (renderedBytes > 2 * 1024 * 1024) throw new Error('Theme output limit exceeded');
    echo(text);
  };
  const runtime = createRuntime({
    readFile: makeIncludeResolver(store, theme),
    timezoneOffset: Number(options.get('timezone') ?? 0),
    maxOperations: 100_000,
    echo: themeEcho,
  });

  const themedDeps = { ...deps, echo: themeEcho };
  const archive = new Archive({ db, options, request, echo: themeEcho, params, type: routeName });

  // Static widget classes need the live request context (options, db, echo).
  registerRuntimeWidgets(runtime, themedDeps, options, archive);

  const ctx: ExecContext = {
    out,
    echo: themeEcho,
    runtime,
    file: `${theme}/index.php`,
    self: archive,
  };
  const interpreter = new Interpreter(runtime, ctx);
  archive.renderInclude = async (file: string) => {
    const target = normalize(file);
    const source = await store.read(theme, target);
    if (source === null) throw new PhpError(`Template "${target}" not found`);
    await interpreter.run(source, `${theme}/${target}`);
  };

  const functions = await store.read(theme, 'functions.php');
  if (functions) await interpreter.run(functions, `${theme}/functions.php`);

  await archive.ensureLoaded();

  const notFound = archive.notFound;
  if (notFound) {
    archive.archiveType = 'archive';
    archive.archiveSlug = '404';
    archive.titleText = '页面没找到';
  }
  const file = await chooseThemeFile(store, theme, archive, notFound);
  if (!file) return new Response('Theme template not found', { status: 500 });
  archive.themeFile = file;
  const source = await store.read(theme, file);
  if (source === null) return new Response(`Template "${file}" not found`, { status: 500 });

  try {
    await interpreter.run(source, `${theme}/${normalize(file)}`);
  } catch (e) {
    return renderError(e);
  }

  return new Response(out.join(''), {
    status: notFound ? 404 : 200,
    headers: { 'content-type': `${options.text('contentType', 'text/html')}; charset=${options.text('charset', 'UTF-8')}` },
  });
}

export async function chooseThemeFile(store: ThemeFileStore, theme: string, archive: Archive, notFound: boolean): Promise<string | null> {
  const kind = archive.archiveType;
  const slug = archive.archiveSlug;
  const specific = /^[A-Za-z0-9_-]{1,150}$/.test(slug) ? `${kind}/${slug}.php` : '';
  const candidates = notFound ? ['404.php', 'index.php'] : [
    archive.themeFile,
    specific,
    `${kind}.php`,
    ...(kind === 'attachment' ? ['page.php', 'post.php'] : []),
    ...(kind === 'index' || kind === 'front' ? [] : [archive.archiveSingle ? 'single.php' : 'archive.php']),
    'index.php',
  ];
  for (const candidate of candidates) {
    if (candidate && await store.exists(theme, candidate)) return candidate;
  }
  return null;
}

function registerRuntimeWidgets(runtime: Runtime, deps: RenderDeps, options: SiteOptions, archive: Archive): void {
  const { db, request, echo } = deps;
  const rows = (loader: () => Promise<any[]>) =>
    new RowsWidget({ db, options, request, echo, loader, kind: 'contents' });
  const pages = () => new RowsWidget({ db, options, request, echo, loader: () => listPages(db), kind: 'contents' });

  runtime.addClass({
    kind: 'host',
    name: 'Widget\\Contents\\Page\\Rows',
    statics: { alloc: () => pages() },
  });
  runtime.addClass({
    kind: 'host',
    name: 'Widget\\Contents\\Post\\Recent',
    statics: {
      alloc: (parameter?: unknown) =>
        rows(() => listContents(db, { limit: Number(options.get('postsListSize') ?? 5) })),
    },
  });
  runtime.addClass({
    kind: 'host',
    name: 'Widget\\Contents\\Post\\Date',
    statics: { alloc: (parameter?: unknown) => dateArchiveRows(db, options, request, echo, parameter) },
  });
  runtime.addClass({
    kind: 'host',
    name: 'Widget\\Comments\\Recent',
    statics: {
      alloc: () =>
        new RowsWidget({
          db,
          options,
          request,
          echo,
          kind: 'comments',
          loader: () =>
            listRecentComments(db, Number(options.get('commentsListSize') ?? 5), options.get('commentsShowCommentOnly') !== false),
        }),
    },
  });
  runtime.addClass({
    kind: 'host',
    name: 'Widget\\Metas\\Category\\Rows',
    statics: {
      alloc: () => new RowsWidget({ db, options, request, echo, kind: 'metas', loader: () => listCategories(db) }),
    },
  });
  runtime.addClass({
    kind: 'host',
    name: 'Widget\\Archive',
    statics: {
      alloc: () => new Archive({ db, options, request, echo, type: 'index' }),
    },
  });
  runtime.addClass({ kind: 'host', name: 'Widget\\Options', statics: { alloc: () => options } });
  runtime.addClass({ kind: 'host', name: 'Widget\\Comments\\Archive', statics: { alloc: () => new CommentsWidget({ db, options, request, echo, cid: 0, respondId: 'comment-0', allowComment: false }) } });
}

async function renderNotFound(
  env: Env,
  db: Db,
  request: RequestContext,
  echo: (v: unknown) => void,
  out: string[],
  options: SiteOptions
): Promise<Response> {
  const theme = String(options.get('theme') ?? 'default');
  const store = new RuntimeThemeStore(env.BUCKET, parseInstalledThemes(options.get('installedThemes')));
  const source = await store.read(theme, '404.php');
  if (!source) return new Response('Not Found', { status: 404 });
  const encoder = new TextEncoder();
  let outputBytes = 0;
  const themeEcho = (value: unknown) => {
    const text = toStr(value);
    outputBytes += encoder.encode(text).byteLength;
    if (outputBytes > 2 * 1024 * 1024) throw new Error('Theme output limit exceeded');
    echo(text);
  };
  const runtime = createRuntime({ readFile: makeIncludeResolver(store, theme), echo: themeEcho, maxOperations: 100_000, timezoneOffset: Number(options.get('timezone') ?? 0) });
  const archive = new Archive({ db, options, request, echo: themeEcho, type: '404' });
  archive.archiveType = 'archive';
  archive.archiveSlug = '404';
  archive.titleText = '页面没找到';
  registerRuntimeWidgets(runtime, { env, db, request, echo: themeEcho }, options, archive);
  const interpreter = new Interpreter(runtime, { out, echo: themeEcho, runtime, file: `${theme}/404.php`, self: archive });
  archive.renderInclude = async (file: string) => {
    const target = normalize(file);
    const code = await store.read(theme, target);
    if (code === null) throw new PhpError(`Template "${target}" not found`);
    await interpreter.run(code, `${theme}/${target}`);
  };
  const functions = await store.read(theme, 'functions.php');
  if (functions) await interpreter.run(functions, `${theme}/functions.php`);
  try {
    await interpreter.run(source, `${theme}/404.php`);
  } catch (e) {
    return renderError(e);
  }
  return new Response(out.join(''), { status: 404, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

function renderError(error: unknown): Response {
  console.error('Worker request failed', error);
  return new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
}

export async function applyAdminPreferences(env: Env, request: Request, response: Response): Promise<Response> {
  const url = new URL(request.url);
  let refererPath = '';
  try { refererPath = request.headers.get('referer') ? new URL(request.headers.get('referer')!).pathname : ''; } catch { refererPath = ''; }
  const isAdminPage = /\/admin(?:\/|$)/.test(url.pathname);
  const isAdminAction = url.pathname.includes('/action/') && /\/admin(?:\/|$)/.test(refererPath);
  if (!isAdminPage && !isAdminAction) return response;

  const contentType = response.headers.get('content-type') ?? '';
  const isHtml = contentType.includes('text/html');
  const isPlainText = contentType.includes('text/plain');
  if (!isHtml && !isPlainText) return response;

  const db = new Db(env.DB, env.DB_PREFIX ?? 'typecho_');
  const rows = await db.all<{ name: string; value: string | null }>(
    "SELECT name, value FROM table.options WHERE user = 0 AND name IN ('adminTheme','adminMode','adminLocale')"
  );
  const preferences = Object.fromEntries(rows.map(({ name, value }) => [name, value ?? '']));
  const theme = ['official', 'green', 'ocean'].includes(preferences.adminTheme) ? preferences.adminTheme : 'official';
  const mode = preferences.adminMode === 'dark' ? 'dark' : 'light';
  const locale = preferences.adminLocale === 'en-US' ? 'en-US' : 'zh-CN';
  if (isPlainText) {
    const body = localizeAdminText(await response.text(), locale);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('etag');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }
  const html = localizeAdminHtml(await response.text(), locale);
  const themed = html.replace(/<html\b([^>]*)>/i, (_match, attributes: string) => {
    const clean = attributes
      .replace(/\slang=(?:\"[^\"]*\"|'[^']*')/i, '')
      .replace(/\sdata-admin-theme=(?:\"[^\"]*\"|'[^']*')/i, '')
      .replace(/\sdata-admin-mode=(?:\"[^\"]*\"|'[^']*')/i, '');
    return `<html${clean} lang=\"${locale}\" data-admin-theme=\"${theme}\" data-admin-mode=\"${mode}\">`;
  });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(themed, { status: response.status, statusText: response.statusText, headers });
}

function validPackageSlug(value: string | undefined): value is string {
  return validSlug(value);
}

function packageAssetContentType(extension: string): string {
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  };
  return types[extension] ?? 'application/octet-stream';
}

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/usr/themes/*', async (c) => {
    const path = new URL(c.req.url).pathname;
    const relative = path.slice('/usr/themes/'.length);
    let decoded: string;
    try { decoded = decodeURIComponent(relative); } catch { return new Response('Not Found', { status: 404 }); }
    const [slug, ...segments] = decoded.split('/');
    const assetPath = segments.join('/');
    const extension = assetPath.slice(assetPath.lastIndexOf('.')).toLowerCase();
    if (!validPackageSlug(slug) || !assetPath || assetPath.includes('\\') || assetPath.split('/').some((part) => !part || part === '.' || part === '..') ||
        !['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2', '.ttf', '.otf'].includes(extension)) {
      return new Response('Not Found', { status: 404 });
    }
    const db = new Db(c.env.DB, c.env.DB_PREFIX ?? 'typecho_');
    const row = await db.first<{ value: string | null }>("SELECT value FROM table.options WHERE name = 'installedThemes' AND user = 0");
    let packages: unknown = [];
    try { packages = JSON.parse(row?.value ?? '[]'); } catch { packages = []; }
    const pkg = parseInstalledThemes(packages).find((item) => item.slug === slug);
    if (!pkg) return c.env.ASSETS.fetch(c.req.raw);
    const object = await c.env.BUCKET.get(`${pkg.prefix}/assets/${assetPath}`);
    if (!object) return c.env.ASSETS.fetch(c.req.raw);
    return new Response(object.body, {
      headers: {
        'content-type': packageAssetContentType(extension),
        etag: object.httpEtag,
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.get('/usr/uploads/*', async (c) => {
    const key = new URL(c.req.url).pathname.replace(/^\/usr\/uploads\//, 'uploads/');
    const object = await c.env.BUCKET.get(key);
    if (!object) return new Response('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        etag: object.httpEtag,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.all('*', async (c) => {
    try {
      const response = await renderSite(c.env, c.req.raw);
      return await applyAdminPreferences(c.env, c.req.raw, response);
    } catch (error) {
      return renderError(error);
    }
  });

  return app;
}
