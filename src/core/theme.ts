import { THEME_SOURCES } from '../generated/themes';

export interface ThemeFileStore {
  read(theme: string, path: string): Promise<string | null>;
  exists(theme: string, path: string): Promise<boolean>;
  list(theme: string): Promise<string[]>;
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

export function listThemes(): string[] {
  return Object.keys(THEME_FILES);
}

export function themeMeta(theme: string): { name: string; version: string; author: string } {
  const files = THEME_FILES[theme] ?? {};
  const header = files['index.php'] ?? '';
  const read = (key: string) => header.match(new RegExp(`@${key}\\s+(.+)`))?.[1]?.trim() ?? '';
  return { name: theme, version: read('version'), author: read('author') };
}
