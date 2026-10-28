import { describe, expect, it } from 'vitest';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { handleAuthRequest } from '../src/core/install-auth';
import { loadOptionValues, SiteOptions } from '../src/core/options';
import { buildRequestContext } from '../src/core/request';
import { renderPluginNavBar } from '../src/core/plugins';
import { PLUGIN_SOURCES } from '../src/generated/plugins';

const base = 'https://example.test';
const authCode = '0123456789abcdef0123456789abcdef';
const admin = { uid: 1, name: 'admin', group: 'administrator', screenName: 'Admin', password: '', mail: 'a@example.test', authCode };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;

function options(values: Record<string, unknown> = {}) {
  return new SiteOptions({ values, request: buildRequestContext(new Request(base)), echo: () => {} });
}

function fakeDb(group = 'administrator') {
  const writes: unknown[][] = [];
  let active = '[]';
  const driver = {
    prepare(sql: string) {
      const stmt = {
        params: [] as unknown[],
        bind(...params: unknown[]) { stmt.params = params; return stmt; },
        async first() {
          if (sql.includes('FROM typecho_users')) return { ...admin, group };
          if (sql.includes("name = 'phpPluginHooks'")) return { value: active };
          return null;
        },
        async run() { writes.push(stmt.params); active = String(stmt.params[1]); return { success: true }; },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db: new Db(driver), writes, get active() { return active; } };
}

describe('bundled PHP plugin hooks', () => {
  it('is off by default, executes HelloWorld Plugin.php activation and navBar with escaped configuration', async () => {
    expect(await renderPluginNavBar(options({ 'plugin:HelloWorld': { word: 'not executed' } }))).toBe('');
    const result = await renderPluginNavBar(options({ phpPluginHooks: ['HelloWorld'], 'plugin:HelloWorld': { word: '<hello & goodbye>' } }));
    expect(result).toBe('<span class="message success">&lt;hello &amp; goodbye&gt;</span>');
    expect(await renderPluginNavBar(options({ phpPluginHooks: ['HelloWorld'] }))).toContain('Hello World');
    expect(await renderPluginNavBar(options({ phpPluginHooks: ['HelloWorld'], 'plugin:HelloWorld': { word: 'x'.repeat(5000) } }))).toBe('');
  });

  it('renders the registered navBar hook on the admin home without exposing it to non-admins', async () => {
    const request = buildRequestContext(new Request(`${base}/admin/`, { headers: { cookie } }));
    const configured = options({ phpPluginHooks: ['HelloWorld'], 'plugin:HelloWorld': { word: 'nav ok' } });
    const home = await handleAuthRequest(fakeDb().db, request, 'secret', configured);
    expect(await home?.text()).toContain('<span class="message success">nav ok</span>');
    const editorHome = await handleAuthRequest(fakeDb('editor').db, request, 'secret', configured);
    expect(await editorHome?.text()).not.toContain('nav ok');
  });

  it('never allows a theme options override to turn on plugin execution', async () => {
    const driver = { prepare: () => ({ all: async () => ({ results: [
      { name: 'theme', value: 'default' },
      { name: 'theme:default', value: JSON.stringify({ phpPluginHooks: ['HelloWorld'] }) },
    ] }) }) } as unknown as D1Database;
    const loaded = await loadOptionValues(new Db(driver));
    expect(loaded.phpPluginHooks).toBeNull();
    expect(await renderPluginNavBar(options(loaded))).toBe('');
  });

  it('never executes DB-sourced PHP or an unbundled plugin', async () => {
    const result = await renderPluginNavBar(options({ phpPluginHooks: ['Unknown', 'HelloWorld'], 'plugin:HelloWorld': { word: 'ok' }, 'plugin:Unknown': '<?php echo "bad";' }));
    expect(result).toBe('<span class="message success">ok</span>');
  });

  it('isolates failed hooks, invalid callbacks, output overflow and instruction overflow', async () => {
    const original = PLUGIN_SOURCES.HelloWorld['Plugin.php'];
    const code = (activation: string, render: string) => `<?php namespace TypechoPlugin\\HelloWorld; class Plugin { public static function activate() { ${activation} } public static function render() { ${render} } }`;
    try {
      for (const source of [
        code("\\Typecho\\Plugin::factory('admin/menu.php')->navBar = __CLASS__ . '::render';", `echo '${'x'.repeat(5000)}';`),
        code("\\Typecho\\Plugin::factory('admin/menu.php')->navBar = __CLASS__ . '::render';", 'while (true) {}'),
        code("\\Typecho\\Plugin::factory('admin/menu.php')->navBar = 'Other::render';", 'echo "bad";'),
        code("\\Typecho\\Plugin::factory('admin/menu.php')->navBar = __CLASS__ . '::render';", 'echo "partial"; unknown_function();'),
        code("include 'dynamic.php'; \\Typecho\\Plugin::factory('admin/menu.php')->navBar = __CLASS__ . '::render';", 'echo "bad";'),
      ]) {
        PLUGIN_SOURCES.HelloWorld['Plugin.php'] = source;
        expect(await renderPluginNavBar(options({ phpPluginHooks: ['HelloWorld'] }))).toBe('');
      }
    } finally {
      PLUGIN_SOURCES.HelloWorld['Plugin.php'] = original;
    }
  });

  it('restricts activation to the supported hook factory', async () => {
    const original = PLUGIN_SOURCES.HelloWorld['Plugin.php'];
    try {
      PLUGIN_SOURCES.HelloWorld['Plugin.php'] = `<?php namespace TypechoPlugin\\HelloWorld; class Plugin { public static function activate() { \\Typecho\\Plugin::factory('front')->navBar = __CLASS__ . '::render'; } public static function render() { echo 'bad'; } }`;
      expect(await renderPluginNavBar(options({ phpPluginHooks: ['HelloWorld'] }))).toBe('');
    } finally {
      PLUGIN_SOURCES.HelloWorld['Plugin.php'] = original;
    }
  });

  it('allows only an authenticated administrator with a valid CSRF token to toggle', async () => {
    const store = fakeDb();
    const referer = `${base}/admin/plugins.php`;
    const get = buildRequestContext(new Request(referer, { headers: { cookie } }));
    const page = await handleAuthRequest(store.db, get, 'secret', options());
    expect(await page?.text()).toContain('HelloWorld：已关闭');
    const post = (token: string, plugin = 'HelloWorld', enabled = '1') => {
      const form = new FormData();
      form.set('plugin', plugin); form.set('enabled', enabled);
      return buildRequestContext(new Request(`${base}/action/plugins?_=${token}`, { method: 'POST', headers: { cookie, referer, origin: base }, body: form }));
    };
    expect((await handleAuthRequest(store.db, post('invalid'), 'secret', options()))?.status).toBe(403);
    const token = securityToken('secret', referer, admin);
    expect((await handleAuthRequest(store.db, post(token, 'NotBundled'), 'secret', options()))?.status).toBe(400);
    expect((await handleAuthRequest(store.db, post(token), 'secret', options()))?.status).toBe(303);
    expect(store.active).toBe('["HelloWorld"]');
    expect((await handleAuthRequest(store.db, post(token, 'HelloWorld', '0'), 'secret', options()))?.status).toBe(303);
    expect(store.active).toBe('[]');
    expect((await handleAuthRequest(fakeDb('editor').db, post(token), 'secret', options()))?.status).toBe(403);
    expect(store.writes).toHaveLength(2);
  });
});
