import { url } from './common';

export interface RequestContext {
  method: string;
  url: URL;
  pathInfo: string;
  query: URLSearchParams;
  headers: Headers;
  cookies: Map<string, string>;
  isSecure: boolean;
  /** Origin + installation base path, without trailing slash. */
  rootUrl: string;
  referer: string;
  userAgent: string;
  ip: string;
  isAjax: boolean;
  isPost: boolean;
  body?: () => Promise<FormData | null>;
}

export function parseCookies(header: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) map.set(key, decodeURIComponent(value));
  }
  return map;
}

/**
 * Typecho's path info strips the query string (and a leading `/index.php`).
 * `/` is used for the site root, matching Router's `|^[/]?$|` for the index route.
 */
export function pathInfoFromUrl(url: URL): string {
  let path = url.pathname || '/';
  const indexPos = path.indexOf('/index.php');
  if (indexPos === 0) path = path.slice('/index.php'.length) || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  return path;
}

export interface BuildRequestOptions {
  basePath?: string;
}

export function buildRequestContext(request: Request, options: BuildRequestOptions = {}): RequestContext {
  const url = new URL(request.url);
  const basePath = (options.basePath ?? '').replace(/\/+$/, '');
  const rootUrl = `${url.protocol}//${url.host}${basePath}`;
  const headers = request.headers;
  return {
    method: request.method,
    url,
    pathInfo: pathInfoFromUrl(url),
    query: url.searchParams,
    headers,
    cookies: parseCookies(headers.get('cookie')),
    isSecure: url.protocol === 'https:',
    rootUrl,
    referer: headers.get('referer') ?? '',
    userAgent: headers.get('user-agent') ?? '',
    ip: headers.get('cf-connecting-ip') ?? '',
    isAjax: (headers.get('x-requested-with') ?? '').toLowerCase() === 'xmlhttprequest',
    isPost: request.method.toUpperCase() === 'POST',
    body: async () => {
      try {
        return await request.formData();
      } catch {
        return null;
      }
    },
  };
}

/** Typecho\Common::url with the request's root URL. */
export function absoluteUrl(request: RequestContext, path?: string | null): string {
  return url(path ?? '', request.rootUrl);
}

export function currentRequestUrl(request: RequestContext): string {
  return `${request.rootUrl}${request.url.pathname}${request.url.search}`;
}
