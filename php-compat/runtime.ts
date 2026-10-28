import type { AstNode } from './parse';

export type PhpValue = unknown;

export interface ParamDef {
  name: string;
  defaultValue?: AstNode;
  variadic?: boolean;
}

export interface UserFunction {
  kind: 'user';
  name: string;
  params: ParamDef[];
  body: AstNode;
  /** Closure `use (...)` variable names captured by value. */
  uses?: string[];
  /** Captured values for closures. */
  captured?: Map<string, PhpValue>;
  isStatic?: boolean;
  file?: string;
}

export interface HostFunction {
  kind: 'host';
  name: string;
  fn: (...args: any[]) => unknown;
}

export type Callable = UserFunction | HostFunction;

export interface MethodDef {
  name: string;
  params: ParamDef[];
  body: AstNode;
  isStatic: boolean;
  visibility: string;
}

export interface PropertyDef {
  name: string;
  isStatic: boolean;
  defaultNode?: AstNode;
  defaultValue?: PhpValue;
  visibility: string;
}

export interface UserClass {
  kind: 'user';
  name: string;
  parent?: string;
  implements: string[];
  traits: string[];
  methods: Map<string, MethodDef>;
  props: Map<string, PropertyDef>;
  constants: Map<string, unknown>;
  staticProps: Map<string, PhpValue>;
  isAbstract: boolean;
  isInterface: boolean;
  isTrait: boolean;
  file?: string;
  namespace?: string;
  imports?: Map<string, string>;
}

export interface HostClass {
  kind: 'host';
  name: string;
  parent?: string;
  construct?: (args: PhpValue[]) => unknown;
  statics?: Record<string, (...args: any[]) => unknown>;
  staticProps?: Record<string, PhpValue>;
  constants?: Record<string, PhpValue>;
  /** Methods installed on every instance (used by the Exception shim). */
  methods?: Record<string, (...args: any[]) => unknown>;
}

export type ClassDef = UserClass | HostClass;

/** Interpreted class instance. */
export class PhpObject {
  constructor(
    public readonly cls: UserClass,
    public readonly props: Map<string, PhpValue> = new Map()
  ) {}
}

export function isPhpObject(v: unknown): v is PhpObject {
  return v instanceof PhpObject;
}

export class Scope {
  vars = new Map<string, PhpValue>();
  /** Names bound to the interpreter's global scope via `global $x`. */
  readonly globals = new Set<string>();

  constructor(
    public parent: Scope | null = null,
    public self: PhpValue = null
  ) {}

  get(name: string): PhpValue {
    if (this.globals.has(name)) return this.root().vars.get(name);
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    return undefined;
  }

  /** Assignment always writes into the current scope (PHP semantics). */
  set(name: string, value: PhpValue): void {
    if (this.globals.has(name)) {
      this.root().vars.set(name, value);
      return;
    }
    this.vars.set(name, value);
  }

  has(name: string): boolean {
    if (this.vars.has(name)) return true;
    return this.parent ? this.parent.has(name) : false;
  }

  root(): Scope {
    let s: Scope = this;
    while (s.parent) s = s.parent;
    return s;
  }
}

export interface RuntimeHostOptions {
  /** Resolve and read an included PHP file. */
  readFile?: (path: string, from: string) => Promise<{ code: string; path: string } | null>;
  /** Timezone offset in seconds, used by date(). */
  timezoneOffset?: number;
  /** Output sink used by builtins such as `_e()` / `printf()`. */
  echo?: (v: PhpValue) => void;
  /** Optional per-runtime instruction budget for bounded plugin execution. */
  maxOperations?: number;
}

export class Runtime {
  readonly classes = new Map<string, ClassDef>();
  readonly functions = new Map<string, Callable>();
  readonly constants = new Map<string, PhpValue>();
  readonly globals = new Map<string, PhpValue>();
  readonly includedFiles = new Set<string>();
  readonly host: RuntimeHostOptions;
  private operations = 0;

  tick(): void {
    if (this.host.maxOperations !== undefined && ++this.operations > this.host.maxOperations) {
      throw new Error('PHP operation limit exceeded');
    }
  }

  /** Set by the interpreter so builtins can invoke PHP callables. */
  callbackInvoker?: (fn: unknown, args: unknown[]) => Promise<unknown>;

  constructor(host: RuntimeHostOptions = {}) {
    this.host = host;
  }

  defineConstant(name: string, value: PhpValue): void {
    this.constants.set(name, value);
  }

  addFunction(name: string, fn: (...args: any[]) => unknown): void {
    this.functions.set(name.toLowerCase(), { kind: 'host', name, fn });
  }

  addClass(def: ClassDef): void {
    this.classes.set(def.name.replace(/^\\/, '').toLowerCase(), def);
  }

  getClass(name: string): ClassDef | undefined {
    return this.classes.get(name.replace(/^\\/, '').toLowerCase());
  }

  getFunction(name: string): Callable | undefined {
    return this.functions.get(name.replace(/^\\/, '').toLowerCase());
  }

  /** Walk the parent chain of a user class. */
  classChain(name: string): UserClass[] {
    const chain: UserClass[] = [];
    let current = this.getClass(name);
    const seen = new Set<string>();
    while (current && current.kind === 'user' && !seen.has(current.name)) {
      seen.add(current.name);
      chain.push(current);
      if (!current.parent) break;
      const next = this.getClass(current.parent);
      current = next;
    }
    return chain;
  }

  findMethod(cls: UserClass, method: string): MethodDef | undefined {
    const key = method.toLowerCase();
    for (const c of this.classChain(cls.name)) {
      const found = c.methods.get(key);
      if (found) return found;
    }
    return undefined;
  }

  findProperty(cls: UserClass, prop: string): PropertyDef | undefined {
    for (const c of this.classChain(cls.name)) {
      const found = c.props.get(prop);
      if (found) return found;
    }
    return undefined;
  }

  findConstant(cls: UserClass, name: string): PhpValue | undefined {
    for (const c of this.classChain(cls.name)) {
      const upper = name.toUpperCase();
      for (const [k, v] of c.constants) {
        if (k.toUpperCase() === upper) return v;
      }
    }
    return undefined;
  }
}
