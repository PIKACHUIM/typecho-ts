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
import { escapeHtml } from './core/common';
import { listCategories, listContents, listPages, listRecentComments } from './repo/content';
import { Archive } from './widgets/archive';
import { CommentsWidget } from './widgets/comments';
import { RowsWidget } from './widgets/rows';

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

  if (!options.get('installed')) {
    return new Response('Missing Config File', { status: 503, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
  }

  const match = options.router.match(request.pathInfo);
  if (!match) return renderNotFound(env, db, request, echo, out, options);

  const widgetName = String(match.route.widget ?? '');
  const action = match.route.action;

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

  const notFound = !(await archive.have());
  let file = archive.themeFile;
  if (!file) {
    if (archive.archiveType === 'page') file = 'page.php';
    else if (archive.archiveType === 'post' || archive.archiveType === 'attachment') file = 'post.php';
    else if (archive.archiveType === 'index' || archive.archiveType === 'front') file = 'index.php';
    else file = (await store.exists(theme, 'archive.php')) ? 'archive.php' : 'index.php';
  }
  if (notFound) {
    archive.archiveType = 'archive';
    archive.archiveSlug = '404';
    archive.themeFile = '404.php';
    file = '404.php';
  }

  const source = await store.read(theme, normalize(file));
  if (source === null) {
    return new Response(`Template "${file}" not found`, { status: 500 });
  }

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
    statics: { alloc: () => new RowsWidget({ db, options, request, echo, rows: [], kind: 'contents' }) },
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
  const runtime = createRuntime({ readFile: makeIncludeResolver(store, theme), echo });
  const archive = new Archive({ db, options, request, echo, type: '404' });
  runtime.addClass({ kind: 'host', name: 'Widget\\Contents\\Page\\Rows', statics: { alloc: () => new RowsWidget({ db, options, request, echo, loader: () => listPages(db) }) } });
  runtime.addClass({ kind: 'host', name: 'Widget\\Comments\\Recent', statics: { alloc: () => new RowsWidget({ db, options, request, echo, rows: [], kind: 'comments' }) } });
  runtime.addClass({ kind: 'host', name: 'Widget\\Metas\\Category\\Rows', statics: { alloc: () => new RowsWidget({ db, options, request, echo, rows: [], kind: 'metas' }) } });
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
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? '' : '';
  const html = `<pre><code><h1>${escapeHtml(message)}</h1>${escapeHtml(stack)}</code></pre>`;
  return new Response(html, { status: 500, headers: { 'content-type': 'text/html; charset=UTF-8' } });
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
