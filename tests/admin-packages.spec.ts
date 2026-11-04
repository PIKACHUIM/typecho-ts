import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { type SiteOptions } from '../src/core/options';
import { renderPluginNavBar } from '../src/core/plugins';
import { cookiePrefix, securityToken, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';
import { handleAdminPackagesRequest, extractPackage } from '../src/core/admin-packages';
import { localizeAdminHtml } from '../src/core/admin-i18n';
import { RuntimeThemeStore, makeIncludeResolver } from '../src/core/theme';
import { createRuntime, Interpreter } from '../php-compat';
import { createApp } from '../src/app';
import type { Env } from '../src/env';

const base = 'https://example.test';
const secret = 'package-secret';
const authCode = '0123456789abcdef0123456789abcdef';
const admin = { uid: 1, name: 'admin', group: 'administrator', screenName: 'Admin', password: '', mail: 'admin@example.test', authCode };
const cookie = `${cookiePrefix(base)}__typecho_uid=1; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(authCode, 'abcdef123'))}`;

function fakeServices() {
  const options = new Map<string, string>([['theme', 'default'], ['phpPluginHooks', '[]']]);
  const objects = new Map<string, Uint8Array>();
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const dbDriver = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() {
          if (sql.includes('FROM typecho_users')) return admin;
          if (sql.includes("name = 'installedThemes'")) return { value: options.get('installedThemes') ?? null };
          if (sql.includes('FROM typecho_options')) return { value: options.get(String(statement.params[0])) ?? null };
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          statements.push({ sql, params: statement.params });
          if (sql.startsWith('INSERT INTO typecho_options')) options.set(String(statement.params[0]), String(statement.params[1]));
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(batch: Array<{ sql: string; params?: unknown[] }>) {
      for (const item of batch) {
        statements.push({ sql: item.sql, params: item.params ?? [] });
        if (item.sql.startsWith('INSERT INTO typecho_options')) options.set(String(item.params?.[0] ?? ''), String(item.params?.[1] ?? ''));
      }
      return batch.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  const bucket = {
    async put(key: string, value: ArrayBuffer | ArrayBufferView, _options?: R2PutOptions) {
      const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      objects.set(key, view.slice());
      return { key };
    },
    async get(key: string) {
      const value = objects.get(key);
      if (!value) return null;
      return { size: value.length, httpEtag: 'etag', async arrayBuffer() { return value.slice().buffer; }, get body() { return new Blob([value]).stream(); } };
    },
    async list(input: { prefix: string; cursor?: string; limit?: number }) {
      const found = [...objects.keys()].filter((key) => key.startsWith(input.prefix)).slice(0, input.limit ?? 1000);
      return { objects: found.map((key) => ({ key })), truncated: false, cursor: undefined };
    },
    async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
  } as unknown as R2Bucket;
  return { db: new Db(dbDriver), d1: dbDriver, bucket, objects, options, statements };
}

function makePackagePost(form: FormData): { request: Request; context: ReturnType<typeof buildRequestContext> } {
  const referer = `${base}/admin/packages.php`;
  const token = securityToken(secret, referer, admin);
  const request = new Request(`${base}/action/packages?_=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { cookie, origin: base, referer }, body: form,
  });
  return { request, context: buildRequestContext(request) };
}

function themeZip(): Uint8Array {
  return zipSync({
    'sample-theme/index.php': strToU8('<?php /* @name Sample Theme\n * @version 1.2\n * @author Admin\n */ echo "R2 theme executed"; ?>'),
    'sample-theme/header.php': strToU8('<?php echo "header"; ?>'),
    'sample-theme/style.css': strToU8('body { color: #345; }'),
  });
}

function pluginZip(slug = 'QuickMenu'): Uint8Array {
  const source = `<?php namespace TypechoPlugin\\${slug}; class Plugin { public static function activate() { \\Typecho\\Plugin::factory('admin/menu.php')->navBar = __CLASS__ . '::render'; } public static function render() { echo '<b>Installed menu</b>'; } }`;
  return zipSync({ [`${slug}/Plugin.php`]: strToU8(`/** @name ${slug}\n * @version 1.0\n * @author Admin\n */\n${source}`) });
}

describe('runtime ZIP theme and plugin packages', () => {
  it('shows bounded package installation limits and localizes the admin UI', async () => {
    const services = fakeServices();
    const request = new Request(`${base}/admin/packages.php`, { headers: { cookie } });
    const response = await handleAdminPackagesRequest(services.db, buildRequestContext(request), secret, services.bucket, request);
    expect(response?.status).toBe(200);
    const chinese = await response!.text();
    expect(chinese).toContain('每个 ZIP 最大 1 MB');
    expect(chinese).toContain('仅安装可信来源');
    const english = localizeAdminHtml(chinese, 'en-US');
    expect(english).toContain('Install Themes & Plugins');
    expect(english).toContain('Upload and install');
    expect(english).toContain('No plugins installed from ZIP');
    expect(english).not.toMatch(/\p{Script=Han}/u);
  });
  it('preflights ZIP entries and removes one wrapping directory', () => {
    const files = extractPackage(themeZip(), 'theme');
    expect(files.map(({ path }) => path).sort()).toEqual(['header.php', 'index.php', 'style.css']);
    expect(() => extractPackage(zipSync({ '../escape.php': strToU8('<?php ?>') }), 'theme')).toThrow(/路径/);
    expect(() => extractPackage(zipSync({ 'sample/index.php': strToU8('<?php ?>'), 'sample/readme.txt': strToU8('bad') }), 'theme')).toThrow(/文件类型/);
    expect(() => extractPackage(zipSync({ 'sample/index.php': strToU8('<?php ?>'), 'sample/large.css': new Uint8Array(8 * 1024 * 1024 + 1) }), 'theme')).toThrow(/8 MB/);
    expect(() => extractPackage(zipSync({ 'QuickMenu/Plugin.php': strToU8('<?php namespace TypechoPlugin\\\\Other; class Plugin {}') }), 'plugin', 'QuickMenu')).toThrow(/标识符/);
  });

  it('installs and activates an administrator-uploaded theme in R2 without redeploying', async () => {
    const services = fakeServices();
    const form = new FormData();
    form.set('operation', 'install');
    form.set('kind', 'theme');
    form.set('slug', 'SampleTheme');
    form.set('activate', '1');
    form.set('archive', new File([themeZip()], 'theme.zip', { type: 'application/zip' }));
    const { request, context } = makePackagePost(form);
    const response = await handleAdminPackagesRequest(services.db, context, secret, services.bucket, request);

    expect(response?.status).toBe(303);
    expect(services.options.get('theme')).toBe('SampleTheme');
    const installed = JSON.parse(services.options.get('installedThemes') ?? '[]') as Array<{ slug: string; prefix: string; name: string; version: string; author: string }>;
    expect(installed).toMatchObject([{ slug: 'SampleTheme', name: 'Sample Theme' }]);
    expect(services.objects.has(`${installed[0].prefix}/php/index.php`)).toBe(true);
    expect(services.objects.has(`${installed[0].prefix}/assets/style.css`)).toBe(true);
    const store = new RuntimeThemeStore(services.bucket, installed);
    const template = await store.read('SampleTheme', 'index.php');
    expect(template).toContain('@name Sample Theme');
    expect(await store.read('SampleTheme', '../default/index.php')).toBeNull();
    const output: string[] = [];
    const echo = (value: unknown) => output.push(String(value));
    const runtime = createRuntime({ readFile: makeIncludeResolver(store, 'SampleTheme'), echo, maxOperations: 1000 });
    await new Interpreter(runtime, { out: output, echo, runtime, file: 'SampleTheme/index.php' }).run(template!, 'SampleTheme/index.php');
    expect(output.join('')).toContain('R2 theme executed');
    const app = createApp();
    const env = { DB: services.d1, BUCKET: services.bucket, ASSETS: { fetch: async () => new Response('static fallback') } } as unknown as Env;
    const assetResponse = await app.fetch(new Request(`${base}/usr/themes/SampleTheme/style.css`), env);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await assetResponse.text()).toContain('color: #345');

    const removeForm = new FormData();
    removeForm.set('operation', 'remove');
    removeForm.set('kind', 'theme');
    removeForm.set('slug', 'SampleTheme');
    const removeRequest = makePackagePost(removeForm);
    const removed = await handleAdminPackagesRequest(services.db, removeRequest.context, secret, services.bucket, removeRequest.request);
    expect(removed?.status).toBe(303);
    expect(services.options.get('theme')).toBe('default');
    expect(JSON.parse(services.options.get('installedThemes') ?? '[]')).toEqual([]);
    expect(services.objects.size).toBe(0);
  });

  it('installs, enables, and immediately runs a bounded PHP admin-menu plugin', async () => {
    const services = fakeServices();
    const form = new FormData();
    form.set('operation', 'install');
    form.set('kind', 'plugin');
    form.set('slug', 'QuickMenu');
    form.set('activate', '1');
    form.set('archive', new File([pluginZip()], 'plugin.zip', { type: 'application/zip' }));
    const { request, context } = makePackagePost(form);
    const response = await handleAdminPackagesRequest(services.db, context, secret, services.bucket, request);

    expect(response?.status).toBe(303);
    expect(JSON.parse(services.options.get('phpPluginHooks') ?? '[]')).toContain('QuickMenu');
    const installed = JSON.parse(services.options.get('installedPlugins') ?? '[]') as Array<{ slug: string; prefix: string }>;
    const options = {
      get(name: string) {
        if (name === 'phpPluginHooks') return ['QuickMenu'];
        if (name === 'installedPlugins') return installed;
        return null;
      },
      pluginConfig() { return { get() { return null; } }; },
    } as unknown as SiteOptions;
    expect(await renderPluginNavBar(options, services.bucket)).toContain('<b>Installed menu</b>');
  });

  it('rejects non-admin access and invalid CSRF without writing archive data', async () => {
    const services = fakeServices();
    const form = new FormData();
    form.set('operation', 'install'); form.set('kind', 'theme'); form.set('slug', 'Nope');
    form.set('archive', new File([themeZip()], 'theme.zip'));
    const raw = new Request(`${base}/action/packages?_=invalid`, { method: 'POST', headers: { cookie, referer: `${base}/admin/packages.php`, origin: base }, body: form });
    const response = await handleAdminPackagesRequest(services.db, buildRequestContext(raw), secret, services.bucket, raw);
    expect(response?.status).toBe(403);
    expect(services.objects.size).toBe(0);
  });
});
