/** Ports of the Typecho\Common helpers that templates and widgets depend on. */

/** Typecho\Common::url($path, $prefix) */
export function url(path: string | null | undefined, prefix: string | null | undefined): string {
  let p = path ?? '';
  if (p.startsWith('./')) p = p.slice(2);
  const base = (prefix ?? '').replace(/\/+$/, '');
  return `${base}/${p.replace(/^\/+/, '').replace(/\/\//g, '/')}`;
}

/** Typecho\Common::subStr($str, $start, $length, $trim) */
export function subStr(str: string, start: number, length: number, trim = '...'): string {
  if (!str) return '';
  const chars = [...str];
  const iLength = chars.length - start;
  const tLength = length < iLength ? length - [...trim].length : length;
  const sliced = chars.slice(start, start + Math.max(0, tLength)).join('');
  return length < iLength ? sliced + trim : sliced;
}

/** Typecho\Common::fixHtml($string) - closes unclosed tags after a truncation. */
export function fixHtml(input: string | null): string {
  if (!input) return '';
  let string = input;
  const startPos = string.lastIndexOf('<');
  if (startPos !== -1) {
    const trimString = string.slice(startPos);
    if (!trimString.includes('>')) string = string.slice(0, startPos);
  }

  const startTags = [...string.matchAll(/<([_0-9a-zA-Z-:]+)\s*([^>]*)>/gi)].reverse();
  const closeTags = new Set([...string.matchAll(/<\/([_0-9a-zA-Z-:]+)>/gi)].map((m) => m[1].toLowerCase()));

  for (const tag of startTags) {
    const name = tag[1];
    const attrs = tag[2] ?? '';
    if (attrs.trim().endsWith('/')) continue;
    if (!closeTags.has(name.toLowerCase())) {
      string += `</${name}>`;
      closeTags.add(name.toLowerCase());
    }
  }

  return string;
}

/** Typecho\Common::randString($length) */
export function randString(length: number, special = false): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' + (special ? '~!@#$%^&*()_+[]{}|;:,.<>?' : '');
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

export function mimeContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
    zip: 'application/zip',
    txt: 'text/plain',
    md: 'text/markdown',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Parses a `key=value&key2=value2` option string (Typecho's `parseOption`). */
export function parseOption(input: unknown): Record<string, string> {
  if (!input) return {};
  if (typeof input === 'object') return input as Record<string, string>;
  const out: Record<string, string> = {};
  for (const part of String(input).split('&')) {
    if (!part) continue;
    const [k, v = ''] = part.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

/** Typecho\Common::buildUrl($parts) */
export function buildUrl(parts: { scheme?: string; host?: string; port?: number; path?: string; query?: string; fragment?: string }): string {
  let out = '';
  if (parts.scheme) out += `${parts.scheme}://`;
  if (parts.host) out += parts.host;
  if (parts.port) out += `:${parts.port}`;
  out += parts.path ?? '';
  if (parts.query) out += `?${parts.query}`;
  if (parts.fragment) out += `#${parts.fragment}`;
  return out;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
