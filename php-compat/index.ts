import { registerBuiltins } from './builtins';
import { TerminateSignal } from './errors';
import { Interpreter, type ExecContext } from './interpreter';
import { parsePhp } from './parse';
import { Runtime, type RuntimeHostOptions } from './runtime';
import { toStr } from './values';

export * from './runtime';
export * from './values';
export * from './host';
export * from './errors';
export { Interpreter, parsePhp, registerBuiltins };
export type { ExecContext };

/** Creates a PHP runtime with all builtins registered. */
export function createRuntime(host: RuntimeHostOptions = {}): Runtime {
  const runtime = new Runtime(host);
  registerBuiltins(runtime);
  // Constants Typecho defines in its bootstrap; templates rely on them.
  runtime.defineConstant('__TYPECHO_ROOT_DIR__', '/');
  runtime.defineConstant('__TYPECHO_THEME_DIR__', '/usr/themes');
  runtime.defineConstant('__TYPECHO_PLUGIN_DIR__', '/usr/plugins');
  runtime.defineConstant('__TYPECHO_ADMIN_DIR__', '/admin/');
  runtime.defineConstant('__TYPECHO_UPLOAD_DIR__', '/usr/uploads');
  runtime.defineConstant('__TYPECHO_VERSION__', '1.3.1');
  return runtime;
}

export interface RenderResult {
  output: string;
  runtime: Runtime;
}

/**
 * Executes a PHP template and returns everything it echoed.
 * `exit`/`die` ends rendering without throwing.
 */
export async function renderPhp(runtime: Runtime, source: string, filename: string): Promise<RenderResult> {
  const out: string[] = [];
  const ctx: ExecContext = {
    out,
    echo: (v) => {
      out.push(toStr(v));
    },
    runtime,
    file: filename,
  };
  const interpreter = new Interpreter(runtime, ctx);
  try {
    await interpreter.runAst(parsePhp(source, filename), filename);
  } catch (e) {
    if (!(e instanceof TerminateSignal)) throw e;
  }
  return { output: out.join(''), runtime };
}
