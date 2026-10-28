import { Hono } from 'hono';
import { Interpreter } from '../php-compat/interpreter';
import { createRuntime, type ExecContext, type Runtime } from '../php-compat/index';
import { PhpError } from '../php-compat/errors';
import { toStr } from '../php-compat/values';
import type { Env } from './env';
import { Db } from './core/db';
import { buildRequestContext, type RequestContext } from './core/request';
import { loadOptions, type SiteOptions } from './core/options';
import { BundledThemeStore, makeIncludeResolver, normalize } from './core/theme';
import { listCategories, listContents, listPages, listRecentComments } from './repo/content';
import { handleAuthRequest, isInstallationComplete, renderInstaller } from './core/install-auth';
import { handleAdminContentRequest } from './core/admin-content';
import { handleAdminSettingsRequest } from './core/admin-settings';
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
 * Renders a site request through the theme templates.
 */
export async function renderSite(env: Env, rawRequest: Request): Promise<Response> {
  const request = buildRequestContext(rawRequest);
  const db = new Db(env.DB, env.DB_PREFIX ?? 'typecho_');
  const out: string[] = [];
  const echo = (value: unknown) => out.push(toStr(value));
  const options = await loadOptions(db, request, echo, env.SITE_URL);

  if (!(await isInstallationComplete(db))) return renderInstaller(db, request);

  const authResponse = await handleAuthRequest(db, request, String(options.get('secret') ?? ''), options);
  if (authResponse) return authResponse;
  const contentResponse = await handleAdminContentRequest(db, request, String(options.get('secret') ?? ''));
  if (contentResponse) return contentResponse;
  const settingsResponse = await handleAdminSettingsRequest(db, request, String(options.get('secret') ?? ''));
  if (settingsResponse) return settingsResponse;
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
    if (!parent || !['post', 'page'].includes(parent.route.name)) {
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
  const store = new BundledThemeStore();
  const runtime = createRuntime({
    readFile: makeIncludeResolver(store, theme),
    timezoneOffset: Number(options.get('timezone') ?? 0),
    echo,
  });

  const archive = new Archive({ db, options, request, echo, params, type: routeName });

  // Static widget classes need the live request context (options, db, echo).
  registerRuntimeWidgets(runtime, deps, options, archive);

  const ctx: ExecContext = {
    out,
    echo,
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

async function chooseThemeFile(store: BundledThemeStore, theme: string, archive: Archive, notFound: boolean): Promise<string | null> {
  const kind = archive.archiveType;
  const slug = archive.archiveSlug;
  const specific = /^[A-Za-z0-9_-]{1,150}$/.test(slug) ? `${kind}/${slug}.php` : '';
  let candidates: string[];
  if (notFound) candidates = ['404.php', 'index.php'];
  else if (kind === 'index' || kind === 'front') candidates = ['index.php'];
  else if (kind === 'page') candidates = ['page.php', 'single.php', 'index.php'];
  else if (kind === 'post') candidates = ['post.php', 'single.php', 'index.php'];
  else if (kind === 'attachment') candidates = ['attachment.php', 'page.php', 'single.php', 'index.php'];
  else if (kind === 'category' || kind === 'tag') candidates = [specific, `${kind}.php`, 'archive.php', 'index.php'];
  else if (kind === 'search' || kind === 'author' || kind === 'date') candidates = [`${kind}.php`, 'archive.php', 'index.php'];
  else candidates = ['archive.php', 'index.php'];
  if (archive.themeFile && !notFound) candidates.unshift(archive.themeFile);
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
  const store = new BundledThemeStore();
  const source = await store.read(theme, '404.php');
  if (!source) return new Response('Not Found', { status: 404 });
  const runtime = createRuntime({ readFile: makeIncludeResolver(store, theme), echo, timezoneOffset: Number(options.get('timezone') ?? 0) });
  const archive = new Archive({ db, options, request, echo, type: '404' });
  archive.archiveType = 'archive';
  archive.archiveSlug = '404';
  archive.titleText = '页面没找到';
  registerRuntimeWidgets(runtime, { env, db, request, echo }, options, archive);
  const interpreter = new Interpreter(runtime, { out, echo, runtime, file: `${theme}/404.php`, self: archive });
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

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/usr/uploads/*', async (c) => {
    const key = new URL(c.req.url).pathname.replace(/^\/usr\/uploads\//, 'uploads/');
    const object = await c.env.BUCKET.get(key);
    if (!object) return c.notFound();
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        etag: object.httpEtag,
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  });

  app.all('*', async (c) => {
    try {
      return await renderSite(c.env, c.req.raw);
    } catch (error) {
      return renderError(error);
    }
  });

  return app;
}
