/**
 * PHP value model for the subset interpreter.
 *
 * PHP arrays keep insertion order and distinguish int/string keys, so a plain
 * JS object is not enough. `PhpArray` wraps a Map with PHP key normalisation.
 */

export class PhpArray {
  readonly map = new Map<string | number, unknown>();

  constructor(items?: Iterable<[unknown, unknown]>) {
    if (items) {
      for (const [k, v] of items) this.set(k, v);
    }
  }

  static fromObject(obj: Record<string, unknown>): PhpArray {
    return new PhpArray(Object.entries(obj));
  }

  set(key: unknown, value: unknown): this {
    this.map.set(normalizeKey(key), value);
    return this;
  }

  get(key: unknown): unknown {
    return this.map.get(normalizeKey(key));
  }

  has(key: unknown): boolean {
    return this.map.has(normalizeKey(key));
  }

  delete(key: unknown): boolean {
    return this.map.delete(normalizeKey(key));
  }

  push(value: unknown): this {
    this.map.set(this.nextIndex(), value);
    return this;
  }

  nextIndex(): number {
    let max = -1;
    for (const k of this.map.keys()) {
      if (typeof k === 'number' && k > max) max = k;
    }
    return max + 1;
  }

  get size(): number {
    return this.map.size;
  }

  keys(): Array<string | number> {
    return [...this.map.keys()];
  }

  values(): unknown[] {
    return [...this.map.values()];
  }

  entries(): Array<[string | number, unknown]> {
    return [...this.map.entries()];
  }

  clone(): PhpArray {
    return new PhpArray(this.map.entries());
  }

  toObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.map) out[String(k)] = v;
    return out;
  }

  [Symbol.iterator](): Iterator<[string | number, unknown]> {
    return this.map.entries();
  }
}

/** PHP array key coercion: numeric strings become ints, bools/floats get cast. */
export function normalizeKey(key: unknown): string | number {
  if (typeof key === 'number') return Math.trunc(key);
  if (typeof key === 'boolean') return key ? 1 : 0;
  if (key === null) return '';
  if (typeof key === 'string') {
    if (/^-?(0|[1-9]\d*)$/.test(key)) {
      const n = Number(key);
      if (Number.isSafeInteger(n)) return n;
    }
    return key;
  }
  if (key instanceof PhpArray) throw new Error('Illegal offset type');
  if (typeof key === 'object') throw new Error('Illegal offset type');
  return String(key);
}

export function isPhpArray(v: unknown): v is PhpArray {
  return v instanceof PhpArray;
}

export function toPhpArray(v: unknown): PhpArray {
  if (v instanceof PhpArray) return v;
  if (Array.isArray(v)) return new PhpArray(v.map((item, i) => [i, item] as [number, unknown]));
  if (v && typeof v === 'object') return PhpArray.fromObject(v as Record<string, unknown>);
  return new PhpArray();
}

/** PHP string cast. */
export function toStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? '1' : '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return v > 0 ? 'INF' : v < 0 ? '-INF' : 'NAN';
    return formatNumber(v);
  }
  if (v instanceof PhpArray) return 'Array';
  const host = v as { phpToString?: () => string };
  if (typeof host?.phpToString === 'function') return host.phpToString();
  if (typeof (v as { toString?: () => string }).toString === 'function') {
    const s = (v as { toString: () => string }).toString();
    if (s !== '[object Object]') return s;
  }
  return 'Object';
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = String(n);
  if (s.includes('e') || s.includes('E')) return s;
  return s.replace(/\.?0+$/, '') || '0';
}

/** PHP boolean cast. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '' && v !== '0';
  if (v instanceof PhpArray) return v.size > 0;
  return true;
}

export function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') {
    const m = v.trim().match(/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/);
    return m ? Number(m[0]) : 0;
  }
  if (v instanceof PhpArray) return v.size > 0 ? 1 : 0;
  return 1;
}

export function toInt(v: unknown): number {
  return Math.trunc(toNum(v));
}

/** PHP loose comparison (subset that covers template/plugin idioms). */
export function looseEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined || b === false || b === 0 || b === '' || (b instanceof PhpArray && b.size === 0);
  if (b === null || b === undefined) return looseEq(b, a);
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return true;
    if (isNumericString(a) && isNumericString(b)) return Number(a) === Number(b);
    return false;
  }
  if (typeof a === 'string' && typeof b === 'number') return isNumericString(a) && Number(a) === b;
  if (typeof a === 'number' && typeof b === 'string') return looseEq(b, a);
  if (a instanceof PhpArray && b instanceof PhpArray) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !looseEq(v, b.get(k))) return false;
    }
    return true;
  }
  return a === b;
}

export function isNumericString(v: string): boolean {
  return v.trim() !== '' && !Number.isNaN(Number(v));
}

export function strictEq(a: unknown, b: unknown): boolean {
  if (a instanceof PhpArray || b instanceof PhpArray) {
    if (!(a instanceof PhpArray) || !(b instanceof PhpArray)) return false;
    if (a.size !== b.size) return false;
    const ae = a.entries();
    const be = b.entries();
    for (let i = 0; i < ae.length; i++) {
      if (ae[i][0] !== be[i][0] || !strictEq(ae[i][1], be[i][1])) return false;
    }
    return true;
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return a === b;
}

/** PHP `<=>` operator. */
export function spaceship(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof PhpArray && b instanceof PhpArray) return a.size - b.size;
  const as = toStr(a);
  const bs = toStr(b);
  if (isNumericString(as) && isNumericString(bs)) {
    const an = Number(as);
    const bn = Number(bs);
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  return as < bs ? -1 : as > bs ? 1 : 0;
}

export function phpType(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'double';
  if (typeof v === 'string') return 'string';
  if (v instanceof PhpArray) return 'array';
  return 'object';
}

/** Deep clone with PHP copy-on-write semantics for arrays/objects. */
export function phpClone(v: unknown): unknown {
  if (v instanceof PhpArray) {
    const copy = new PhpArray();
    for (const [k, item] of v) copy.set(k, phpClone(item));
    return copy;
  }
  return v;
}
