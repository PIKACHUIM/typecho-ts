import { url as buildUrl } from './common';

export interface RawRoute {
  url: string;
  widget: string;
  action?: string;
}

export interface CompiledRoute extends RawRoute {
  name: string;
  regx: RegExp;
  params: string[];
  format: string;
}

const PARAM_PATTERNS: Record<string, string> = {
  string: '(.{quant})',
  char: '([^/]{quant})',
  digital: '([0-9]{quant})',
  alpha: '([_0-9a-zA-Z-]{quant})',
  alphaslash: '([_0-9a-zA-Z-/]{quant})',
  split: '((?:[^/]+/){quant}[^/]+)',
};

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quantifier(quant: string): string {
  if (quant === '+') return '+';
  if (quant === '*') return '*';
  return quant.startsWith('{') ? quant : `{${quant}}`;
}

/** Port of Typecho\Router\Parser::parse() */
export function compileRoutingTable(table: Record<string, RawRoute>): CompiledRoute[] {
  const routes: CompiledRoute[] = [];
  for (const [name, route] of Object.entries(table)) {
    const params: string[] = [];
    const prepared = escapeRegExp(route.url.replace(/\[/g, '%').replace(/\]/g, '%').replace(/:/g, ' '));

    const regxSource = prepared.replace(/%([^%]+)%/g, (_match, inner: string) => {
      const parts = inner.split(' ');
      params.push(parts[0]);
      if (parts.length === 1) return PARAM_PATTERNS.char.replace('{quant}', '+');
      const base = PARAM_PATTERNS[parts[1]] ?? PARAM_PATTERNS.char;
      if (parts.length === 2) return base.replace('{quant}', '+');
      if (parts.length === 3) return base.replace('{quant}', Number(parts[2]) > 0 ? `{${parts[2]}}` : '*');
      if (parts.length === 4) return base.replace('{quant}', `{${parts[2]},${parts[3]}}`);
      return _match;
    });

    const normalized = regxSource.replace(/\/+$/, '');
    routes.push({
      ...route,
      name,
      params,
      format: route.url.replace(/\[([^\]]+)\]/g, '%s'),
      regx: new RegExp(`^${normalized}[/]?$`),
    });
  }
  return routes;
}

export interface RouteMatch {
  route: CompiledRoute;
  params: Record<string, string> | null;
}

export class Router {
  constructor(readonly routes: CompiledRoute[]) {}

  static from(table: Record<string, RawRoute>): Router {
    return new Router(compileRoutingTable(table));
  }

  match(pathInfo: string): RouteMatch | null {
    for (const route of this.routes) {
      const match = route.regx.exec(pathInfo);
      if (!match) continue;
      let params: Record<string, string> | null = null;
      if (route.params.length > 0) {
        params = {};
        route.params.forEach((name, index) => {
          params![name] = match[index + 1];
        });
      }
      return { route, params };
    }
    return null;
  }

  /** Port of Typecho\Router::url() */
  url(name: string, value: Record<string, string> | string | null = null, prefix?: string | null): string {
    const route = this.routes.find((r) => r.name === name);
    if (!route) return '#';

    let index = 0;
    const format = route.format;
    const formatted = format.replace(/%s/g, () => {
      const param = route.params[index++];
      if (value && typeof value === 'object' && param in value) return String(value[param]);
      if (typeof value === 'string' && index === 1) return value;
      return `{${param}}`;
    });

    return buildUrl(formatted, prefix ?? '');
  }

  get(name: string): CompiledRoute | undefined {
    return this.routes.find((r) => r.name === name);
  }
}

const routerCache = new Map<string, Router>();
const ROUTER_CACHE_LIMIT = 32;

/** Caches compiled tables per isolate (options can change at runtime). */
export function getRouter(table: Record<string, RawRoute>): Router {
  const key = JSON.stringify(table);
  const cached = routerCache.get(key);
  if (cached) return cached;
  const router = Router.from(table);
  if (routerCache.size >= ROUTER_CACHE_LIMIT) {
    const oldest = routerCache.keys().next().value;
    if (oldest) routerCache.delete(oldest);
  }
  routerCache.set(key, router);
  return router;
}
