import { describe, expect, it } from 'vitest';
import { createRuntime, renderPhp } from '../php-compat';
import { Runtime } from '../php-compat/runtime';
import { makeHost } from '../php-compat/host';

async function run(code: string, setup?: (runtime: Runtime) => void): Promise<string> {
  const runtime = createRuntime();
  setup?.(runtime);
  const { output } = await renderPhp(runtime, code, 'test.php');
  return output;
}

describe('PHP subset interpreter', () => {
  it('handles echo, variables, concatenation and short tags', async () => {
    expect(await run('<?php $a = "x"; $b = 2; echo $a . $b; ?><?= 3 + 4 ?>')).toBe('x27');
  });

  it('supports if / elseif / else with alternative syntax', async () => {
    const code = `<?php $n = 2; if ($n === 1): ?>one<?php elseif ($n === 2): ?>two<?php else: ?>many<?php endif; ?>`;
    expect(await run(code)).toBe('two');
  });

  it('supports while/endwhile and foreach with key/value', async () => {
    const code = `<?php $i = 0; while ($i < 3): echo $i; $i++; endwhile; foreach (["a" => 1, "b" => 2] as $k => $v) { echo $k . $v; } ?>`;
    expect(await run(code)).toBe('012a1b2');
  });

  it('supports functions with defaults, closures and arrow functions', async () => {
    const code = `<?php
      function greet(string $name = "world") { return "hi " . $name; }
      $upper = function ($s) { return strtoupper($s); };
      $double = fn($x) => $x * 2;
      echo greet(); echo $upper("ok"); echo $double(21);
    ?>`;
    expect(await run(code)).toBe('hi worldOK42');
  });

  it('supports classes, static members and constants', async () => {
    const code = `<?php
      class Counter {
        const STEP = 2;
        public static $count = 0;
        private $name;
        function __construct($name) { $this->name = $name; }
        function bump() { self::$count += self::STEP; return $this->name . self::$count; }
      }
      $a = new Counter("a");
      echo $a->bump();
      echo Counter::$count;
    ?>`;
    expect(await run(code)).toBe('a22');
  });

  it('supports string interpolation and ternary / null coalescing', async () => {
    const code = `<?php $name = "ty"; $n = null; echo "hello {$name}"; echo $n ?? "fallback"; echo $name === "ty" ? "!" : "?"; ?>`;
    expect(await run(code)).toBe('hello tyfallback!');
  });

  it('supports isset / empty / unset and array helpers', async () => {
    const code = `<?php $a = ["x" => 1]; if (isset($a["x"]) && !empty($a["x"])) { echo count($a); } unset($a["x"]); echo empty($a) ? "empty" : "set"; ?>`;
    expect(await run(code)).toBe('1empty');
  });

  it('runs host objects through get/call bridges', async () => {
    const host = makeHost({
      props: { title: 'Hello' },
      methods: {
        title: () => undefined,
        shout: (word: unknown) => `${String(word).toUpperCase()}!`,
      },
      call: (name: string, args: unknown[]) => `${name}:${args.join(',')}`,
    });
    const code = `<?php echo $this->title; echo $this->shout("yes"); echo $this->missing(1); ?>`;
    const runtime = createRuntime();
    runtime.globals.set('__echo__', null);
    const out: string[] = [];
    const { output } = await renderPhpWithSelf(runtime, code, host, out);
    expect(output).toBe('HelloYES!missing:1');
  });

  it('supports _t / _e / _n helpers', async () => {
    expect(await run('<?php _e("你好"); echo _t("a %s", "b"); echo _n("one", "many", 2); ?>')).toBe('你好a bmany');
  });

  it('supports try/catch/finally and throw', async () => {
    const code = `<?php try { throw new Exception("boom"); } catch (Exception $e) { echo "caught"; } finally { echo "done"; } ?>`;
    const runtime = createRuntime();
    runtime.addClass({
      kind: 'host',
      name: 'Exception',
      construct: (args: unknown[]) => ({ __phpClass: 'Exception', message: args[0] }),
      methods: { getMessage: () => '' },
    });
    const { output } = await renderPhp(runtime, code, 'test.php');
    expect(output).toBe('caughtdone');
  });
});

async function renderPhpWithSelf(
  runtime: Runtime,
  code: string,
  self: unknown,
  _out: string[]
): Promise<{ output: string }> {
  const { Interpreter } = await import('../php-compat/interpreter');
  const out: string[] = [];
  const ctx = {
    out,
    echo: (v: unknown) => out.push(String(v ?? '')),
    runtime,
    file: 'test.php',
    self,
  };
  const interpreter = new Interpreter(runtime, ctx);
  await interpreter.run(code, 'test.php');
  return { output: out.join('') };
}
