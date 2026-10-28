import { PhpArray } from './values';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_ITEMS = 10_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Reads PHP serialized scalar/array values without instantiating objects or references. */
export function parsePhpSerialized(input: string): unknown {
  const bytes = encoder.encode(input);
  if (bytes.length > MAX_BYTES) throw new Error('Serialized value exceeds limit');
  let position = 0;
  let items = 0;

  const expect = (code: number) => {
    if (bytes[position++] !== code) throw new Error('Invalid PHP serialized value');
  };
  const token = (delimiter: number): string => {
    const start = position;
    while (position < bytes.length && bytes[position] !== delimiter) position++;
    if (position >= bytes.length) throw new Error('Truncated PHP serialized value');
    const value = decoder.decode(bytes.subarray(start, position));
    position++;
    return value;
  };
  const boundedInteger = (value: string, max: number): number => {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error('Invalid serialized length');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > max) throw new Error('Serialized length exceeds limit');
    return number;
  };
  const read = (depth: number): unknown => {
    if (++items > MAX_ITEMS || depth > MAX_DEPTH || position >= bytes.length) throw new Error('Serialized value exceeds limit');
    const type = String.fromCharCode(bytes[position++]);
    if (type === 'N') {
      expect(59);
      return null;
    }
    expect(58);
    if (type === 'b') {
      const value = token(59);
      if (value !== '0' && value !== '1') throw new Error('Invalid serialized boolean');
      return value === '1';
    }
    if (type === 'i') {
      const value = token(59);
      if (!/^-?(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid serialized integer');
      return Number(value);
    }
    if (type === 'd') {
      const value = Number(token(59));
      if (!Number.isFinite(value)) throw new Error('Invalid serialized float');
      return value;
    }
    if (type === 's') {
      const length = boundedInteger(token(58), MAX_BYTES);
      expect(34);
      if (position + length > bytes.length) throw new Error('Truncated serialized string');
      const value = decoder.decode(bytes.subarray(position, position + length));
      position += length;
      expect(34);
      expect(59);
      return value;
    }
    if (type === 'a') {
      const count = boundedInteger(token(58), MAX_ITEMS);
      expect(123);
      const entries: Array<[string | number, unknown]> = [];
      const keys = new Set<string>();
      for (let index = 0; index < count; index++) {
        const key = read(depth + 1);
        if (typeof key !== 'string' && !(typeof key === 'number' && Number.isSafeInteger(key))) {
          throw new Error('Invalid serialized array key');
        }
        const normalized = String(key);
        if (FORBIDDEN_KEYS.has(normalized) || keys.has(normalized)) throw new Error('Invalid serialized array key');
        keys.add(normalized);
        entries.push([key, read(depth + 1)]);
      }
      expect(125);
      if (entries.every(([key], index) => typeof key === 'number' && key === index)) {
        return entries.map(([, value]) => value);
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, value] of entries) result[String(key)] = value;
      return result;
    }
    throw new Error('Unsupported PHP serialized type');
  };

  const value = read(0);
  if (position !== bytes.length) throw new Error('Trailing PHP serialized data');
  return value;
}

/** Writes the scalar/array subset of PHP's serialize() without object execution. */
export function encodePhpSerialized(input: unknown): string {
  const parts: string[] = [];
  let size = 0;
  let items = 0;
  const append = (part: string) => {
    size += encoder.encode(part).byteLength;
    if (size > MAX_BYTES) throw new Error('Serialized value exceeds limit');
    parts.push(part);
  };
  const write = (value: unknown, depth: number): void => {
    if (++items > MAX_ITEMS || depth > MAX_DEPTH) throw new Error('Serialized value exceeds limit');
    if (value === null || value === undefined) return append('N;');
    if (typeof value === 'boolean') return append(`b:${value ? '1' : '0'};`);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Unsupported serialized number');
      return append(`${Number.isSafeInteger(value) ? 'i' : 'd'}:${value};`);
    }
    if (typeof value === 'string') return append(`s:${encoder.encode(value).length}:"${value}";`);
    let entries: Array<[string | number, unknown]>;
    if (value instanceof PhpArray) entries = [...value] as Array<[string | number, unknown]>;
    else if (Array.isArray(value)) entries = value.map((item, index) => [index, item]);
    else if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      entries = Object.entries(value as Record<string, unknown>);
    } else throw new Error('Unsupported serialized value');
    if (entries.length > MAX_ITEMS) throw new Error('Serialized array exceeds limit');
    append(`a:${entries.length}:{`);
    for (const [key, item] of entries) {
      if (typeof key !== 'string' && !(typeof key === 'number' && Number.isSafeInteger(key))) throw new Error('Invalid serialized key');
      if (FORBIDDEN_KEYS.has(String(key))) throw new Error('Invalid serialized key');
      write(key, depth + 1);
      write(item, depth + 1);
    }
    append('}');
  };
  write(input, 0);
  return parts.join('');
}
