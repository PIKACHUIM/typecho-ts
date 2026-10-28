import { createRuntime, Interpreter, makeHost, toStr, type ExecContext } from '../../php-compat';
import { PLUGIN_SOURCES } from '../generated/plugins';
import type { SiteOptions } from './options';

const MAX_OUTPUT_BYTES = 4096;
const MAX_OPERATIONS = 20000;
const encoder = new TextEncoder();
const HOOK = 'admin/menu.php:navBar';

export function bundledPluginNames(): string[] {
  return Object.keys(PLUGIN_SOURCES).sort();
}

/** Only a build-time PHP file can register and execute a supported hook. */
export async function renderPluginNavBar(options: SiteOptions): Promise<string> {
  const enabled = options.get('phpPluginHooks');
  if (!Array.isArray(enabled)) return '';
  const fragments: string[] = [];
  for (const name of bundledPluginNames()) {
    if (!enabled.includes(name)) continue;
    try {
      const source = PLUGIN_SOURCES[name]['Plugin.php'];
      const filename = `plugins/${name}/Plugin.php`;
      const out: string[] = [];
      let bytes = 0;
      const echo = (value: unknown) => {
        const text = toStr(value);
        bytes += encoder.encode(text).length;
        if (bytes > MAX_OUTPUT_BYTES) throw new Error('Plugin output limit exceeded');
        out.push(text);
      };
      const runtime = createRuntime({ maxOperations: MAX_OPERATIONS, echo });
      // Plugin PHP only sees these safe functions and the two explicit host classes.
      for (const functionName of runtime.functions.keys()) {
        if (functionName !== 'defined' && functionName !== 'htmlspecialchars') runtime.functions.delete(functionName);
      }
      const hooks = new Map<string, string>();
      runtime.addClass({
        kind: 'host',
        name: 'Typecho\\Plugin',
        statics: {
          factory: (file: unknown) => {
            if (file !== 'admin/menu.php') throw new Error('Unsupported plugin hook source');
            return makeHost({
              set: (hook, callback) => {
                if (hook !== 'navBar' || typeof callback !== 'string') throw new Error('Unsupported plugin hook');
                hooks.set(HOOK, callback);
              },
            });
          },
        },
      });
      runtime.addClass({
        kind: 'host',
        name: 'Widget\\Options',
        statics: {
          alloc: () => makeHost({ methods: {
            plugin: (requested: unknown) => {
              if (requested !== name) throw new Error('Plugin configuration is not available');
              const config = options.pluginConfig(name);
              return makeHost({ get: (key) => {
                const value = config.get(key) ?? (name === 'HelloWorld' && key === 'word' ? 'Hello World' : null);
                if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Unsupported plugin configuration');
                if (typeof value === 'string' && value.length > MAX_OUTPUT_BYTES) throw new Error('Plugin configuration too large');
                return value;
              } });
            },
          } }),
        },
      });
      const ctx: ExecContext = { out, echo, runtime, file: filename };
      const interpreter = new Interpreter(runtime, ctx);
      await interpreter.run(source, filename);
      const className = `TypechoPlugin\\${name}\\Plugin`;
      const cls = runtime.getClass(className);
      if (!cls || cls.kind !== 'user' || cls.file !== filename) throw new Error('Invalid bundled plugin class');
      await interpreter.invokeStatic(className, 'activate');
      const callback = hooks.get(HOOK);
      if (!callback) continue;
      const [targetClass, method, extra] = callback.split('::');
      const def = runtime.getClass(targetClass);
      const hookMethod = def?.kind === 'user' ? def.methods.get(method?.toLowerCase() ?? '') : undefined;
      if (extra !== undefined || targetClass !== className || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(method ?? '') ||
          def?.kind !== 'user' || def.file !== filename || !hookMethod?.isStatic || hookMethod.visibility !== 'public') {
        throw new Error('Invalid plugin hook callback');
      }
      // Discard activation output, commit the hook output only on full success.
      out.length = 0;
      bytes = 0;
      await interpreter.invokeStatic(className, method);
      fragments.push(out.join(''));
    } catch {
      // Per-plugin failure is isolated: no partial output or request-level error.
    }
  }
  return fragments.join('');
}
