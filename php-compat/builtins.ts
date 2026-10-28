import { md5 } from './md5';
import { PhpError } from './errors';
import { isPhpHost } from './host';
import {
  PhpArray,
  isNumericString,
  looseEq,
  normalizeKey,
  toInt,
  toNum,
  toStr,
  truthy,
} from './values';
import { PhpObject, Runtime } from './runtime';
import { dateFormat } from './date';
import { encodePhpSerialized, parsePhpSerialized } from './serialize';

function arr(v: unknown): PhpArray {
  if (v instanceof PhpArray) return v;
  if (Array.isArray(v)) return new PhpArray(v.map((item, i) => [i, item] as [number, unknown]));
  if (v && typeof v === 'object') return PhpArray.fromObject(v as Record<string, unknown>);
  return new PhpArray();
}

function toJs(v: unknown): unknown {
  if (v instanceof PhpArray) {
    const isList = v.keys().every((k, i) => typeof k === 'number' && k === i);
    if (isList) return v.values().map(toJs);
    const out: Record<string, unknown> = {};
    for (const [k, val] of v) out[String(k)] = toJs(val);
    return out;
  }
  if (v instanceof PhpObject) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of v.props) out[k] = toJs(val);
    return out;
  }
  return v;
}

function fromJs(v: unknown): unknown {
  if (Array.isArray(v)) return new PhpArray(v.map((item, i) => [i, fromJs(item)] as [number, unknown]));
  if (v && typeof v === 'object') {
    const out = new PhpArray();
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out.set(k, fromJs(val));
    return out;
  }
  return v;
}

function sprintf(format: string, args: unknown[]): string {
  let index = 0;
  return format.replace(/%(-?\d+)?(?:\.(\d+))?([%bcdeEfFgGosuxX])/g, (_m, width, precision, type) => {
    if (type === '%') return '%';
    const value = args[index++];
    let out: string;
    switch (type) {
      case 's':
        out = toStr(value);
        break;
      case 'd':
      case 'u':
        out = String(toInt(value));
        break;
      case 'f':
      case 'F':
        out = precision !== undefined ? toNum(value).toFixed(Number(precision)) : String(toNum(value));
        break;
      case 'e':
      case 'E':
        out = toNum(value).toExponential(precision !== undefined ? Number(precision) : undefined);
        if (type === 'E') out = out.toUpperCase();
        break;
      case 'x':
        out = toInt(value).toString(16);
        break;
      case 'X':
        out = toInt(value).toString(16).toUpperCase();
        break;
      case 'o':
        out = toInt(value).toString(8);
        break;
      case 'b':
        out = toInt(value).toString(2);
        break;
      case 'c':
        out = String.fromCharCode(toInt(value));
        break;
      case 'g':
      case 'G':
        out = String(Number(toNum(value).toPrecision(precision !== undefined ? Number(precision) : 6)));
        break;
      default:
        out = toStr(value);
    }
    if (width) {
      const w = Number(width);
      if (w > 0) out = out.padStart(w, ' ');
      else if (w < 0) out = out.padEnd(-w, ' ');
    }
    return out;
  });
}

