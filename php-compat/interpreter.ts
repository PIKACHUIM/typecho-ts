import { parsePhp, type AstNode } from './parse';
import {
  PhpError,
  PhpBreakSignal,
  PhpContinueSignal,
  PhpReturnSignal,
  PhpThrown,
  TerminateSignal,
  UnsupportedSyntax,
} from './errors';
import { isPhpHost } from './host';
import {
  PhpArray,
  looseEq,
  normalizeKey,
  phpClone,
  spaceship,
  strictEq,
  toInt,
  toNum,
  toStr,
  truthy,
} from './values';
import {
  PhpObject,
  Runtime,
  Scope,
  isPhpObject,
  type Callable,
  type HostClass,
  type MethodDef,
  type ParamDef,
  type PhpValue,
  type UserClass,
  type UserFunction,
} from './runtime';

export interface ExecContext {
  out: string[];
  echo: (v: PhpValue) => void;
  runtime: Runtime;
  file: string;
  /** Value bound to  inside templates. */
  self?: PhpValue;
}

const MAX_DEPTH = 256;

export class Interpreter {
  private ns = '';
  private uses = new Map<string, string>();
  private depth = 0;
  private currentClass: string | null = null;

  constructor(
    readonly runtime: Runtime,
    readonly ctx: ExecContext
  ) {
    runtime.callbackInvoker = (fn, args) => this.invoke(fn as Callable, args, new Scope());
    runtime.host.echo = ctx.echo;
  }

  async run(code: string, filename: string): Promise<PhpValue> {
    const ast = parsePhp(code, filename);
    return this.runAst(ast, filename);
  }

  async runAst(ast: AstNode, filename: string, self: PhpValue = this.ctx.self ?? null): Promise<PhpValue> {
    this.ns = '';
    this.uses = new Map();
    this.ctx.file = filename;
    try {
      return await this.execChildren(ast.children ?? [], new Scope(null, self));
    } catch (e) {
      if (e instanceof PhpReturnSignal) return e.value;
      throw e;
    }
  }

  // ---------------------------------------------------------------- statements

  private async execChildren(children: AstNode[], scope: Scope): Promise<PhpValue> {
    this.hoist(children);
    let last: PhpValue = null;
    for (const child of children) last = await this.execStatement(child, scope);
    return last;
  }

