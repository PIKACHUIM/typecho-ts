import { unzipSync } from 'fflate';
import { parsePhp } from '../../php-compat';
import { escapeHtml } from './common';
import { findCurrentUser, securityToken, type AuthUser } from './auth';
import type { Db } from './db';
import { renderAdminShell } from './admin-ui';
import { bundledPluginNames } from './plugins';
import { currentRequestUrl, type RequestContext } from './request';
import { parseInstalledPlugins, parseInstalledThemes, validSlug, type InstalledPluginPackage } from './package-registry';
import { listThemes, type InstalledThemePackage } from './theme';

const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_ARCHIVE_BYTES + 96 * 1024;
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_FILES = 100;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const THEME_EXTENSIONS = new Set(['.php', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.woff', '.woff2', '.ttf', '.otf']);

interface ZipEntry {
  path: string;
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
}

interface PackageFile {
  path: string;
  bytes: Uint8Array;
}

export async function handleAdminPackagesRequest(
  db: Db, request: RequestContext, secret: string, bucket: R2Bucket, rawRequest: Request
): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  if (path !== '/admin/packages.php' && path !== '/action/packages') return null;
  const user = await findCurrentUser(db, request);
  if (!user) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}`);
  if (user.group !== 'administrator') return text('Forbidden', 403);

  if (path === '/admin/packages.php') {
    if (request.method !== 'GET') return text('Method Not Allowed', 405);
    const [themeValue, pluginValue, enabledValue, activeThemeValue] = await Promise.all([
      option(db, 'installedThemes'), option(db, 'installedPlugins'), option(db, 'phpPluginHooks'), option(db, 'theme'),
    ]);
    const themes = parseInstalledThemes(themeValue);
    const plugins = parseInstalledPlugins(pluginValue);
    const enabled = Array.isArray(enabledValue) ? enabledValue.filter((value): value is string => typeof value === 'string') : [];
    const activeTheme = String(activeThemeValue ?? 'default');
    const referer = currentRequestUrl(request);
    const action = `${request.rootUrl}/action/packages?_=${encodeURIComponent(securityToken(secret, referer, user))}`;
    const themeRows = themes.map((pkg) => `<tr><td><span data-i18n-skip>${escapeHtml(pkg.name)}</span></td><td><span data-i18n-skip>${escapeHtml(pkg.slug)}</span></td><td><span data-i18n-skip>${escapeHtml(pkg.version || '—')}</span></td><td><span data-i18n-skip>${escapeHtml(pkg.author || '—')}</span></td><td>${enabledTheme(pkg.slug, activeTheme)}</td><td><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="operation" value="remove"><input type="hidden" name="kind" value="theme"><input type="hidden" name="slug" value="${escapeHtml(pkg.slug)}"><button class="danger" type="submit">卸载</button></form></td></tr>`).join('');
    const pluginRows = plugins.map((pkg) => `<tr><td><span data-i18n-skip>${escapeHtml(pkg.name)}</span></td><td><span data-i18n-skip>${escapeHtml(pkg.slug)}</span></td><td><span data-i18n-skip>${escapeHtml(pkg.version || '—')}</span></td><td><span data-i18n-skip>${escapeHtml(pkg.author || '—')}</span></td><td>${enabled.includes(pkg.slug) ? '已启用' : '已关闭'}</td><td><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="operation" value="toggle"><input type="hidden" name="kind" value="plugin"><input type="hidden" name="slug" value="${escapeHtml(pkg.slug)}"><input type="hidden" name="enabled" value="${enabled.includes(pkg.slug) ? '0' : '1'}"><button type="submit">${enabled.includes(pkg.slug) ? '关闭' : '启用'}</button></form><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="operation" value="remove"><input type="hidden" name="kind" value="plugin"><input type="hidden" name="slug" value="${escapeHtml(pkg.slug)}"><button class="danger" type="submit">卸载</button></form></td></tr>`).join('');
    const message = request.query.has('installed') ? '<p role="status">ZIP 已安装。</p>' : request.query.has('removed') ? '<p role="status">扩展已卸载。</p>' : '';
    const body = `<h1>主题与插件安装</h1>${message}<section class="help"><h2>安全说明</h2><p>上传即代表信任该 ZIP 中的 PHP 代码。主题在前台 Worker 中以受限 PHP 解释器运行；插件仅支持后台菜单 Hook、输出与指令预算。此功能不会重新部署 Worker，也不等于兼容任意 Typecho 扩展。仅安装可信来源的文件。</p><p>每个 ZIP 最大 1 MB，解压后最多 8 MB、100 个文件；拒绝路径穿越、链接、加密档案和不支持的格式。安装会保存新版本，不覆盖已安装的同名扩展。</p></section><form method="post" enctype="multipart/form-data" action="${escapeHtml(action)}" class="package-install-form"><input type="hidden" name="operation" value="install"><label>扩展类型<select name="kind"><option value="theme">主题</option><option value="plugin">插件</option></select></label><label>标识符（英文和数字）<input name="slug" pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" maxlength="64" required></label><label>ZIP 文件<input type="file" name="archive" accept=".zip,application/zip" required></label><label class="check"><input type="checkbox" name="activate" value="1" checked>安装后立即启用（主题切换前台；插件运行受限菜单 Hook）</label><button type="submit">上传并安装</button></form><section><h2>已安装主题</h2><table><thead><tr><th>名称</th><th>标识符</th><th>版本</th><th>作者</th><th>使用状态</th><th>操作</th></tr></thead><tbody>${themeRows || '<tr><td colspan="6">暂无在线安装的主题</td></tr>'}</tbody></table></section><section><h2>已安装插件</h2><table><thead><tr><th>名称</th><th>标识符</th><th>版本</th><th>作者</th><th>状态</th><th>操作</th></tr></thead><tbody>${pluginRows || '<tr><td colspan="6">暂无在线安装的插件</td></tr>'}</tbody></table></section>`;
    return html(renderAdminShell('主题与插件安装', request, body));
  }

  if (request.method !== 'POST') return text('Method Not Allowed', 405);
  if (!validRequest(request, secret, user)) return text('CSRF validation failed', 403);
  const contentType = request.headers.get('content-type') ?? '';
  const isInstall = request.query.has('_') && request.url.searchParams.has('_') && /^multipart\/form-data\s*;/i.test(contentType);
  let form: FormData | null;
  if (isInstall) {
    const body = await readBoundedBody(rawRequest, MAX_REQUEST_BYTES);
    if (!body) return text('ZIP 上传请求过大。', 413);
    try {
      form = await new Request(request.url, { method: 'POST', headers: { 'content-type': contentType }, body }).formData();
    } catch {
      return text('无效的 ZIP 上传表单。', 400);
    }
  } else {
    form = await request.body?.() ?? null;
  }
  if (!form) return text('无效的安装请求。', 400);

  const operation = String(form.get('operation') ?? 'install');
  const rawKind = String(form.get('kind') ?? '');
  const slug = String(form.get('slug') ?? '');
  if ((rawKind !== 'theme' && rawKind !== 'plugin') || !validSlug(slug)) return text('扩展类型或标识符无效。', 400);
  const kind: 'theme' | 'plugin' = rawKind;
  if (operation === 'install') {
    const upload = form.get('archive');
    if (!(upload instanceof File) || upload.size < 22 || upload.size > MAX_ARCHIVE_BYTES) return text('ZIP 文件必须为 22 字节至 1 MB。', 413);
    const zipBytes = new Uint8Array(await upload.arrayBuffer());
    let files: PackageFile[];
    try {
      files = extractPackage(zipBytes, kind, slug);
    } catch (error) {
      return text(error instanceof Error ? error.message : 'ZIP 校验失败。', 400);
    }
    const [installedThemes, installedPlugins] = await Promise.all([option(db, 'installedThemes'), option(db, 'installedPlugins')]);
    const themes = parseInstalledThemes(installedThemes);
    const plugins = parseInstalledPlugins(installedPlugins);
    if (kind === 'theme' && (themes.some((pkg) => pkg.slug.toLowerCase() === slug.toLowerCase()) || staticThemeExists(slug))) return text('主题标识符已存在。', 409);
    if (kind === 'plugin' && (plugins.some((pkg) => pkg.slug.toLowerCase() === slug.toLowerCase()) || bundledPluginNames().some((name) => name.toLowerCase() === slug.toLowerCase()))) return text('插件标识符已存在。', 409);

    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', zipBytes));
    const version = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const prefix = `package-archives/${kind === 'theme' ? 'themes' : 'plugins'}/${slug}/${version}`;
    const sourceIndex = files.find(({ path }) => kind === 'theme' ? path === 'index.php' : path === 'Plugin.php');
    if (!sourceIndex) return text(kind === 'theme' ? '主题 ZIP 缺少 index.php。' : '插件 ZIP 缺少 Plugin.php。', 400);
    let meta: PackageMetadata;
    try { meta = readMetadata(sourceIndex.bytes, kind, slug); } catch { return text('PHP 入口文件无法解析或扩展标识符不匹配。', 400); }
    const writes: string[] = [];
    try {
      for (const file of files) {
        const isPhp = file.path.toLowerCase().endsWith('.php');
        const key = `${prefix}/${isPhp ? 'php' : 'assets'}/${file.path}`;
        await bucket.put(key, file.bytes, { httpMetadata: { contentType: contentTypeFor(file.path) } });
        writes.push(key);
      }
      if (kind === 'theme') {
        const pkg: InstalledThemePackage = { slug, ...meta, prefix };
        await db.batch([
          optionWrite('installedThemes', JSON.stringify([...themes, pkg])),
          ...(form.get('activate') === '1' ? [optionWrite('theme', slug)] : []),
        ]);
      } else {
        const pkg: InstalledPluginPackage = { slug, ...meta, prefix };
        const [enabledValue] = await Promise.all([option(db, 'phpPluginHooks')]);
        const enabled = Array.isArray(enabledValue) ? enabledValue.filter((item): item is string => typeof item === 'string') : [];
        await db.batch([
          optionWrite('installedPlugins', JSON.stringify([...plugins, pkg])),
          ...(form.get('activate') === '1' ? [optionWrite('phpPluginHooks', JSON.stringify([...new Set([...enabled, slug])]))] : []),
        ]);
      }
    } catch (error) {
      await deleteKeys(bucket, writes);
      console.error('Package installation failed', error);
      return text('无法保存 ZIP 扩展，请检查 R2 绑定后重试。', 500);
    }
    return redirect(`${request.rootUrl}/admin/packages.php?installed=1`);
  }

  if (operation === 'toggle' && kind === 'plugin') {
    const plugins = parseInstalledPlugins(await option(db, 'installedPlugins'));
    if (!plugins.some((pkg) => pkg.slug === slug)) return text('找不到在线安装的插件。', 404);
    const currentValue = await option(db, 'phpPluginHooks');
    const current = Array.isArray(currentValue) ? currentValue.filter((item): item is string => typeof item === 'string') : [];
    const enabling = form.get('enabled') === '1';
    const next = enabling ? [...new Set([...current, slug])] : current.filter((item) => item !== slug);
    await setOption(db, 'phpPluginHooks', JSON.stringify(next));
    return redirect(`${request.rootUrl}/admin/packages.php`);
  }

  if (operation === 'remove') {
    if (kind === 'theme') {
      const packages = parseInstalledThemes(await option(db, 'installedThemes'));
      const pkg = packages.find((item) => item.slug === slug);
      if (!pkg) return text('找不到在线安装的主题。', 404);
      const currentTheme = await option(db, 'theme');
      const statements = [optionWrite('installedThemes', JSON.stringify(packages.filter((item) => item.slug !== slug)))];
      if (currentTheme === slug) statements.push(optionWrite('theme', 'default'));
      await db.batch(statements);
      await deletePrefix(bucket, pkg.prefix);
    } else {
      const packages = parseInstalledPlugins(await option(db, 'installedPlugins'));
      const pkg = packages.find((item) => item.slug === slug);
      if (!pkg) return text('找不到在线安装的插件。', 404);
      const enabledValue = await option(db, 'phpPluginHooks');
      const enabled = Array.isArray(enabledValue) ? enabledValue.filter((item): item is string => typeof item === 'string' && item !== slug) : [];
      await db.batch([
        optionWrite('installedPlugins', JSON.stringify(packages.filter((item) => item.slug !== slug))),
        optionWrite('phpPluginHooks', JSON.stringify(enabled)),
      ]);
      await deletePrefix(bucket, pkg.prefix);
    }
    return redirect(`${request.rootUrl}/admin/packages.php?removed=1`);
  }
  return text('不支持的扩展操作。', 400);
}

