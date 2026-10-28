import { PHP_HOST, type PhpHost } from '../../php-compat/host';
import { findCurrentUser, securityToken, type AuthUser } from './auth';
import { PhpArray } from '../../php-compat/values';
import { buildUrl, url as joinUrl } from './common';
import type { Db } from './db';
import type { RequestContext } from './request';
import { getRouter, type Router } from './router';

export type OptionValues = Record<string, any>;

export interface OptionsLoadResult {
  values: OptionValues;
  router: Router;
}

/** Loads `options` rows plus the active theme's option overrides. */
export async function loadOptionValues(db: Db): Promise<OptionValues> {
  const rows = await db.all<{ name: string; value: string | null }>(`SELECT name, value FROM table.options WHERE user = 0`);
  const raw: Record<string, string | null> = {};
  for (const row of rows) raw[row.name] = row.value;

  const values: OptionValues = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith('theme:')) continue;
    values[name] = parseValue(value);
  }

  // Theme options are merged over the global ones, like Typecho's Options widget.
  const themeKey = `theme:${values.theme}`;
  const themeOptions = parseValue(raw[themeKey] ?? null);
  if (themeOptions && typeof themeOptions === 'object') Object.assign(values, themeOptions);
  return values;
}

function parseValue(value: string | null): any {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

export interface SiteOptionsInit {
  values: OptionValues;
  request: RequestContext;
  echo: (value: unknown) => void;
  siteUrl?: string;
  user?: AuthUser | null;
}

/**
 * Host object for `Widget\Options`. Reading a property returns the raw value,
 * calling a method echoes it - exactly like Typecho's `__get` / `__call`.
 */
export class SiteOptions implements PhpHost {
  readonly [PHP_HOST] = true as const;
  readonly values: OptionValues;
  readonly request: RequestContext;
  readonly router: Router;
  readonly derived: Record<string, any>;
  private readonly echo: (value: unknown) => void;
  private readonly user: AuthUser | null;

  constructor(init: SiteOptionsInit) {
    this.values = init.values;
    this.request = init.request;
    this.echo = init.echo;
    this.user = init.user ?? null;
    this.router = getRouter((init.values.routingTable ?? {}) as Record<string, any>);
    this.derived = this.computeDerived(init.siteUrl);
  }

  private computeDerived(siteUrlOverride?: string): Record<string, any> {
    const rootUrl = this.request.rootUrl;
    const originalSiteUrl = siteUrlOverride || this.values.siteUrl || rootUrl;
    let siteUrl = joinUrl('', originalSiteUrl);
    if (this.request.isSecure && siteUrl.startsWith('http://')) {
      siteUrl = `https://${siteUrl.slice(7)}`;
    }
    const index = this.values.rewrite ? rootUrl : joinUrl('index.php', rootUrl);
    const theme = this.values.theme ?? 'default';
    const themeUrl = joinUrl(`/usr/themes/${theme}`, siteUrl);
    const adminUrl = joinUrl('/admin/', rootUrl);
    const pluginUrl = joinUrl('/usr/plugins', siteUrl);
    const secret = String(this.values.secret ?? '');
    const tokenSuffix = `${this.request.url.origin}${this.request.url.pathname}${this.request.url.search}`;

    return {
      rootUrl,
      originalSiteUrl,
      siteUrl,
      index,
      themeUrl,
      pluginUrl,
      pluginDir: '/usr/plugins',
      adminUrl,
      loginUrl: joinUrl('login.php', adminUrl),
      registerUrl: joinUrl('register.php', adminUrl),
      profileUrl: joinUrl('profile.php', adminUrl),
      feedUrl: this.router.url('feed', { feed: '/' }, index),
      feedRssUrl: this.router.url('feed', { feed: '/rss/' }, index),
      feedAtomUrl: this.router.url('feed', { feed: '/atom/' }, index),
      commentsFeedUrl: this.router.url('feed', { feed: '/comments/' }, index),
      commentsFeedRssUrl: this.router.url('feed', { feed: '/rss/comments/' }, index),
      commentsFeedAtomUrl: this.router.url('feed', { feed: '/atom/comments/' }, index),
      xmlRpcUrl: this.router.url('do', { action: 'xmlrpc' }, index),
      logoutUrl: this.tokenUrl(joinUrl('/action/logout', rootUrl), secret, tokenSuffix, this.user),
      siteDomain: (() => {
        try {
          return new URL(siteUrl).hostname;
        } catch {
          return '';
        }
      })(),
      time: Math.floor(Date.now() / 1000),
      serverTimezone: 0,
      charset: 'UTF-8',
      contentType: 'text/html',
      generator: `Typecho ${this.values.version ?? '1.3.1'}`,
      software: 'Typecho',
      version: this.values.version ?? '1.3.1',
      loginAction: this.tokenUrl(joinUrl('/action/login', rootUrl), secret, tokenSuffix),
      registerAction: this.tokenUrl(this.router.url('do', { action: 'register', widget: 'Register' }, index), secret, tokenSuffix),
    };
  }

  private tokenUrl(path: string, secret: string, suffix: string, user?: AuthUser | null): string {
    const token = securityToken(secret, suffix.split('#')[0], user);
    try {
      const parsed = new URL(path);
      parsed.searchParams.set('_', token);
      return parsed.toString();
    } catch {
      const [base, query = ''] = path.split('?');
      const params = new URLSearchParams(query);
      params.set('_', token);
      return `${base}?${params.toString()}`;
    }
  }

  get currentUser(): AuthUser | null {
    return this.user;
  }

  get(name: string): any {
    if (name in this.derived) return this.derived[name];
    return this.values[name];
  }

  phpGet(name: string): unknown {
    return this.get(name);
  }

  phpCall(name: string, args: unknown[]): unknown {
    if (name === 'themeUrl' && args.length > 1) {
      const theme = String(args[1] ?? this.values.theme);
      const base = joinUrl(`/usr/themes/${theme}`, this.derived.siteUrl);
      return args[0] ? joinUrl(String(args[0]), base) : base;
    }
    if (name === 'pluginUrl' && args.length > 1) {
      return joinUrl(String(args[0]), String(args[1]));
    }
    if (name === 'plugin') {
      return this.pluginConfig(String(args[0]));
    }
    if (name === 'adminStaticUrl') {
      const base = joinUrl(String(args[0]), this.derived.adminUrl);
      const file = args[1] ? `${joinUrl(String(args[1]), base)}?v=${this.derived.version}` : base;
      return file;
    }

    const value = this.get(name);
    if (typeof value === 'function') return value(...args);
    if (name === 'siteUrl' || name === 'index' || name === 'themeUrl' || name === 'pluginUrl' || name === 'adminUrl') {
      const result = args[0] ? joinUrl(String(args[0]), this.derived[name]) : this.derived[name];
      this.echo(result);
      return undefined;
    }
    if (name === 'commentsHTMLTagAllowed') {
      this.echo(this.values.commentsHTMLTagAllowed ?? '');
      return undefined;
    }
    this.echo(value ?? '');
    return undefined;
  }

  pluginConfig(pluginName: string): PhpArray {
    const key = `plugin:${pluginName}`;
    const raw = this.values[key];
    if (!raw) return new PhpArray();
    const parsed = parseValue(raw);
    return parsed instanceof PhpArray ? parsed : new PhpArray(Object.entries(parsed ?? {}));
  }

  /** Convenience for TS-side widgets. */
  text(name: string, fallback = ''): string {
    const value = this.get(name);
    return value === null || value === undefined ? fallback : String(value);
  }

  get routerTable(): Record<string, any> {
    return (this.values.routingTable ?? {}) as Record<string, any>;
  }

  buildUrl(path: string | null): string {
    return buildUrl({ path: path ?? '' });
  }
}

export async function loadOptions(db: Db, request: RequestContext, echo: (v: unknown) => void, siteUrl?: string): Promise<SiteOptions> {
  const values = await loadOptionValues(db);
  const user = await findCurrentUser(db, request);
  return new SiteOptions({ values, request, echo, siteUrl, user });
}