  /** PHP hoists top-level function/class declarations before execution. */
  private hoist(children: AstNode[]): void {
    for (const node of children) {
      if (node.kind === 'function' && node.name?.name) {
        this.defineUserFunction(node);
      } else if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
        this.defineClass(node);
      } else if (node.kind === 'namespace' && node.children) {
        const previous = this.ns;
        this.ns = node.name ?? '';
        this.hoist(node.children);
        this.ns = previous;
      }
    }
  }

  private async execStatement(node: AstNode, scope: Scope): Promise<PhpValue> {
    this.runtime.tick();
    switch (node.kind) {
      case 'expressionstatement':
        return this.evalExpr(node.expression, scope);
      case 'echo': {
        for (const expr of node.expressions ?? []) {
          this.ctx.echo(await this.evalExpr(expr, scope));
        }
        return null;
      }
      case 'inline':
        this.ctx.echo(node.value ?? node.raw ?? '');
        return null;
      case 'block':
        return this.execChildren(node.children ?? [], scope);
      case 'if':
        return this.execIf(node, scope);
      case 'while':
        return this.execWhile(node, scope);
      case 'do':
        return this.execDo(node, scope);
      case 'for':
        return this.execFor(node, scope);
      case 'foreach':
        return this.execForeach(node, scope);
      case 'switch':
        return this.execSwitch(node, scope);
      case 'break':
        throw new PhpBreakSignal(node.level ?? 1);
      case 'continue':
        throw new PhpContinueSignal(node.level ?? 1);
      case 'return':
        throw new PhpReturnSignal(node.expr ? await this.evalExpr(node.expr, scope) : null);
      case 'function':
        this.defineUserFunction(node);
        return null;
      case 'class':
      case 'interface':
      case 'trait':
        this.defineClass(node);
        return null;
      case 'namespace': {
        const previousNs = this.ns;
        const previousUses = this.uses;
        this.ns = node.name ?? '';
        this.uses = new Map(previousUses);
        try {
          return await this.execChildren(node.children ?? [], scope);
        } finally {
          this.ns = previousNs;
          this.uses = previousUses;
        }
      }
      case 'usegroup':
      case 'useitem':
        this.registerUse(node);
        return null;
      case 'constantstatement':
        for (const constant of node.constants ?? []) {
          this.runtime.defineConstant(constant.name, await this.evalExpr(constant.value, scope));
        }
        return null;
      case 'global':
        for (const item of node.items ?? []) {
          if (item.kind === 'variable') scope.globals.add(item.name);
        }
        return null;
      case 'static': {
        for (const item of node.items ?? node.variables ?? []) {
          const name = item.name?.name ?? item.variable?.name ?? item.name;
          const value = item.default ? await this.evalExpr(item.default, scope) : null;
          scope.vars.set(String(name), value);
        }
        return null;
      }
      case 'unset':
        for (const arg of node.variables ?? []) await this.evalUnset(arg, scope);
        return null;
      case 'try':
        return this.execTry(node, scope);
      case 'throw':
        throw new PhpThrown(await this.evalExpr(node.what, scope));
      case 'exit':
        throw new TerminateSignal(node.expression ? await this.evalExpr(node.expression, scope) : null);
      case 'declare':
        return null;
      case 'comment':
      case 'doc':
      case 'noop':
        return null;
      default:
        // Unknown statement kinds are almost always declarations we can skip,
        // but anything else must fail loudly so the compatibility matrix stays honest.
        if (node.kind.endsWith('declaration')) return null;
        throw new UnsupportedSyntax(node.kind);
    }
  }

  private async execIf(node: AstNode, scope: Scope): Promise<PhpValue> {
    if (truthy(await this.evalExpr(node.test, scope))) {
      return this.execStatement(node.body, scope);
    }
    if (node.alternate) {
      if (node.alternate.kind === 'if') return this.execIf(node.alternate, scope);
      return this.execStatement(node.alternate, scope);
    }
    return null;
  }

  private async loopGuard(body: () => Promise<PhpValue>): Promise<{ broke: boolean }> {
    try {
      await body();
      return { broke: false };
    } catch (e) {
      if (e instanceof PhpBreakSignal) {
        if (e.level > 1) throw new PhpBreakSignal(e.level - 1);
        return { broke: true };
      }
      if (e instanceof PhpContinueSignal) {
        if (e.level > 1) throw new PhpContinueSignal(e.level - 1);
        return { broke: false };
      }
      throw e;
    }
  }

  private async execWhile(node: AstNode, scope: Scope): Promise<PhpValue> {
    let guard = 0;
    while (truthy(await this.evalExpr(node.test, scope))) {
      const { broke } = await this.loopGuard(() => this.execStatement(node.body, scope));
      if (broke) break;
      if (++guard > 100000) throw new PhpError('Loop limit exceeded');
    }
    return null;
  }

  private async execDo(node: AstNode, scope: Scope): Promise<PhpValue> {
    let guard = 0;
    do {
      const { broke } = await this.loopGuard(() => this.execStatement(node.body, scope));
      if (broke) break;
      if (++guard > 100000) throw new PhpError('Loop limit exceeded');
    } while (truthy(await this.evalExpr(node.test, scope)));
    return null;
  }

  private async execFor(node: AstNode, scope: Scope): Promise<PhpValue> {
    for (const init of node.init ?? []) await this.evalExpr(init, scope);
    let guard = 0;
    while (node.test && node.test.length > 0 ? truthy(await this.evalExpr(node.test[0], scope)) : true) {
      const { broke } = await this.loopGuard(() => this.execStatement(node.body, scope));
      if (broke) break;
      for (const inc of node.increment ?? []) await this.evalExpr(inc, scope);
      if (++guard > 100000) throw new PhpError('Loop limit exceeded');
    }
    return null;
  }

  private async execForeach(node: AstNode, scope: Scope): Promise<PhpValue> {
    const source = await this.evalExpr(node.source, scope);
    const entries: Array<[string | number, PhpValue]> =
      source instanceof PhpArray
        ? source.entries()
        : Array.isArray(source)
          ? source.map((v, i) => [i, v] as [number, PhpValue])
          : [];

    for (const [key, value] of entries) {
      if (node.key) await this.assign(node.key, key, scope);
      if (node.value?.kind === 'list' || node.value?.kind === 'array') {
        await this.assignDestructuring(node.value, value, scope);
      } else {
        await this.assign(node.value, phpClone(value), scope);
      }
      const { broke } = await this.loopGuard(() => this.execStatement(node.body, scope));
      if (broke) break;
    }
    return null;
  }

  private async execSwitch(node: AstNode, scope: Scope): Promise<PhpValue> {
    const test = await this.evalExpr(node.test, scope);
    const cases: AstNode[] = (node.body?.children ?? []).filter((c: AstNode) => c.kind === 'case');
    let matched = -1;
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      if (c.test === null || c.test === undefined) continue;
      if (looseEq(test, await this.evalExpr(c.test, scope))) {
        matched = i;
        break;
      }
    }
    if (matched === -1) matched = cases.findIndex((c) => c.test === null || c.test === undefined);
    if (matched === -1) return null;

    try {
      for (let i = matched; i < cases.length; i++) {
        for (const stmt of cases[i].body ?? []) await this.execStatement(stmt, scope);
      }
    } catch (e) {
      if (e instanceof PhpBreakSignal) return null;
      throw e;
    }
    return null;
  }

  private async execTry(node: AstNode, scope: Scope): Promise<PhpValue> {
    let result: PhpValue = null;
    try {
      result = await this.execStatement(node.body, scope);
    } catch (e) {
      if (!(e instanceof PhpThrown)) throw e;
      const thrown = e.value;
      const catchScope = new Scope(scope.parent, scope.self);
      catchScope.vars = new Map(scope.vars);
      let handled = false;
      for (const c of node.catches ?? []) {
        const names: string[] = Array.isArray(c.key) ? c.key.map((k: AstNode) => k.name) : [c.key?.name];
        if (names.some((n) => this.matchException(thrown, n))) {
          if (c.variable) catchScope.set(c.variable.name, thrown);
          result = await this.execStatement(c.body, catchScope);
          handled = true;
          break;
        }
      }
      if (!handled) throw e;
    } finally {
      if (node.always) await this.execStatement(node.always, scope);
    }
    return result;
  }

  private matchException(thrown: PhpValue, name?: string): boolean {
    if (!name) return true;
    const actual = this.classNameOf(thrown);
    if (!actual) return false;
    const wanted = this.resolveClassName(name);
    for (const c of this.runtime.classChain(actual)) {
      if (c.name.toLowerCase() === wanted.toLowerCase()) return true;
    }
    return actual.toLowerCase() === wanted.toLowerCase();
  }

  classNameOf(value: PhpValue): string | null {
    if (value instanceof PhpObject) return value.cls.name;
    if (value && typeof value === 'object' && '__phpClass' in value) {
      return String((value as { __phpClass: unknown }).__phpClass);
    }
    return null;
  }

  private registerUse(node: AstNode): void {
    if (node.kind === 'usegroup') {
      const prefix = node.name ?? '';
      for (const item of node.items ?? []) {
        const full = `${prefix}\\${item.name}`.replace(/^\\/, '');
        const alias = (item.alias ?? item.name.split('\\').pop() ?? '').toLowerCase();
        this.uses.set(alias, full);
      }
    } else if (node.kind === 'useitem') {
      const full = (node.name ?? '').replace(/^\\/, '');
      const alias = (node.alias ?? full.split('\\').pop() ?? '').toLowerCase();
      this.uses.set(alias, full);
    }
  }

  private resolveClassName(raw: string): string {
    if (!raw) return raw;
    if (raw.startsWith('\\')) return raw.slice(1);
    const lower = raw.toLowerCase();
    if (lower === 'self' || lower === 'static') return this.currentClass ?? raw;
    if (lower === 'parent') {
      const cls = this.currentClass ? this.runtime.getClass(this.currentClass) : null;
      return cls && cls.parent ? cls.parent : raw;
    }
    const parts = raw.split('\\');
    const alias = this.uses.get(parts[0].toLowerCase());
    if (alias) return [alias, ...parts.slice(1)].join('\\');
    if (this.ns) {
      const candidate = `${this.ns}\\${raw}`;
      if (this.runtime.getClass(candidate)) return candidate;
    }
    return raw;
  }

  private resolveFunctionName(raw: string): string {
    if (!raw) return raw;
    if (raw.startsWith('\\')) return raw.slice(1);
    const parts = raw.split('\\');
    const alias = this.uses.get(parts[0].toLowerCase());
    if (alias) return [alias, ...parts.slice(1)].join('\\');
    if (this.ns) {
      const candidate = `${this.ns}\\${raw}`;
      if (this.runtime.getFunction(candidate)) return candidate;
    }
    return raw;
  }

  // -------------------------------------------------------------- declarations

  private defineUserFunction(node: AstNode): void {
    const name = node.name?.name ?? '';
    if (!name) return;
    const fn: UserFunction = {
      kind: 'user',
      name: this.ns ? `${this.ns}\\${name}` : name,
      params: this.readParams(node.arguments),
      body: node.body,
      file: this.ctx.file,
    };
    this.runtime.functions.set(fn.name.toLowerCase(), fn);
  }

  private readParams(args: AstNode[] = []): ParamDef[] {
    return args.map((arg) => ({
      name: arg.name?.name ?? arg.name ?? '',
      defaultValue: arg.value ?? undefined,
      variadic: !!arg.variadic,
    }));
  }

  private defineClass(node: AstNode): void {
    if (node.isAnonymous) return;
    const name = node.name?.name ?? '';
    if (!name) return;
    const fqn = this.ns ? `${this.ns}\\${name}` : name;
    const cls: UserClass = {
      kind: 'user',
      name: fqn,
      parent: node.extends?.name ? this.resolveClassName(node.extends.name) : undefined,
      implements: (node.implements ?? []).map((i: AstNode) => this.resolveClassName(i.name)),
      traits: [],
      methods: new Map(),
      props: new Map(),
      constants: new Map(),
      staticProps: new Map(),
      isAbstract: !!node.isAbstract,
      isInterface: node.kind === 'interface',
      isTrait: node.kind === 'trait',
      file: this.ctx.file,
      namespace: this.ns,
      imports: new Map(this.uses),
    };

    const previousClass = this.currentClass;
    this.currentClass = fqn;
    try {
      for (const member of node.body ?? []) {
        if (member.kind === 'method') {
          const method: MethodDef = {
            name: member.name.name,
            params: this.readParams(member.arguments),
            body: member.body,
            isStatic: !!member.isStatic,
            visibility: member.visibility ?? 'public',
          };
          cls.methods.set(member.name.name.toLowerCase(), method);
        } else if (member.kind === 'propertystatement' || member.kind === 'property') {
          const list = member.kind === 'property' ? [member] : member.properties ?? [member];
          for (const prop of list) {
            const propName = prop.name?.name ?? prop.name;
            if (!propName) continue;
            cls.props.set(propName, {
              name: propName,
              isStatic: !!(member.isStatic ?? prop.isStatic),
              defaultNode: prop.value ?? undefined,
              visibility: member.visibility ?? 'public',
            });
          }
        } else if (member.kind === 'classconstant' || member.kind === 'constantstatement') {
          for (const entry of member.constants ?? []) {
            const constName = entry.name?.name ?? entry.name;
            if (typeof constName === 'string') {
              cls.constants.set(constName, entry.value ? this.literalValue(entry.value) : null);
            }
          }
        } else if (member.kind === 'traituse') {
          for (const trait of member.traits ?? []) cls.traits.push(this.resolveClassName(trait.name));
        }
      }
    } finally {
      this.currentClass = previousClass;
    }

    this.runtime.addClass(cls);
  }

  /** Constants are evaluated lazily-ish; only literals/arrays are supported here. */
  private literalValue(node: AstNode): PhpValue {
    switch (node.kind) {
      case 'string':
        return node.value;
      case 'number':
        return this.numberValue(node.value);
      case 'boolean':
        return node.value;
      case 'nullkeyword':
        return null;
      case 'array': {
        const arr = new PhpArray();
        for (const item of node.items ?? []) {
          if (!item) continue;
          const value = this.literalValue(item.value);
          if (item.key) arr.set(this.literalValue(item.key), value);
          else arr.push(value);
        }
        return arr;
      }
      case 'unary':
        if (node.type === '-') return -toNum(this.literalValue(node.what));
        return this.literalValue(node.what);
      default:
        return null;
    }
  }

  private numberValue(raw: string): number {
    if (/^0x/i.test(raw)) return parseInt(raw, 16);
    if (/^0b/i.test(raw)) return parseInt(raw.slice(2), 2);
    if (/^0\d/.test(raw)) return parseInt(raw, 8);
    return Number(raw);
  }

  // --------------------------------------------------------------- expressions

  async evalExpr(node: AstNode, scope: Scope): Promise<PhpValue> {
    if (!node) return null;
    this.runtime.tick();
    if (++this.depth > MAX_DEPTH) {
      this.depth = 0;
      throw new PhpError('Maximum function nesting level reached');
    }
    try {
      return await this.evalExprInner(node, scope);
    } finally {
      this.depth--;
    }
  }

  private async evalExprInner(node: AstNode, scope: Scope): Promise<PhpValue> {
    switch (node.kind) {
      case 'string':
        return node.value ?? '';
      case 'number':
        return this.numberValue(String(node.value));
      case 'boolean':
        return node.value;
      case 'nullkeyword':
        return null;
      case 'variable':
        if (node.name === 'this') return scope.self;
        return scope.get(String(node.name));
      case 'this':
        return scope.self;
      case 'identifier':
        return node.name;
      case 'name':
        return node.name;
      case 'constref':
        return this.constantValue(String(node.name));
      case 'selfreference':
        return 'self';
      case 'parentreference':
        return 'parent';
      case 'staticreference':
        return 'static';
      case 'magic':
        return this.magicValue(String(node.value));
      case 'encapsed': {
        let out = '';
        for (const part of node.value ?? []) {
          if (part.kind === 'encapsedpart') out += toStr(await this.evalExpr(part.expression, scope));
          else out += toStr(await this.evalExpr(part, scope));
        }
        return out;
      }
      case 'array':
        return this.evalArray(node, scope);
      case 'bin':
        return this.evalBinary(node, scope);
      case 'unary':
        return this.evalUnary(node, scope);
      case 'pre':
      case 'post':
        return this.evalIncDec(node, scope);
      case 'assign':
      case 'assignref':
        return this.evalAssign(node, scope);
      case 'retif':
        return truthy(await this.evalExpr(node.test, scope))
          ? node.trueExpr
            ? this.evalExpr(node.trueExpr, scope)
            : await this.evalExpr(node.test, scope)
          : this.evalExpr(node.falseExpr, scope);
      case 'call':
        return this.evalCall(node, scope);
      case 'new':
        return this.evalNew(node, scope);
      case 'staticlookup':
        return this.evalStaticLookup(node, scope);
      case 'propertylookup':
      case 'nullsafepropertylookup':
        return this.evalProperty(node, scope);
      case 'offsetlookup':
        return this.evalOffset(node, scope);
      case 'closure':
        return this.evalClosure(node, scope);
      case 'arrowfunc':
        return this.evalArrowFunction(node, scope);
      case 'isset': {
        for (const v of node.variables ?? []) {
          if (!(await this.isSet(v, scope))) return false;
        }
        return true;
      }
      case 'empty':
        return !truthy(await this.evalExpr(node.expression, scope));
      case 'exit':
        throw new TerminateSignal(node.expression ? await this.evalExpr(node.expression, scope) : null);
      case 'print':
        this.ctx.echo(await this.evalExpr(node.expression, scope));
        return 1;
      case 'include': {
        const target = toStr(await this.evalExpr(node.target, scope));
        return this.includeFile(target, node.once);
      }
      case 'cast': {
        const value = await this.evalExpr(node.expr, scope);
        return this.castValue(String(node.type), value);
      }
      case 'silence':
        return this.evalExpr(node.expr, scope);
      case 'match':
        return this.evalMatch(node, scope);
      case 'clone':
        return phpClone(await this.evalExpr(node.what, scope));
      case 'parenthesized':
        return this.evalExpr(node.expression, scope);
      default:
        throw new UnsupportedSyntax(node.kind);
    }
  }

  private async evalArray(node: AstNode, scope: Scope): Promise<PhpArray> {
    const arr = new PhpArray();
    for (const item of node.items ?? []) {
      if (!item) {
        arr.push(null);
        continue;
      }
      if (item.kind === 'spread' || item.unpack) {
        const spread = await this.evalExpr(item.value ?? item, scope);
        if (spread instanceof PhpArray) for (const [k, v] of spread) arr.set(k, v);
        else if (Array.isArray(spread)) for (const v of spread) arr.push(v);
        continue;
      }
      const value = await this.evalExpr(item.value, scope);
      if (item.key) arr.set(await this.evalExpr(item.key, scope), value);
      else arr.push(value);
    }
    return arr;
  }

  private async evalBinary(node: AstNode, scope: Scope): Promise<PhpValue> {
    const op = String(node.type);

    if (op === '&&' || op === 'and') {
      return truthy(await this.evalExpr(node.left, scope)) ? truthy(await this.evalExpr(node.right, scope)) : false;
    }
    if (op === '||' || op === 'or') {
      return truthy(await this.evalExpr(node.left, scope)) ? true : truthy(await this.evalExpr(node.right, scope));
    }
    if (op === '??') {
      const left = await this.evalExpr(node.left, scope);
      return left === null || left === undefined ? this.evalExpr(node.right, scope) : left;
    }

    const left = await this.evalExpr(node.left, scope);
    const right = await this.evalExpr(node.right, scope);
    return this.applyBinary(op, left, right);
  }

  private applyBinary(op: string, left: PhpValue, right: PhpValue): PhpValue {
    switch (op) {
      case '.':
        return toStr(left) + toStr(right);
      case '+':
        if (left instanceof PhpArray && right instanceof PhpArray) {
          const out = left.clone();
          for (const [k, v] of right) if (!out.has(k)) out.set(k, v);
          return out;
        }
        return toNum(left) + toNum(right);
      case '-':
        return toNum(left) - toNum(right);
      case '*':
        return toNum(left) * toNum(right);
      case '/': {
        const divisor = toNum(right);
        if (divisor === 0) throw new PhpError('Division by zero');
        return toNum(left) / divisor;
      }
      case '%':
        return toNum(left) % toNum(right);
      case '**':
        return Math.pow(toNum(left), toNum(right));
      case '==':
        return looseEq(left, right);
      case '!=':
      case '<>':
        return !looseEq(left, right);
      case '===':
        return strictEq(left, right);
      case '!==':
        return !strictEq(left, right);
      case '<':
        return spaceship(left, right) < 0;
      case '>':
        return spaceship(left, right) > 0;
      case '<=':
        return spaceship(left, right) <= 0;
      case '>=':
        return spaceship(left, right) >= 0;
      case '<=>':
        return spaceship(left, right);
      case 'xor':
        return truthy(left) !== truthy(right);
      case '&':
        return toInt(left) & toInt(right);
      case '|':
        return toInt(left) | toInt(right);
      case '^':
        return toInt(left) ^ toInt(right);
      case '<<':
        return toInt(left) << toInt(right);
      case '>>':
        return toInt(left) >> toInt(right);
      case 'instanceof': {
        const className = typeof right === 'string' ? right : toStr(right);
        return this.instanceOf(left, className);
      }
      default:
        throw new UnsupportedSyntax(`bin ${op}`);
    }
  }

  private instanceOf(value: PhpValue, className: string): boolean {
    const actual = this.classNameOf(value);
    if (!actual) return false;
    const wanted = this.resolveClassName(className).toLowerCase();
    if (actual.toLowerCase() === wanted) return true;
    for (const c of this.runtime.classChain(actual)) {
      if (c.name.toLowerCase() === wanted) return true;
      if (c.implements.some((i) => i.toLowerCase() === wanted)) return true;
    }
    return false;
  }

  private async evalUnary(node: AstNode, scope: Scope): Promise<PhpValue> {
    const type = String(node.type);
    if (type === '@') return this.evalExpr(node.what, scope);
    const value = await this.evalExpr(node.what, scope);
    switch (type) {
      case '!':
        return !truthy(value);
      case '-':
        return -toNum(value);
      case '+':
        return toNum(value);
      case '~':
        return ~toInt(value);
      case 'clone':
        return phpClone(value);
      default:
        return value;
    }
  }

  private async evalIncDec(node: AstNode, scope: Scope): Promise<PhpValue> {
    const current = toNum(await this.evalExpr(node.what, scope));
    const delta = node.type === '+' || node.type === '++' ? 1 : -1;
    const next = current + delta;
    await this.assign(node.what, next, scope);
    return node.kind === 'pre' ? next : current;
  }

  private async evalAssign(node: AstNode, scope: Scope): Promise<PhpValue> {
    const operator = String(node.operator ?? '=');
    if (operator === '=' || operator === '=&') {
      const value = await this.evalExpr(node.right, scope);
      await this.assign(node.left, value, scope);
      return value;
    }
    if (operator === '??=') {
      const current = await this.tryRead(node.left, scope);
      if (current !== null && current !== undefined) return current;
      const value = await this.evalExpr(node.right, scope);
      await this.assign(node.left, value, scope);
      return value;
    }
    const current = await this.evalExpr(node.left, scope);
    const right = await this.evalExpr(node.right, scope);
    const baseOp = operator.slice(0, -1);
    const value = await this.applyBinary(baseOp, current, right);
    await this.assign(node.left, value, scope);
    return value;
  }

  private async isSet(node: AstNode, scope: Scope): Promise<boolean> {
    try {
      if (node.kind === 'variable') {
        const value = scope.get(String(node.name));
        return value !== undefined && value !== null;
      }
      if (node.kind === 'propertylookup') {
        const target = await this.evalExpr(node.what, scope);
        const name = await this.propName(node.offset, scope);
        if (isPhpHost(target)) return target.phpIsset ? target.phpIsset(name) : (target.phpGet(name) ?? null) !== null;
        if (isPhpObject(target)) return target.props.has(name) || !!this.runtime.findProperty(target.cls, name);
        return false;
      }
      if (node.kind === 'offsetlookup') {
        const target = await this.evalExpr(node.what, scope);
        const offset = node.offset ? await this.evalExpr(node.offset, scope) : null;
        return target instanceof PhpArray ? target.has(offset) : false;
      }
      const value = await this.evalExpr(node, scope);
      return value !== null && value !== undefined;
    } catch {
      return false;
    }
  }

  private async tryRead(node: AstNode, scope: Scope): Promise<PhpValue> {
    try {
      return await this.evalExpr(node, scope);
    } catch {
      return null;
    }
  }

  private async evalMatch(node: AstNode, scope: Scope): Promise<PhpValue> {
    const subject = await this.evalExpr(node.cond, scope);
    for (const arm of node.arms ?? []) {
      if (!arm.conds) return this.evalExpr(arm.body, scope);
      for (const cond of arm.conds) {
        if (strictEq(subject, await this.evalExpr(cond, scope))) return this.evalExpr(arm.body, scope);
      }
    }
    throw new PhpError('Unhandled match case');
  }

  private castValue(type: string, value: PhpValue): PhpValue {
    switch (type) {
      case 'int':
      case 'integer':
        return toInt(value);
      case 'float':
      case 'double':
      case 'real':
        return toNum(value);
      case 'string':
      case 'binary':
        return toStr(value);
      case 'bool':
      case 'boolean':
        return truthy(value);
      case 'array':
        if (value instanceof PhpArray) return value;
        if (Array.isArray(value)) return new PhpArray(value.map((v, i) => [i, v] as [number, PhpValue]));
        return new PhpArray(value === null ? [] : [[0, value]]);
      case 'unset':
        return null;
      default:
        return value;
    }
  }

  private async evalClosure(node: AstNode, scope: Scope): Promise<UserFunction> {
    const captured = new Map<string, PhpValue>();
    for (const use of node.uses ?? []) {
      const name = use.name ?? use;
      captured.set(String(name), scope.get(String(name)));
    }
    return {
      kind: 'user',
      name: `{closure}@${this.ctx.file}`,
      params: this.readParams(node.arguments),
      body: node.body,
      uses: [...captured.keys()],
      captured,
      isStatic: !!node.isStatic,
      file: this.ctx.file,
    };
  }

  private async evalArrowFunction(node: AstNode, scope: Scope): Promise<UserFunction> {
    return {
      kind: 'user',
      name: `{closure}@${this.ctx.file}`,
      params: this.readParams(node.arguments),
      body: { kind: 'return', expr: node.body } as unknown as AstNode,
      captured: new Map(),
      file: this.ctx.file,
    };
  }

  private constantValue(name: string): PhpValue {
    const key = name.replace(/^\\/, '');
    if (this.runtime.constants.has(key)) return this.runtime.constants.get(key);
    const upper = key.toUpperCase();
    if (this.runtime.constants.has(upper)) return this.runtime.constants.get(upper);
    if (this.currentClass) {
      const cls = this.runtime.getClass(this.currentClass);
      if (cls?.kind === 'user') {
        const found = this.runtime.findConstant(cls, key);
        if (found !== undefined) return found;
      }
    }
    if (upper === 'PHP_EOL') return '\n';
    if (upper === 'PHP_INT_MAX') return Number.MAX_SAFE_INTEGER;
    if (upper === 'PHP_INT_MIN') return Number.MIN_SAFE_INTEGER;
    if (upper === 'M_PI') return Math.PI;
    if (upper === 'ENT_QUOTES') return 3;
    if (upper === 'ENT_COMPAT') return 2;
    if (upper === 'ENT_NOQUOTES') return 0;
    if (upper === 'PHP_URL_HOST') return 1;
    if (upper === 'PHP_URL_PATH') return 5;
    if (upper === 'PASSWORD_DEFAULT') return '2y';
    throw new PhpError(`Undefined constant "${key}"`);
  }

  private magicValue(name: string): PhpValue {
    switch (name) {
      case '__CLASS__':
        return this.currentClass ?? '';
      case '__NAMESPACE__':
        return this.ns;
      case '__FILE__':
        return this.ctx.file;
      case '__DIR__':
        return this.ctx.file.replace(/\/[^/]+$/, '');
      case '__LINE__':
        return 0;
      case '__FUNCTION__':
        return '';
      case '__METHOD__':
        return '';
      default:
        return '';
    }
  }

  // ------------------------------------------------------------------- calls

  private enterClass(cls: UserClass): () => void {
    const previousClass = this.currentClass;
    const previousNs = this.ns;
    const previousUses = this.uses;
    this.currentClass = cls.name;
    this.ns = cls.namespace ?? '';
    this.uses = new Map(cls.imports);
    return () => {
      this.currentClass = previousClass;
      this.ns = previousNs;
      this.uses = previousUses;
    };
  }

  private async evalCall(node: AstNode, scope: Scope): Promise<PhpValue> {
    const what = node.what;
    const args = await this.evalArgs(node.arguments, scope);

    if (what.kind === 'name') {
      const name = this.resolveFunctionName(what.name);
      return this.callFunction(name, args, scope);
    }
    if (what.kind === 'propertylookup' || what.kind === 'nullsafepropertylookup') {
      const target = await this.evalExpr(what.what, scope);
      if ((what.nullsafe || what.kind === 'nullsafepropertylookup') && (target === null || target === undefined)) {
        return null;
      }
      const name = await this.propName(what.offset, scope);
      const result = await this.callMethod(target, name, args, scope);
      // Typecho widgets expose ->to($var) to alias a widget into a variable
      // (by-reference assignment in PHP). Emulate it at the call site.
      if (name === 'to' && node.arguments?.[0]?.kind === 'variable') {
        scope.set(String(node.arguments[0].name), result ?? target);
      }
      return result;
    }
    if (what.kind === 'staticlookup') {
      const cls = await this.resolveClassRef(what.what, scope);
      const name = await this.staticName(what.offset, scope);
      return this.callStatic(cls, name, args, scope);
    }
    if (what.kind === 'variable' || what.kind === 'offsetlookup') {
      const fn = await this.evalExpr(what, scope);
      return this.invoke(fn, args, scope);
    }
    if (what.kind === 'closure' || what.kind === 'arrowfunc') {
      return this.invoke(await this.evalExpr(what, scope), args, scope);
    }
    const fn = await this.evalExpr(what, scope);
    return this.invoke(fn, args, scope);
  }

  private async evalArgs(nodes: AstNode[] = [], scope: Scope): Promise<PhpValue[]> {
    const args: PhpValue[] = [];
    for (const arg of nodes) {
      // php-parser emits bare expressions for plain arguments and wraps named /
      // unpacked arguments in an argument node.
      const isWrapper = arg.kind === 'argument';
      if (isWrapper && arg.unpack) {
        const spread = await this.evalExpr(arg.value, scope);
        if (spread instanceof PhpArray) args.push(...spread.values());
        else if (Array.isArray(spread)) args.push(...spread);
      } else {
        args.push(await this.evalExpr(isWrapper ? arg.value : arg, scope));
      }
    }
    return args;
  }

  private async callFunction(name: string, args: PhpValue[], scope: Scope): Promise<PhpValue> {
    const fn = this.runtime.getFunction(name);
    if (!fn) {
      // PHP resolves unqualified calls against the global namespace as a fallback.
      const short = name.split('\\').pop() ?? name;
      const fallback = this.runtime.getFunction(short);
      if (fallback) return this.invoke(fallback, args, scope, short);
      throw new PhpError(`Call to undefined function ${name}()`);
    }
    return this.invoke(fn, args, scope, name);
  }

  private async invoke(fn: Callable | PhpValue, args: PhpValue[], scope: Scope, name?: string): Promise<PhpValue> {
    if (fn && typeof fn === 'object' && (fn as Callable).kind === 'host') {
      return (fn as { fn: (...a: any[]) => unknown }).fn(...args);
    }
    if (fn && typeof fn === 'object' && (fn as Callable).kind === 'user') {
      const user = fn as UserFunction;
      const local = new Scope(scope.parent, scope.self);
      for (const [k, v] of user.captured ?? []) local.vars.set(k, v);
      this.bindParams(local, user.params, args);
      try {
        await this.execStatement(user.body, local);
      } catch (e) {
        if (e instanceof PhpReturnSignal) return e.value;
        throw e;
      }
      return null;
    }
    if (typeof fn === 'string') {
      if (fn.includes('::')) {
        const [cls, method] = fn.split('::');
        return this.callStatic(this.resolveClassName(cls), method, args, scope);
      }
      return this.callFunction(fn, args, scope);
    }
    if (fn instanceof PhpArray) {
      const target = fn.get(0);
      const method = toStr(fn.get(1));
      return this.callMethod(target, method, args, scope);
    }
    throw new PhpError(`Value is not callable${name ? ` (${name})` : ''}`);
  }

  private bindParams(scope: Scope, params: ParamDef[], args: PhpValue[]): void {
    let index = 0;
    for (const param of params) {
      if (param.variadic) {
        const rest = new PhpArray();
        for (; index < args.length; index++) rest.push(args[index]);
        scope.vars.set(param.name, rest);
        return;
      }
      if (index < args.length) scope.vars.set(param.name, args[index++]);
      else if (param.defaultValue) scope.vars.set(param.name, this.literalOrNull(param.defaultValue));
      else scope.vars.set(param.name, null);
    }
  }

  private literalOrNull(node: AstNode): PhpValue {
    try {
      return this.literalValue(node);
    } catch {
      return null;
    }
  }

  private async callMethod(target: PhpValue, name: string, args: PhpValue[], scope: Scope): Promise<PhpValue> {
    const lower = name.toLowerCase();
    if (isPhpHost(target)) return target.phpCall(name, args);
    if (target instanceof PhpObject) {
      const method = this.runtime.findMethod(target.cls, lower);
      if (!method) throw new PhpError(`Call to undefined method ${target.cls.name}::${name}()`);
      const local = new Scope(scope.parent, target);
      this.bindParams(local, method.params, args);
      const restore = this.enterClass(target.cls);
      try {
        await this.execStatement(method.body, local);
      } catch (e) {
        if (e instanceof PhpReturnSignal) return e.value;
        throw e;
      } finally {
        restore();
      }
      return null;
    }
    // Host classes may hand out plain objects with methods (e.g. Exception shim).
    const maybe = target as { __phpMethods?: Record<string, (...a: any[]) => unknown>; [key: string]: unknown };
    if (maybe && typeof maybe === 'object' && maybe.__phpMethods?.[lower]) {
      return maybe.__phpMethods[lower](...args);
    }
    if (maybe && typeof maybe === 'object' && typeof maybe[name] === 'function') {
      return (maybe[name] as (...a: any[]) => unknown)(...args);
    }
    throw new PhpError(`Call to a member function ${name}() on ${typeof target}`);
  }

  /** Invoke a validated static hook without evaluating PHP from a dynamic source. */
  async invokeStatic(clsName: string, name: string): Promise<PhpValue> {
    return this.callStatic(clsName, name, [], new Scope());
  }

  private async callStatic(clsName: string, name: string, args: PhpValue[], scope: Scope): Promise<PhpValue> {
    const cls = this.runtime.getClass(clsName);
    if (!cls) throw new PhpError(`Class "${clsName}" not found`);
    if (cls.kind === 'host') {
      const statics = cls.statics ?? {};
      const key = Object.keys(statics).find((k) => k.toLowerCase() === name.toLowerCase());
      if (key) return statics[key](...args);
      if (name === 'class') return cls.name;
      throw new PhpError(`Call to undefined static method ${cls.name}::${name}()`);
    }
    const method = this.runtime.findMethod(cls, name);
    if (!method) {
      if (name.toLowerCase() === 'class') return cls.name;
      throw new PhpError(`Call to undefined static method ${cls.name}::${name}()`);
    }
    const local = new Scope(scope.parent, null);
    this.bindParams(local, method.params, args);
    const restore = this.enterClass(cls);
    try {
      await this.execStatement(method.body, local);
    } catch (e) {
      if (e instanceof PhpReturnSignal) return e.value;
      throw e;
    } finally {
      restore();
    }
    return null;
  }

  private async resolveClassRef(node: AstNode, scope: Scope): Promise<string> {
    if (node.kind === 'name') return this.resolveClassName(node.name);
    if (node.kind === 'variable') return toStr(await this.evalExpr(node, scope));
    if (node.kind === 'staticlookup') {
      const inner = await this.resolveClassRef(node.what, scope);
      return toStr(await this.evalStaticLookup({ ...node, what: { kind: 'name', name: inner } } as AstNode, scope));
    }
    return this.resolveClassName(toStr(await this.evalExpr(node, scope)));
  }

  private async evalNew(node: AstNode, scope: Scope): Promise<PhpValue> {
    const args = await this.evalArgs(node.arguments, scope);
    if (node.what?.kind === 'class') {
      // anonymous class: minimal support
      return { __phpClass: 'stdClass' };
    }
    const clsName = await this.resolveClassRef(node.what, scope);
    const cls = this.runtime.getClass(clsName);
    if (!cls) throw new PhpError(`Class "${clsName}" not found`);
    if (cls.kind === 'host') {
      if (cls.construct) {
        const instance = cls.construct(args);
        if (instance && typeof instance === 'object' && cls.methods) {
          const target = instance as { __phpMethods?: Record<string, (...a: any[]) => unknown> };
          target.__phpMethods = cls.methods;
        }
        return instance;
      }
      return { __phpClass: cls.name, __phpMethods: cls.methods ?? {} };
    }
    const obj = new PhpObject(cls);
    for (const c of this.runtime.classChain(cls.name).reverse()) {
      for (const prop of c.props.values()) {
        if (prop.isStatic) continue;
        obj.props.set(prop.name, prop.defaultValue ?? (prop.defaultNode ? this.literalOrNull(prop.defaultNode) : null));
      }
    }
    const ctor = this.runtime.findMethod(cls, '__construct');
    if (ctor) {
      const local = new Scope(scope.parent, obj);
      this.bindParams(local, ctor.params, args);
      const restore = this.enterClass(cls);
      try {
        await this.execStatement(ctor.body, local);
      } catch (e) {
        if (!(e instanceof PhpReturnSignal)) throw e;
      } finally {
        restore();
      }
    }
    return obj;
  }

  private async evalStaticLookup(node: AstNode, scope: Scope): Promise<PhpValue> {
    const clsName = await this.resolveClassRef(node.what, scope);
    const name = await this.staticName(node.offset, scope);
    const cls = this.runtime.getClass(clsName);
    if (!cls) throw new PhpError(`Class "${clsName}" not found`);
    if (cls.kind === 'host') {
      if (cls.constants && name in cls.constants) return cls.constants[name];
      if (cls.staticProps && name in cls.staticProps) return cls.staticProps[name];
      if (name === 'class') return cls.name;
      return null;
    }
    if (name.toLowerCase() === 'class') return cls.name;
    const constant = this.runtime.findConstant(cls, name);
    if (constant !== undefined) return constant;
    const prop = this.runtime.findProperty(cls, name);
    if (prop?.isStatic) {
      if (!cls.staticProps.has(name)) {
        cls.staticProps.set(name, prop.defaultNode ? this.literalOrNull(prop.defaultNode) : null);
      }
      return cls.staticProps.get(name);
    }
    return null;
  }

  /** Static member names (self::$prop) are literals, not variable lookups. */
  private async staticName(offset: AstNode, scope: Scope): Promise<string> {
    if (offset?.kind === 'variable' && !offset.curly) return String(offset.name);
    return this.propName(offset, scope);
  }

  private async propName(offset: AstNode, scope: Scope): Promise<string> {
    if (!offset) return '';
    if (offset.kind === 'identifier' || offset.kind === 'constref' || offset.kind === 'name') return String(offset.name);
    return toStr(await this.evalExpr(offset, scope));
  }

  private async evalProperty(node: AstNode, scope: Scope): Promise<PhpValue> {
    const target = await this.evalExpr(node.what, scope);
    if ((node.nullsafe || node.kind === 'nullsafepropertylookup') && (target === null || target === undefined)) {
      return null;
    }
    const name = await this.propName(node.offset, scope);
    if (isPhpHost(target)) return target.phpGet(name);
    if (target instanceof PhpObject) {
      if (target.props.has(name)) return target.props.get(name);
      const prop = this.runtime.findProperty(target.cls, name);
      return prop?.defaultValue ?? (prop?.defaultNode ? this.literalOrNull(prop.defaultNode) : null);
    }
    if (target && typeof target === 'object') {
      const val = (target as Record<string, unknown>)[name];
      if (typeof val === 'function') return (val as (...a: unknown[]) => unknown).bind(target);
      return val ?? null;
    }
    return null;
  }

  private async evalOffset(node: AstNode, scope: Scope): Promise<PhpValue> {
    const target = await this.evalExpr(node.what, scope);
    const offset = node.offset ? await this.evalExpr(node.offset, scope) : null;
    if (target instanceof PhpArray) return target.get(offset) ?? null;
    if (typeof target === 'string') {
      const index = toInt(offset);
      return target[index] ?? '';
    }
    if (Array.isArray(target)) return target[toInt(offset)] ?? null;
    if (target && typeof target === 'object') return (target as Record<string, unknown>)[toStr(offset)] ?? null;
    return null;
  }

  // ---------------------------------------------------------------- assignment

  async assign(node: AstNode, value: PhpValue, scope: Scope): Promise<void> {
    if (!node) return;
    switch (node.kind) {
      case 'variable':
        scope.set(String(node.name), value);
        return;
      case 'list':
      case 'array':
        await this.assignDestructuring(node, value, scope);
        return;
      case 'offsetlookup': {
        const target = await this.evalExpr(node.what, scope);
        if (target instanceof PhpArray) {
          if (node.offset === null || node.offset === undefined) target.push(value);
          else target.set(await this.evalExpr(node.offset, scope), value);
          return;
        }
        if (Array.isArray(target)) {
          if (node.offset === null || node.offset === undefined) target.push(value);
          else target[toInt(await this.evalExpr(node.offset, scope))] = value;
          return;
        }
        if (typeof target === 'string' && node.offset) {
          const index = toInt(await this.evalExpr(node.offset, scope));
          const chars = [...target];
          chars[index] = toStr(value);
          await this.assign(node.what, chars.join(''), scope);
          return;
        }
        throw new PhpError('Cannot use a scalar value as an array');
      }
      case 'propertylookup': {
        const target = await this.evalExpr(node.what, scope);
        const name = await this.propName(node.offset, scope);
        if (isPhpHost(target)) {
          if (target.phpSet) target.phpSet(name, value);
          return;
        }
        if (target instanceof PhpObject) {
          target.props.set(name, value);
          return;
        }
        if (target && typeof target === 'object') {
          (target as Record<string, unknown>)[name] = value;
          return;
        }
        throw new PhpError('Attempt to assign property on non-object');
      }
      case 'staticlookup': {
        const clsName = await this.resolveClassRef(node.what, scope);
        const name = await this.staticName(node.offset, scope);
        const cls = this.runtime.getClass(clsName);
        if (!cls) throw new PhpError(`Class "${clsName}" not found`);
        if (cls.kind === 'host') {
          cls.staticProps = cls.staticProps ?? {};
          cls.staticProps[name] = value;
        } else {
          cls.staticProps.set(name, value);
        }
        return;
      }
      default:
        throw new PhpError(`Cannot assign to ${node.kind}`);
    }
  }

  private async assignDestructuring(node: AstNode, value: PhpValue, scope: Scope): Promise<void> {
    const items = node.items ?? [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      const key = item.key ? await this.evalExpr(item.key, scope) : i;
      const current = value instanceof PhpArray ? value.get(key) : null;
      await this.assign(item.value, current, scope);
    }
  }

  private async evalUnset(node: AstNode, scope: Scope): Promise<void> {
    if (node.kind === 'variable') {
      scope.vars.delete(String(node.name));
      return;
    }
    if (node.kind === 'offsetlookup') {
      const target = await this.evalExpr(node.what, scope);
      if (target instanceof PhpArray) target.delete(await this.evalExpr(node.offset, scope));
      return;
    }
    if (node.kind === 'propertylookup') {
      const target = await this.evalExpr(node.what, scope);
      const name = await this.propName(node.offset, scope);
      if (target instanceof PhpObject) target.props.delete(name);
      return;
    }
  }

  // ----------------------------------------------------------------- includes

  private async includeFile(path: string, once: boolean): Promise<PhpValue> {
    const read = this.runtime.host.readFile;
    if (!read) throw new PhpError(`Cannot include "${path}" without a file store`);
    const resolved = await read(path, this.ctx.file);
    if (!resolved) throw new PhpError(`Failed opening required "${path}"`);
    if (once && this.runtime.includedFiles.has(resolved.path)) return 1;
    this.runtime.includedFiles.add(resolved.path);
    const child: ExecContext = {
      out: this.ctx.out,
      echo: this.ctx.echo,
      runtime: this.runtime,
      file: resolved.path,
      self: this.ctx.self,
    };
    const interpreter = new Interpreter(this.runtime, child);
    return interpreter.run(resolved.code, resolved.path);
  }
}