function regExpFromPhp(pattern: string, flags: string): RegExp {
  const match = pattern.match(/^(.)([\s\S]*)\1([a-z]*)$/);
  if (!match) throw new PhpError(`preg pattern is not valid: ${pattern}`);
  let [, , body, phpFlags] = match;
  const allFlags = flags || phpFlags;
  const jsFlags = new Set<string>();
  if (allFlags.includes('i')) jsFlags.add('i');
  if (allFlags.includes('m')) jsFlags.add('m');
  if (allFlags.includes('s')) jsFlags.add('s');
  if (allFlags.includes('u')) jsFlags.add('u');
  if (allFlags.includes('g')) jsFlags.add('g');
  body = body
    .replace(/\(\?P<([\w]+)>/g, '(?<$1>')
    .replace(/\(\?'/g, '(?<');
  return new RegExp(body, [...jsFlags].join(''));
}

function htmlspecialchars(value: unknown, flags = 3, _charset?: unknown, doubleEncode = true): string {
  let out = toStr(value);
  if (doubleEncode) out = out.replace(/&/g, '&amp;');
  out = out.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if ((Number(flags) & 2) === 2) out = out.replace(/"/g, '&quot;');
  if ((Number(flags) & 1) === 1) out = out.replace(/'/g, '&#039;');
  return out;
}

export function registerBuiltins(runtime: Runtime): void {
  const def = (name: string, fn: (...args: any[]) => unknown) => runtime.addFunction(name, fn);
  const offset = () => runtime.host.timezoneOffset ?? 0;

  // i18n fallbacks (the app overrides these with real .mo translations).
  def('_t', (s: unknown, ...args: unknown[]) => (args.length > 0 ? sprintf(toStr(s), args) : toStr(s)));
  def('_e', (s: unknown, ...args: unknown[]) => {
    runtime.host.echo?.(args.length > 0 ? sprintf(toStr(s), args) : toStr(s));
    return undefined;
  });
  def('_n', (single: unknown, plural: unknown, n: unknown) => (toInt(n) === 1 ? toStr(single) : toStr(plural)));

  // ---------------------------------------------------------------- strings
  def('htmlspecialchars', htmlspecialchars);
  def('htmlentities', htmlspecialchars);
  def('htmlspecialchars_decode', (s: unknown) => toStr(s).replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  def('html_entity_decode', (s: unknown) => toStr(s).replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'));
  def('strip_tags', (s: unknown) => toStr(s).replace(/<[^>]*>/g, ''));
  def('nl2br', (s: unknown) => toStr(s).replace(/\r\n|\r|\n/g, '<br />\n'));
  def('trim', (s: unknown, chars?: unknown) => trimWith(s, chars, true, true));
  def('ltrim', (s: unknown, chars?: unknown) => trimWith(s, chars, true, false));
  def('rtrim', (s: unknown, chars?: unknown) => trimWith(s, chars, false, true));
  def('strlen', (s: unknown) => [...toStr(s)].length);
  def('mb_strlen', (s: unknown) => [...toStr(s)].length);
  def('substr', (s: unknown, start: unknown, length?: unknown) => substr(toStr(s), toInt(start), length === undefined ? undefined : toInt(length)));
  def('mb_substr', (s: unknown, start: unknown, length?: unknown) => substr(toStr(s), toInt(start), length === undefined ? undefined : toInt(length)));
  def('strtolower', (s: unknown) => toStr(s).toLowerCase());
  def('strtoupper', (s: unknown) => toStr(s).toUpperCase());
  def('mb_strtolower', (s: unknown) => toStr(s).toLowerCase());
  def('mb_strtoupper', (s: unknown) => toStr(s).toUpperCase());
  def('ucfirst', (s: unknown) => {
    const str = toStr(s);
    return str.charAt(0).toUpperCase() + str.slice(1);
  });
  def('lcfirst', (s: unknown) => {
    const str = toStr(s);
    return str.charAt(0).toLowerCase() + str.slice(1);
  });
  def('ucwords', (s: unknown) => toStr(s).replace(/\b\w/g, (c) => c.toUpperCase()));
  def('str_replace', (search: unknown, replace: unknown, subject: unknown) => {
    const map = (v: unknown) => (v instanceof PhpArray ? v.values() : [v]);
    const searches = map(search);
    const replaces = map(replace);
    const apply = (s: string) => {
      let out = s;
      searches.forEach((item, i) => {
        out = out.split(toStr(item)).join(toStr(replaces[i] ?? replaces[0] ?? ''));
      });
      return out;
    };
    if (subject instanceof PhpArray) {
      const out = new PhpArray();
      for (const [k, v] of subject) out.set(k, apply(toStr(v)));
      return out;
    }
    return apply(toStr(subject));
  });
  def('str_ireplace', (search: unknown, replace: unknown, subject: unknown) => {
    const s = toStr(search);
    const r = toStr(replace);
    const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return toStr(subject).replace(re, r);
  });
  def('str_repeat', (s: unknown, times: unknown) => toStr(s).repeat(Math.max(0, toInt(times))));
  def('str_pad', (s: unknown, length: unknown, pad?: unknown, type?: unknown) => {
    const str = toStr(s);
    const len = toInt(length);
    const padStr = (pad === undefined ? ' ' : toStr(pad)) || ' ';
    const mode = type === undefined ? 1 : type === 'STR_PAD_LEFT' ? 0 : type === 'STR_PAD_BOTH' ? 2 : toInt(type);
    if (str.length >= len) return str;
    const total = len - str.length;
    const make = (n: number) => padStr.repeat(Math.ceil(n / padStr.length)).slice(0, n);
    if (mode === 0) return make(total) + str;
    if (mode === 2) {
      const left = Math.floor(total / 2);
      return make(left) + str + make(total - left);
    }
    return str + make(total);
  });
  def('str_contains', (h: unknown, n: unknown) => toStr(h).includes(toStr(n)));
  def('str_starts_with', (h: unknown, n: unknown) => toStr(h).startsWith(toStr(n)));
  def('str_ends_with', (h: unknown, n: unknown) => toStr(h).endsWith(toStr(n)));
  def('strpos', (h: unknown, n: unknown, offset?: unknown) => {
    const index = toStr(h).indexOf(toStr(n), offset === undefined ? 0 : toInt(offset));
    return index === -1 ? false : index;
  });
  def('stripos', (h: unknown, n: unknown) => {
    const index = toStr(h).toLowerCase().indexOf(toStr(n).toLowerCase());
    return index === -1 ? false : index;
  });
  def('strrpos', (h: unknown, n: unknown) => {
    const index = toStr(h).lastIndexOf(toStr(n));
    return index === -1 ? false : index;
  });
  def('mb_strpos', (h: unknown, n: unknown) => {
    const index = toStr(h).indexOf(toStr(n));
    return index === -1 ? false : index;
  });
  def('substr_count', (h: unknown, n: unknown) => toStr(h).split(toStr(n)).length - 1);
  def('sprintf', (format: unknown, ...args: unknown[]) => sprintf(toStr(format), args));
  def('vsprintf', (format: unknown, args: unknown) => sprintf(toStr(format), arr(args).values()));
  def('printf', (format: unknown, ...args: unknown[]) => sprintf(toStr(format), args));
  def('number_format', (num: unknown, decimals?: unknown, decPoint?: unknown, thousands?: unknown) => {
    const d = decimals === undefined ? 0 : toInt(decimals);
    const fixed = toNum(num).toFixed(d);
    const [intPart, decPart] = fixed.split('.');
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousands === undefined ? ',' : toStr(thousands));
    return decPart ? `${grouped}${decPoint === undefined ? '.' : toStr(decPoint)}${decPart}` : grouped;
  });
  def('wordwrap', (text: unknown, width = 75, br = '\n', cut = false) => {
    const words = toStr(text).split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      if (line.length + word.length + 1 > Number(width)) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    return lines.join(toStr(br));
  });
  def('implode', (glue: unknown, pieces?: unknown) => {
    if (pieces === undefined) return arr(glue).values().map(toStr).join('');
    return arr(pieces).values().map(toStr).join(toStr(glue));
  });
  def('join', (glue: unknown, pieces?: unknown) => (pieces === undefined ? arr(glue).values().map(toStr).join('') : arr(pieces).values().map(toStr).join(toStr(glue))));
  def('explode', (delimiter: unknown, s: unknown, limit?: unknown) => {
    const parts = toStr(s).split(toStr(delimiter));
    const outParts = limit === undefined ? parts : toInt(limit) > 0 ? parts.slice(0, toInt(limit)) : parts;
    return new PhpArray(outParts.map((p, i) => [i, p] as [number, string]));
  });
  def('urlencode', (s: unknown) => encodeURIComponent(toStr(s)).replace(/%20/g, '+'));
  def('rawurlencode', (s: unknown) => encodeURIComponent(toStr(s)));
  def('urldecode', (s: unknown) => decodeURIComponent(toStr(s).replace(/\+/g, ' ')));
  def('rawurldecode', (s: unknown) => decodeURIComponent(toStr(s)));
  def('base64_encode', (s: unknown) => base64Encode(toStr(s)));
  def('base64_decode', (s: unknown) => base64Decode(toStr(s)));
  def('md5', (s: unknown) => md5(toStr(s)));
  def('sha1', async (s: unknown) => hashHex('SHA-1', toStr(s)));
  def('hash', async (algo: unknown, s: unknown) => hashHex(toStr(algo).toUpperCase().replace('-', ''), toStr(s)));
  def('crc32', (s: unknown) => crc32(toStr(s)));
  def('str_word_count', (s: unknown) => toStr(s).split(/\s+/).filter(Boolean).length);

  // ----------------------------------------------------------------- arrays
  def('count', (v: unknown) => (v instanceof PhpArray ? v.size : Array.isArray(v) ? v.length : 0));
  def('sizeof', (v: unknown) => (v instanceof PhpArray ? v.size : Array.isArray(v) ? v.length : 0));
  def('in_array', (needle: unknown, haystack: unknown, strict?: unknown) => {
    const values = arr(haystack).values();
    return values.some((v) => (truthy(strict) ? v === needle : looseEq(v, needle)));
  });
  def('array_key_exists', (key: unknown, v: unknown) => v instanceof PhpArray && v.has(key));
  def('array_keys', (v: unknown) => new PhpArray(arr(v).keys().map((k, i) => [i, k] as [number, unknown])));
  def('array_values', (v: unknown) => new PhpArray(arr(v).values().map((item, i) => [i, item] as [number, unknown])));
  def('array_merge', (...args: unknown[]) => {
    const out = new PhpArray();
    for (const arg of args) {
      for (const [k, v] of arr(arg)) {
        if (typeof k === 'number') out.push(v);
        else out.set(k, v);
      }
    }
    return out;
  });
  def('array_slice', (v: unknown, offset: unknown, length?: unknown, preserve?: unknown) => {
    const entries = arr(v).entries();
    const start = toInt(offset) < 0 ? entries.length + toInt(offset) : toInt(offset);
    const end = length === undefined ? undefined : toInt(length) < 0 ? entries.length + toInt(length) : start + toInt(length);
    const sliced = entries.slice(start, end);
    const out = new PhpArray();
    sliced.forEach(([k, val], i) => out.set(truthy(preserve) ? k : i, val));
    return out;
  });
  def('array_reverse', (v: unknown, preserve?: unknown) => {
    const entries = arr(v).entries().reverse();
    const out = new PhpArray();
    entries.forEach(([k, val], i) => out.set(truthy(preserve) ? k : i, val));
    return out;
  });
  def('array_unique', (v: unknown) => {
    const out = new PhpArray();
    for (const [k, val] of arr(v)) {
      if (!out.values().some((existing) => toStr(existing) === toStr(val))) out.set(k, val);
    }
    return out;
  });
  def('array_flip', (v: unknown) => {
    const out = new PhpArray();
    for (const [k, val] of arr(v)) out.set(val, k);
    return out;
  });
  def('array_sum', (v: unknown) => arr(v).values().reduce((sum: number, val) => sum + toNum(val), 0));
  def('array_combine', (keys: unknown, values: unknown) => {
    const out = new PhpArray();
    const ks = arr(keys).values();
    const vs = arr(values).values();
    ks.forEach((k, i) => out.set(k, vs[i]));
    return out;
  });
  def('array_fill', (start: unknown, count: unknown, value: unknown) => {
    const out = new PhpArray();
    for (let i = 0; i < toInt(count); i++) out.set(toInt(start) + i, value);
    return out;
  });
  def('array_pad', (v: unknown, size: unknown, value: unknown) => {
    const out = arr(v).clone();
    const target = toInt(size);
    while (out.size < Math.abs(target)) {
      if (target > 0) out.push(value);
      else {
        const entries = out.entries();
        const shifted = new PhpArray([[0, value]]);
        entries.forEach(([k, val], i) => shifted.set(i + 1, val));
        out.map.clear();
        for (const [k, val] of shifted) out.set(k, val);
      }
    }
    return out;
  });
  def('array_column', (v: unknown, column: unknown, indexKey?: unknown) => {
    const out = new PhpArray();
    for (const row of arr(v).values()) {
      const rowArr = arr(row);
      const value = rowArr.get(column) ?? (isPhpHost(row) ? row.phpGet(toStr(column)) : null);
      if (indexKey !== undefined) {
        const key = rowArr.get(indexKey) ?? (isPhpHost(row) ? row.phpGet(toStr(indexKey)) : null);
        out.set(key ?? out.size, value);
      } else out.push(value);
    }
    return out;
  });
  def('array_search', (needle: unknown, haystack: unknown, strict?: unknown) => {
    for (const [k, v] of arr(haystack)) {
      if (truthy(strict) ? v === needle : looseEq(v, needle)) return k;
    }
    return false;
  });
  def('array_map', async (callback: unknown, ...arrays: unknown[]) => {
    if (callback === null) {
      const out = new PhpArray();
      arrays.flatMap((a) => arr(a).values()).forEach((v, i) => out.set(i, v));
      return out;
    }
    const first = arr(arrays[0]);
    const out = new PhpArray();
    const invoke = runtime.callbackInvoker;
    if (!invoke) throw new PhpError('No callback invoker registered');
    let i = 0;
    for (const [k, v] of first) {
      const args = arrays.map((a) => arr(a).values()[i]);
      out.set(k, await invoke(callback, arrays.length > 1 ? args : [v, k]));
      i++;
    }
    return out;
  });
  def('array_filter', async (v: unknown, callback?: unknown) => {
    const out = new PhpArray();
    const invoke = runtime.callbackInvoker;
    for (const [k, val] of arr(v)) {
      const keep = callback === undefined ? truthy(val) : invoke ? truthy(await invoke(callback, [val])) : truthy(val);
      if (keep) out.set(k, val);
    }
    return out;
  });
  def('array_reduce', async (v: unknown, callback: unknown, initial?: unknown) => {
    const invoke = runtime.callbackInvoker;
    if (!invoke) throw new PhpError('No callback invoker registered');
    let carry: unknown = initial ?? null;
    for (const val of arr(v).values()) carry = await invoke(callback, [carry, val]);
    return carry;
  });
  def('usort', async (v: unknown, callback: unknown) => {
    const invoke = runtime.callbackInvoker;
    if (!invoke) throw new PhpError('No callback invoker registered');
    const target = arr(v);
    const entries = await sortEntries(target.entries(), async (a, b) => toInt(await invoke(callback, [a, b])));
    reorder(target, entries);
    return true;
  });
  def('uasort', async (v: unknown, callback: unknown) => {
    const invoke = runtime.callbackInvoker;
    if (!invoke) throw new PhpError('No callback invoker registered');
    const target = arr(v);
    const entries = await sortEntries(target.entries(), async (a, b) => toInt(await invoke(callback, [a, b])));
    reorder(target, entries);
    return true;
  });
  def('sort', (v: unknown) => {
    const target = arr(v);
    reorder(target, target.values().sort((a, b) => (toStr(a) < toStr(b) ? -1 : toStr(a) > toStr(b) ? 1 : 0)).map((val, i) => [i, val]));
    return true;
  });
  def('rsort', (v: unknown) => {
    const target = arr(v);
    reorder(target, target.values().sort((a, b) => (toStr(a) < toStr(b) ? 1 : toStr(a) > toStr(b) ? -1 : 0)).map((val, i) => [i, val]));
    return true;
  });
  def('ksort', (v: unknown) => {
    const target = arr(v);
    reorder(target, target.entries().sort((a, b) => (toStr(a[0]) < toStr(b[0]) ? -1 : 1)));
    return true;
  });
  def('range', (start: unknown, end: unknown, step?: unknown) => {
    const out = new PhpArray();
    const from = isNumericString(toStr(start)) ? toNum(start) : toStr(start).charCodeAt(0);
    const to = isNumericString(toStr(end)) ? toNum(end) : toStr(end).charCodeAt(0);
    const inc = step === undefined ? 1 : Math.abs(toNum(step));
    if (from <= to) for (let i = from; i <= to; i += inc) out.push(typeof start === 'number' || isNumericString(toStr(start)) ? i : String.fromCharCode(i));
    else for (let i = from; i >= to; i -= inc) out.push(typeof start === 'number' || isNumericString(toStr(start)) ? i : String.fromCharCode(i));
    return out;
  });
  def('array_shift', (v: unknown) => {
    const target = arr(v);
    const first = target.values()[0] ?? null;
    const entries = target.entries().slice(1).map(([, val], i) => [i, val] as [number, unknown]);
    reorder(target, entries);
    return first;
  });
  def('array_unshift', (v: unknown, ...items: unknown[]) => {
    const target = arr(v);
    const entries = [...items.map((val, i) => [i, val] as [number, unknown]), ...target.entries().map(([, val], i) => [items.length + i, val] as [number, unknown])];
    reorder(target, entries);
    return target.size;
  });
  def('array_pop', (v: unknown) => {
    const target = arr(v);
    const entries = target.entries();
    const last = entries.length > 0 ? entries[entries.length - 1] : null;
    if (last) target.delete(last[0]);
    return last ? last[1] : null;
  });
  def('array_push', (v: unknown, ...items: unknown[]) => {
    const target = arr(v);
    for (const item of items) target.push(item);
    return target.size;
  });

  // ------------------------------------------------------------------ regex
  def('preg_match', (pattern: unknown, subject: unknown) => (regExpFromPhp(toStr(pattern), '').test(toStr(subject)) ? 1 : 0));
  def('preg_match_all', (pattern: unknown, subject: unknown) => {
    const re = regExpFromPhp(toStr(pattern), 'g');
    return [...toStr(subject).matchAll(re)].length;
  });
  def('preg_replace', (pattern: unknown, replacement: unknown, subject: unknown, limit?: unknown) => {
    const apply = (s: string) => {
      const patterns = pattern instanceof PhpArray ? pattern.values() : [pattern];
      const replacements = replacement instanceof PhpArray ? replacement.values() : [replacement];
      let out = s;
      patterns.forEach((p, i) => {
        out = out.replace(regExpFromPhp(toStr(p), 'g'), toStr(replacements[i] ?? replacements[0] ?? ''));
      });
      return out;
    };
    if (subject instanceof PhpArray) {
      const out = new PhpArray();
      for (const [k, v] of subject) out.set(k, apply(toStr(v)));
      return out;
    }
    return apply(toStr(subject));
  });
  def('preg_replace_callback', async (pattern: unknown, callback: unknown, subject: unknown) => {
    const invoke = runtime.callbackInvoker;
    if (!invoke) throw new PhpError('No callback invoker registered');
    const re = regExpFromPhp(toStr(pattern), 'g');
    const input = toStr(subject);
    let out = '';
    let last = 0;
    for (const match of input.matchAll(re)) {
      out += input.slice(last, match.index);
      const groups = new PhpArray(match.map((v, i) => [i, v ?? null] as [number, unknown]));
      out += toStr(await invoke(callback, [groups]));
      last = (match.index ?? 0) + match[0].length;
    }
    return out + input.slice(last);
  });
  def('preg_split', (pattern: unknown, subject: unknown) => new PhpArray(toStr(subject).split(regExpFromPhp(toStr(pattern), 'g')).map((v, i) => [i, v] as [number, string])));
  def('preg_quote', (s: unknown) => toStr(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  // ------------------------------------------------------------------- types
  const is = (type: string) => (v: unknown) => {
    switch (type) {
      case 'array':
        return v instanceof PhpArray;
      case 'string':
        return typeof v === 'string';
      case 'int':
      case 'integer':
        return typeof v === 'number' && Number.isInteger(v);
      case 'float':
      case 'double':
        return typeof v === 'number' && !Number.isInteger(v);
      case 'numeric':
        return typeof v === 'number' || (typeof v === 'string' && isNumericString(v));
      case 'null':
        return v === null || v === undefined;
      case 'bool':
      case 'boolean':
        return typeof v === 'boolean';
      case 'object':
        return !!v && typeof v === 'object';
      case 'callable':
        return typeof v === 'function' || (typeof v === 'string' && runtime.getFunction(v) !== undefined) || (v && typeof v === 'object' && (v as { kind?: string }).kind === 'user');
      case 'scalar':
        return ['string', 'number', 'boolean'].includes(typeof v);
      default:
        return false;
    }
  };
  for (const t of ['array', 'string', 'int', 'integer', 'float', 'double', 'numeric', 'null', 'bool', 'boolean', 'object', 'callable', 'scalar']) {
    def(`is_${t}`, is(t));
  }
  def('intval', (v: unknown, base?: unknown) => (base !== undefined ? parseInt(toStr(v), toInt(base)) : toInt(v)));
  def('floatval', (v: unknown) => toNum(v));
  def('doubleval', (v: unknown) => toNum(v));
  def('strval', (v: unknown) => toStr(v));
  def('boolval', (v: unknown) => truthy(v));
  def('settype', () => true);
  def('gettype', (v: unknown) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'double';
    if (typeof v === 'string') return 'string';
    if (v instanceof PhpArray) return 'array';
    return 'object';
  });

  // ------------------------------------------------------------------- json
  def('json_encode', (v: unknown, flags?: unknown) => {
    const f = flags === undefined ? 0 : toInt(flags);
    const value = toJs(v);
    if (f & 128) return JSON.stringify(value, null, 4);
    let out = JSON.stringify(value);
    if (!(f & 256)) out = out.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (!(f & 64)) out = out.replace(/\//g, '\\/');
    return out;
  });
  def('json_decode', (s: unknown, assoc?: unknown) => {
    try {
      const parsed = JSON.parse(toStr(s));
      return truthy(assoc) ? fromJs(parsed) : parsed;
    } catch {
      return null;
    }
  });
  def('json_last_error', () => 0);
  def('json_last_error_msg', () => 'No error');

  // ------------------------------------------------------------------- math
  def('abs', (v: unknown) => Math.abs(toNum(v)));
  def('ceil', (v: unknown) => Math.ceil(toNum(v)));
  def('floor', (v: unknown) => Math.floor(toNum(v)));
  def('round', (v: unknown, precision?: unknown) => {
    const p = precision === undefined ? 0 : toInt(precision);
    const f = Math.pow(10, p);
    return Math.round(toNum(v) * f) / f;
  });
  def('max', (...args: unknown[]) => {
    const values = args.length === 1 ? arr(args[0]).values() : args;
    let best: unknown = values[0] ?? null;
    for (const value of values) if (toNum(value) > toNum(best)) best = value;
    return best;
  });
  def('min', (...args: unknown[]) => {
    const values = args.length === 1 ? arr(args[0]).values() : args;
    let best: unknown = values[0] ?? null;
    for (const value of values) if (toNum(value) < toNum(best)) best = value;
    return best;
  });
  def('pow', (a: unknown, b: unknown) => Math.pow(toNum(a), toNum(b)));
  def('sqrt', (v: unknown) => Math.sqrt(toNum(v)));
  def('rand', (min?: unknown, max?: unknown) => randInt(min, max));
  def('mt_rand', (min?: unknown, max?: unknown) => randInt(min, max));
  def('random_int', (min?: unknown, max?: unknown) => randInt(min, max));

  // ------------------------------------------------------------------- date
  def('time', () => Math.trunc(Date.now() / 1000));
  def('date', (format: unknown, ts?: unknown) => dateFormat(ts === undefined ? Math.trunc(Date.now() / 1000) : toInt(ts), toStr(format), offset()));
  def('gmdate', (format: unknown, ts?: unknown) => dateFormat(ts === undefined ? Math.trunc(Date.now() / 1000) : toInt(ts), toStr(format), 0));
  def('mktime', (hour?: unknown, minute?: unknown, second?: unknown, month?: unknown, day?: unknown, year?: unknown) => {
    const now = new Date();
    const ts = Date.UTC(
      year === undefined ? now.getUTCFullYear() : toInt(year),
      month === undefined ? now.getUTCMonth() : toInt(month) - 1,
      day === undefined ? now.getUTCDate() : toInt(day),
      hour === undefined ? 0 : toInt(hour),
      minute === undefined ? 0 : toInt(minute),
      second === undefined ? 0 : toInt(second)
    );
    return Math.trunc(ts / 1000) - offset();
  });
  def('strtotime', (text: unknown) => {
    const parsed = Date.parse(toStr(text));
    return Number.isNaN(parsed) ? false : Math.trunc(parsed / 1000) - offset();
  });
  def('checkdate', (month: unknown, day: unknown, year: unknown) => {
    const m = toInt(month);
    const d = toInt(day);
    const y = toInt(year);
    return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  });
  def('date_default_timezone_set', () => true);

  // -------------------------------------------------------------- url / misc
  def('parse_url', (url: unknown, component?: unknown) => {
    const u = toStr(url);
    if (component !== undefined) {
      const key = [null, 'scheme', 'host', 'port', 'user', 'pass', 'path', 'query', 'fragment'][toInt(component)];
      try {
        const parsed = new URL(u, 'http://localhost');
        return key ? (parsed as unknown as Record<string, unknown>)[key] ?? null : null;
      } catch {
        return null;
      }
    }
    try {
      const parsed = new URL(u);
      const out = new PhpArray();
      out.set('scheme', parsed.protocol.replace(':', ''));
      out.set('host', parsed.hostname);
      if (parsed.port) out.set('port', toInt(parsed.port));
      out.set('path', parsed.pathname);
      if (parsed.search) out.set('query', parsed.search.slice(1));
      if (parsed.hash) out.set('fragment', parsed.hash.slice(1));
      return out;
    } catch {
      return false;
    }
  });
  def('parse_str', (s: unknown) => {
    const out = new PhpArray();
    for (const [k, v] of new URLSearchParams(toStr(s))) out.set(k, v);
    return out;
  });
  def('http_build_query', (v: unknown) => {
    const params = new URLSearchParams();
    for (const [k, val] of arr(v)) params.append(toStr(k), toStr(val));
    return params.toString();
  });

  // --------------------------------------------------------------- language
  def('defined', (name: unknown) => runtime.constants.has(toStr(name)) || ['PHP_EOL', 'PHP_INT_MAX', 'PHP_INT_MIN', 'M_PI'].includes(toStr(name)));
  def('define', (name: unknown, value: unknown, _caseInsensitive?: unknown) => {
    runtime.constants.set(toStr(name), value);
    return true;
  });
  def('constant', (name: unknown) => {
    const key = toStr(name);
    if (runtime.constants.has(key)) return runtime.constants.get(key);
    if (key === 'PHP_EOL') return '\n';
    throw new PhpError(`Undefined constant "${key}"`);
  });
  def('function_exists', (name: unknown) => runtime.getFunction(toStr(name)) !== undefined);
  def('class_exists', (name: unknown) => runtime.getClass(toStr(name)) !== undefined);
  def('interface_exists', (name: unknown) => runtime.getClass(toStr(name))?.kind === 'user');
  def('method_exists', (target: unknown, name: unknown) => {
    if (target instanceof PhpObject) return !!runtime.findMethod(target.cls, toStr(name));
    return typeof (target as Record<string, unknown>)?.[toStr(name)] === 'function';
  });
  def('property_exists', (target: unknown, name: unknown) => {
    if (target instanceof PhpObject) return target.props.has(toStr(name)) || !!runtime.findProperty(target.cls, toStr(name));
    return !!target && toStr(name) in (target as object);
  });
  def('call_user_func', async (fn: unknown, ...args: unknown[]) => {
    const invoke = runtime.callbackInvoker;
    if (!invoke) throw new PhpError('No callback invoker registered');
    return invoke(fn, args);
  });
  def('call_user_func_array', async (fn: unknown, args: unknown) => {
    const invoke = runtime.callbackInvoker;
    if (!invoke) throw new PhpError('No callback invoker registered');
    return invoke(fn, arr(args).values());
  });
  def('func_get_args', () => new PhpArray());
  def('error_reporting', () => 0);
  def('ini_set', () => false);
  def('ini_get', () => '');
  def('set_time_limit', () => true);
  def('ignore_user_abort', () => 0);
  def('trigger_error', () => true);
  def('header', () => undefined);
  def('setcookie', () => true);
  def('setrawcookie', () => true);
  def('headers_sent', () => false);
  def('flush', () => undefined);
  def('ob_start', () => true);
  def('ob_get_clean', () => '');
  def('ob_end_clean', () => true);
  def('mb_internal_encoding', () => true);
  def('mb_convert_encoding', (s: unknown) => toStr(s));
  def('iconv', (_from: unknown, _to: unknown, s: unknown) => toStr(s));
  def('var_dump', (...args: unknown[]) => {
    runtime.globals.set('__dump__', args.map((v) => dump(v)).join('\n'));
    return undefined;
  });
  def('print_r', (v: unknown, ret?: unknown) => (truthy(ret) ? dump(v) : dump(v)));
  def('serialize', (v: unknown) => {
    try {
      return encodePhpSerialized(v);
    } catch {
      return false;
    }
  });
  def('unserialize', (s: unknown) => {
    const source = toStr(s);
    try {
      return fromJs(parsePhpSerialized(source));
    } catch {
      try {
        return fromJs(JSON.parse(source));
      } catch {
        return false;
      }
    }
  });
  def('array_is_list', (v: unknown) => v instanceof PhpArray && v.keys().every((k, i) => typeof k === 'number' && k === i));
}

const BUILTIN_NAMES = new Set<string>();

function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64Decode(s: string): string {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function trimWith(value: unknown, chars: unknown, left: boolean, right: boolean): string {
  let s = toStr(value);
  const charsStr = chars === undefined ? ' \t\n\r\0\x0B' : toStr(chars);
  const escaped = charsStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (left) s = s.replace(new RegExp(`^[${escaped}]+`), '');
  if (right) s = s.replace(new RegExp(`[${escaped}]+$`), '');
  return s;
}

function substr(s: string, start: number, length?: number): string {
  const chars = [...s];
  let from = start < 0 ? chars.length + start : start;
  if (from < 0) from = 0;
  if (length === undefined) return chars.slice(from).join('');
  const to = length < 0 ? chars.length + length : from + length;
  return chars.slice(from, to).join('');
}

function randInt(min?: unknown, max?: unknown): number {
  const lo = min === undefined ? 0 : toInt(min);
  const hi = max === undefined ? (min === undefined ? 2147483647 : lo) : toInt(max);
  const range = hi - lo + 1;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return lo + (bytes[0] % range);
}

async function hashHex(algo: string, data: string): Promise<string> {
  const name = algo === 'SHA1' ? 'SHA-1' : algo === 'SHA256' ? 'SHA-256' : algo;
  const digest = await crypto.subtle.digest(name, new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function crc32(str: string): number {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  const bytes = new TextEncoder().encode(str);
  let crc = 0xffffffff;
  for (const b of bytes) crc = (table[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function reorder(target: PhpArray, entries: Array<[string | number, unknown]>): void {
  target.map.clear();
  for (const [k, v] of entries) target.map.set(normalizeKey(k), v);
}

async function sortEntries(
  entries: Array<[string | number, unknown]>,
  compare: (a: unknown, b: unknown) => Promise<number>
): Promise<Array<[string | number, unknown]>> {
  const out = [...entries];
  // insertion sort keeps the comparator async-capable and stable
  for (let i = 1; i < out.length; i++) {
    const current = out[i];
    let j = i - 1;
    while (j >= 0 && (await compare(out[j][1], current[1])) > 0) {
      out[j + 1] = out[j];
      j--;
    }
    out[j + 1] = current;
  }
  return out;
}

function dump(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'bool(true)' : 'bool(false)';
  if (typeof v === 'number') return `${Number.isInteger(v) ? 'int' : 'float'}(${v})`;
  if (typeof v === 'string') return `string(${[...v].length}) "${v}"`;
  if (v instanceof PhpArray) return `array(${v.size}) {${v.entries().map(([k, val]) => ` [${k}]=> ${dump(val)}`).join('')}}`;
  return 'object';
}