export async function option(db: Db, name: string): Promise<unknown> {
  const row = await db.first<{ value: string | null }>('SELECT value FROM table.options WHERE name = ? AND user = 0', [name]);
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

async function setOption(db: Db, name: string, value: string): Promise<void> {
  await db.run('INSERT INTO table.options (name, "user", value) VALUES (?, 0, ?) ON CONFLICT(name, "user") DO UPDATE SET value = excluded.value', [name, value]);
}

function optionWrite(name: string, value: string): { sql: string; params: unknown[] } {
  return { sql: 'INSERT INTO table.options (name, "user", value) VALUES (?, 0, ?) ON CONFLICT(name, "user") DO UPDATE SET value = excluded.value', params: [name, value] };
}

function validRequest(request: RequestContext, secret: string, user: AuthUser): boolean {
  if (request.headers.get('origin') && request.headers.get('origin') !== request.url.origin) return false;
  let referer: URL;
  try { referer = new URL(request.referer); } catch { return false; }
  const expectedPath = `${new URL(request.rootUrl).pathname.replace(/\/$/, '')}/admin/packages.php`;
  if (referer.origin !== request.url.origin || referer.pathname !== expectedPath) return false;
  const actual = request.query.get('_') ?? '';
  const expected = securityToken(secret, request.referer, user);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return null;
  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } catch { return null; }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export function inspectZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length < 22 || bytes.length > MAX_ARCHIVE_BYTES) throw new Error('ZIP 文件无效或超过 1 MB。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read16 = (offset: number) => view.getUint16(offset, true);
  const read32 = (offset: number) => view.getUint32(offset, true);
  const minEnd = Math.max(0, bytes.length - 65557);
  let end = -1;
  for (let cursor = bytes.length - 22; cursor >= minEnd; cursor--) {
    if (read32(cursor) === 0x06054b50) { end = cursor; break; }
  }
  if (end < 0 || read16(end + 4) !== 0 || read16(end + 6) !== 0 || read16(end + 8) !== read16(end + 10)) throw new Error('不支持多卷或损坏的 ZIP 文件。');
  const count = read16(end + 10);
  const directorySize = read32(end + 12);
  const directoryOffset = read32(end + 16);
  if (!count || count > MAX_PACKAGE_FILES || count === 0xffff || directoryOffset + directorySize > end) throw new Error('ZIP 文件条目数或中央目录无效。');
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let cursor = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || read32(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录损坏。');
    const madeBy = bytes[cursor + 5];
    const flags = read16(cursor + 8);
    const method = read16(cursor + 10);
    const compressedSize = read32(cursor + 20);
    const uncompressedSize = read32(cursor + 24);
    const nameLength = read16(cursor + 28);
    const extraLength = read16(cursor + 30);
    const commentLength = read16(cursor + 32);
    const disk = read16(cursor + 34);
    const externalAttributes = read32(cursor + 38);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || recordEnd > end || disk !== 0 || flags & 1 || ![0, 8].includes(method)) throw new Error('ZIP 包含加密、跨卷或不支持压缩的条目。');
    if (madeBy === 3) {
      const fileType = (externalAttributes >>> 16) & 0xf000;
      if (fileType === 0xa000) throw new Error('ZIP 不得包含符号链接。');
    }
    let name: string;
    try { name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); } catch { throw new Error('ZIP 路径必须使用有效 UTF-8。'); }
    if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\0')) throw new Error('ZIP 路径无效。');
    const directory = name.endsWith('/');
    const path = directory ? name.slice(0, -1) : name;
    const parts = path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 120)) throw new Error('ZIP 路径包含不安全片段。');
    if (!directory) {
      if (seen.has(path.toLowerCase())) throw new Error('ZIP 包含重复文件路径。');
      seen.add(path.toLowerCase());
      total += uncompressedSize;
      if (uncompressedSize > MAX_UNPACKED_BYTES || total > MAX_UNPACKED_BYTES) throw new Error('ZIP 解压后超过 8 MB 限制。');
    }
    entries.push({ path, directory, compressedSize, uncompressedSize });
    cursor = recordEnd;
  }
  if (cursor !== directoryOffset + directorySize || !entries.some((entry) => !entry.directory)) throw new Error('ZIP 中央目录长度不匹配或为空。');
  return entries;
}

