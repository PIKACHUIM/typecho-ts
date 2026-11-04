import type { InstalledThemePackage } from './theme';

export interface InstalledPluginPackage {
  slug: string;
  name: string;
  version: string;
  author: string;
  prefix: string;
}

const PACKAGE_PREFIX = /^package-archives\/(?:themes|plugins)\/[A-Za-z0-9_-]{1,64}\/[0-9a-f]{64}$/;

export function parseInstalledThemes(value: unknown): InstalledThemePackage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isInstalledTheme);
}

export function parseInstalledPlugins(value: unknown): InstalledPluginPackage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isInstalledPlugin);
}

function isInstalledTheme(value: unknown): value is InstalledThemePackage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<InstalledThemePackage>;
  return validSlug(item.slug) && validText(item.name, 100) && validText(item.version, 40) &&
    validText(item.author, 100) && typeof item.prefix === 'string' && PACKAGE_PREFIX.test(item.prefix) &&
    item.prefix.startsWith(`package-archives/themes/${item.slug}/`);
}

function isInstalledPlugin(value: unknown): value is InstalledPluginPackage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<InstalledPluginPackage>;
  return validSlug(item.slug) && validText(item.name, 100) && validText(item.version, 40) &&
    validText(item.author, 100) && typeof item.prefix === 'string' && PACKAGE_PREFIX.test(item.prefix) &&
    item.prefix.startsWith(`package-archives/plugins/${item.slug}/`);
}

export function validSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
