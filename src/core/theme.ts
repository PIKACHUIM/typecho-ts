import { THEME_SOURCES } from '../generated/themes';

export interface ThemeFileStore {
  read(theme: string, path: string): Promise<string | null>;
  exists(theme: string, path: string): Promise<boolean>;
  list(theme: string): Promise<string[]>;
}

export interface InstalledThemePackage {
  slug: string;
  name: string;
  version: string;
  author: string;
  prefix: string;
}

/** Theme templates bundled at build time (see scripts/gen-themes.mjs). */
export class BundledThemeStore implements ThemeFileStore {
  async read(theme: string, path: string): Promise<string | null> {
    const files = THEME_SOURCES[theme];
    if (!files) return null;
    return files[normalize(path)] ?? null;
  }

  async exists(theme: string, path: string): Promise<boolean> {
    return (await this.read(theme, path)) !== null;
  }

  async list(theme: string): Promise<string[]> {
    return Object.keys(THEME_SOURCES[theme] ?? {});
  }
}

export class RuntimeThemeStore implements ThemeFileStore {
  private readonly bundled = new BundledThemeStore();
  private readonly packages: Map<string, InstalledThemePackage>;

  constructor(private readonly bucket: R2Bucket, private readonly installed: InstalledThemePackage[]) {
    this.packages = new Map(installed.map((item) => [item.slug, item]));
  }

  async read(theme: string, path: string): Promise<string | null> {
    const normalized = normalize(path);
    const bundled = await this.bundled.read(theme, normalized);
    if (bundled !== null) return bundled;
    const pkg = this.packages.get(theme);
    if (!pkg || !/^[a-zA-Z0-9_-]{1,64}$/.test(pkg.slug) || !/^package-archives\/themes\/[a-zA-Z0-9_-]{1,64}\/[0-9a-f]{64}$/.test(pkg.prefix)) return null;
    if (!normalized || normalized.includes('\\') || normalized.split('/').some((part) => part === '..')) return null;
    const object = await this.bucket.get(`${pkg.prefix}/php/${normalized}`);
    if (!object || object.size > 1024 * 1024) return null;
    return new TextDecoder().decode(await object.arrayBuffer());
  }

  async exists(theme: string, path: string): Promise<boolean> {
    return (await this.read(theme, path)) !== null;
  }

  async list(theme: string): Promise<string[]> {
    const bundled = await this.bundled.list(theme);
    const pkg = this.packages.get(theme);
    if (!pkg || !/^package-archives\/themes\/[a-zA-Z0-9_-]{1,64}\/[0-9a-f]{64}$/.test(pkg.prefix)) return bundled;
    const listed = await this.bucket.list({ prefix: `${pkg.prefix}/php/`, limit: 200 });
    const dynamic = listed.objects.map(({ key }) => key.slice(`${pkg.prefix}/php/`.length));
    return [...new Set([...bundled, ...dynamic])];
  }
}

export function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/**
 * Builds the `include` resolver used by the PHP runtime. Includes are resolved
 * relative to the including template, matching PHP's include path semantics.
 */
export function makeIncludeResolver(store: ThemeFileStore, theme: string) {
  return async (path: string, from: string): Promise<{ code: string; path: string } | null> => {
    const candidates = path.startsWith('/')
      ? [normalize(path)]
      : [normalize(`${dirname(from)}/${path}`), normalize(path)];
    for (const candidate of candidates) {
      const code = await store.read(theme, candidate);
      if (code !== null) return { code, path: `${theme}/${candidate}` };
    }
    return null;
  };
}

const THEME_FILES = THEME_SOURCES;

export function listThemes(installed: InstalledThemePackage[] = []): string[] {
  return [...new Set([...Object.keys(THEME_FILES), ...installed.map(({ slug }) => slug)])];
}

export function themeMeta(theme: string, installed: InstalledThemePackage[] = []): { name: string; version: string; author: string } {
  const dynamic = installed.find((item) => item.slug === theme);
  if (dynamic) return { name: dynamic.name || theme, version: dynamic.version || '', author: dynamic.author || '' };
  const files = THEME_FILES[theme] ?? {};
  const header = files['index.php'] ?? '';
  const read = (key: string) => header.match(new RegExp(`@${key}\\s+(.+)`))?.[1]?.trim() ?? '';
  return { name: read('name') || theme, version: read('version'), author: read('author') };
}
