/**
 * Bridge between interpreted PHP and TypeScript host objects (widgets, forms,
 * DB handles). Property access and method calls are separate code paths in PHP,
 * which lets a host object expose `->title` and `->title()` with different
 * behaviour, exactly like Typecho's `__get` / `__call` pair.
 */

export const PHP_HOST = Symbol.for('typecho.phpHost');

export interface PhpHost {
  readonly [PHP_HOST]: true;
  phpGet(name: string): unknown;
  phpCall(name: string, args: unknown[]): unknown;
  phpSet?(name: string, value: unknown): void;
  phpIsset?(name: string): boolean;
  phpToString?(): string;
}

export function isPhpHost(v: unknown): v is PhpHost {
  return !!v && typeof v === 'object' && (v as PhpHost)[PHP_HOST] === true;
}

export interface HostSpec {
  /** Plain readable properties. */
  props?: Record<string, unknown>;
  /** `->name()` methods. */
  methods?: Record<string, (...args: any[]) => unknown>;
  /** Called for unknown properties (Typecho `__get`). */
  get?: (name: string) => unknown;
  /** Called for unknown methods (Typecho `__call`). */
  call?: (name: string, args: unknown[]) => unknown;
  set?: (name: string, value: unknown) => void;
  isset?: (name: string) => boolean;
  toString?: () => string;
}

/** Build a PhpHost from a plain spec. Methods are bound lazily. */
export function makeHost(spec: HostSpec): PhpHost {
  const props = spec.props ?? {};
  const methods = spec.methods ?? {};
  return {
    [PHP_HOST]: true,
    phpGet(name: string) {
      if (name in props) return props[name];
      if (spec.get) return spec.get(name);
      return undefined;
    },
    phpCall(name: string, args: unknown[]) {
      const fn = methods[name];
      if (fn) return fn(...args);
      if (spec.call) return spec.call(name, args);
      throw new Error(`Call to undefined method ${name}()`);
    },
    phpSet(name: string, value: unknown) {
      props[name] = value;
      spec.set?.(name, value);
    },
    phpIsset(name: string) {
      if (props[name] !== undefined) return true;
      return spec.isset ? spec.isset(name) : false;
    },
    phpToString() {
      return spec.toString ? spec.toString() : '[object Object]';
    },
  };
}