export function extractPackage(bytes: Uint8Array, kind: 'theme' | 'plugin', packageSlug?: string): PackageFile[] {
  const entries = inspectZip(bytes).filter((entry) => !entry.directory);
  const unpacked = unzipSync(bytes);
  const paths = Object.keys(unpacked);
  if (paths.length !== entries.length) throw new Error('ZIP 文件条目数量不匹配。');
  let files = entries.map(({ path, uncompressedSize }) => {
    const content = unpacked[path];
    if (!content || content.byteLength !== uncompressedSize) throw new Error('ZIP 文件尺寸校验失败。');
    return { path, bytes: content };
  });
  const firstParts = files.map(({ path }) => path.split('/')[0]);
  if (firstParts.length && firstParts.every((part) => part === firstParts[0]) && files.every(({ path }) => path.includes('/'))) {
    const root = `${firstParts[0]}/`;
    files = files.map(({ path, bytes: content }) => ({ path: path.slice(root.length), bytes: content }));
  }
  if (files.some(({ path }) => !path || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.'))) throw new Error('ZIP 根目录结构无效。');
  const allowed = kind === 'theme' ? THEME_EXTENSIONS : new Set(['.php']);
  for (const { path, bytes: content } of files) {
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!allowed.has(extension)) throw new Error(`ZIP 文件类型不支持：${extension || '(none)'}`);
    if (extension === '.php' && content.byteLength > 1024 * 1024) throw new Error('单个 PHP 文件不能超过 1 MB。');
    if (kind === 'plugin' && path !== 'Plugin.php') throw new Error('受限插件 ZIP 当前只允许单个根目录 Plugin.php 文件。');
    if (extension === '.php') {
      const source = decoder.decode(files.find((file) => file.path === path)!.bytes);
      parsePhp(source, path);
    }
  }
  if (kind === 'theme' && !files.some(({ path }) => path === 'index.php')) throw new Error('主题 ZIP 根目录必须包含 index.php。');
  if (kind === 'plugin' && files.length !== 1) throw new Error('插件 ZIP 当前只允许 Plugin.php。');
  if (kind === 'plugin' && packageSlug) readMetadata(files[0].bytes, 'plugin', packageSlug);
  return files;
}

interface PackageMetadata { name: string; version: string; author: string; }

function readMetadata(bytes: Uint8Array, kind: 'theme' | 'plugin', slug: string): PackageMetadata {
  const source = decoder.decode(bytes);
  if (kind === 'plugin' && !new RegExp(`namespace\\s+TypechoPlugin\\\\${escapeRegex(slug)}\\s*;`).test(source)) {
    throw new Error('插件命名空间必须与标识符一致。');
  }
  const read = (key: string, fallback: string) => source.match(new RegExp(`@${key}\\s+([^\\r\\n*]+)`))?.[1]?.trim().slice(0, 100) || fallback;
  return { name: read('name', slug), version: read('version', '0.1.0'), author: read('author', '') };
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function staticThemeExists(slug: string): boolean {
  return listThemes().some((name) => name.toLowerCase() === slug.toLowerCase());
}

function enabledTheme(slug: string, current: string): string {
  return current === slug ? '当前启用' : '已安装';
}

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  const types: Record<string, string> = {
    '.php': 'application/x-httpd-php', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  };
  return types[extension] ?? 'application/octet-stream';
}

async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  if (!keys.length) return;
  try { await bucket.delete(keys); } catch (error) { console.error('Could not roll back package files', error); }
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${prefix}/`, cursor, limit: 500 });
    if (page.objects.length) await bucket.delete(page.objects.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

function html(value: string): Response { return new Response(value, { headers: { 'content-type': 'text/html; charset=UTF-8' } }); }
function text(value: string, status: number): Response { return new Response(value, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } }); }
function redirect(location: string): Response { return new Response(null, { status: 303, headers: { location } }); }
