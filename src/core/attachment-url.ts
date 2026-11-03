const STORED_ATTACHMENT_PATH = /^\/usr\/uploads\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|jpeg|png|gif|webp)$/;

export function normalizeAttachmentUrlPrefix(value: string): string | null {
  if (!value) return '';
  if (/^[\u0000-\u0020]|[\u0000-\u0020]$/.test(value) || value.includes('\\')) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (!/^https:\/\//i.test(value) || parsed.pathname.includes('//') || /%(?:2f|5c)/i.test(parsed.pathname)) return null;
  if (parsed.pathname.split('/').some((part) => part === '.' || part === '..')) return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function attachmentPublicUrl(rootUrl: string, storedPath: string, prefix: string): string {
  if (!STORED_ATTACHMENT_PATH.test(storedPath)) return '';
  const safePrefix = normalizeAttachmentUrlPrefix(prefix);
  if (safePrefix === null) return `${rootUrl}${storedPath}`;
  if (!safePrefix) return `${rootUrl}${storedPath}`;
  return `${safePrefix}/${storedPath.slice('/usr/'.length)}`;
}
