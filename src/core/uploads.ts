import { escapeHtml } from './common';
import { findCurrentUser, securityToken, type AuthUser } from './auth';
import type { Db } from './db';
import type { RequestContext } from './request';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
};
const STORED_PATH = /^\/usr\/uploads\/\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|jpeg|png|gif|webp)$/;

interface AttachmentData {
  name: string;
  path: string;
  size: number;
  type: string;
  mime: string;
}
interface AttachmentRow {
  cid: number;
  title: string;
  text: string;
  authorId: number;
  parent: number;
  created: number;
}

/** Handles admin media listing and the Typecho upload/attachment-delete actions. */
export async function handleUploadRequest(
  db: Db, request: RequestContext, secret: string, bucket: R2Bucket, rawRequest: Request
): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  if (path !== '/admin/manage-medias.php' && path !== '/action/upload' && path !== '/action/contents-attachment-edit') return null;

  const user = await findCurrentUser(db, request);
  if (!user) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(request.url.toString())}`);
  if (user.group !== 'administrator') return textResponse('Forbidden', 403);

  if (path === '/admin/manage-medias.php') {
    if (request.method !== 'GET') return textResponse('Method Not Allowed', 405);
    const pageInput = request.query.get('page') ?? '1';
    if (!/^[1-9]\d{0,5}$/.test(pageInput)) return textResponse('Invalid page', 400);
    const page = Number(pageInput);
    const rows = await db.all<AttachmentRow>(
      "SELECT cid, title, text, authorId, parent, created FROM table.contents WHERE type = 'attachment' ORDER BY created DESC, cid DESC LIMIT 51 OFFSET ?",
      [(page - 1) * 50]
    );
    return htmlResponse(mediaPage(request, user, secret, rows, page));
  }

  if (request.method !== 'POST') return textResponse('Method Not Allowed', 405);
  const contentType = request.headers.get('content-type') ?? '';
  if (path === '/action/upload' && !/^multipart\/form-data\s*;/i.test(contentType)) return textResponse('Expected multipart form data', 415);
  if (path !== '/action/upload' && !/^application\/x-www-form-urlencoded\s*(?:;|$)|^multipart\/form-data\s*;/i.test(contentType)) {
    return textResponse('Expected form data', 415);
  }
  const maxBody = path === '/action/upload' ? MAX_REQUEST_BYTES : 8 * 1024;
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBody)) return textResponse('Request too large.', 413);

  const body = await readBoundedBody(rawRequest, maxBody);
  if (!body) return textResponse('Request too large.', 413);
  let form: FormData;
  try {
    form = await new Request(request.url, { method: 'POST', headers: { 'content-type': contentType }, body }).formData();
  } catch {
    return textResponse('Invalid form data', 400);
  }
  if (!validCsrf(request, form, user, secret)) return textResponse('CSRF validation failed', 403);

  if (path === '/action/upload') {
    if (request.query.has('do')) return textResponse('Unsupported upload action', 400);
    return upload(db, request, form, user, bucket);
  }
  if (form.get('do') !== 'delete') return textResponse('Unsupported attachment action', 400);
  return deleteAttachment(db, request, form, bucket);
}

async function readBoundedBody(rawRequest: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!rawRequest.body) return new Uint8Array();
  const reader = rawRequest.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let exceeded = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (exceeded) continue;
      if (size + value.byteLength > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        continue;
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (exceeded) return null;
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function validCsrf(request: RequestContext, form: FormData, user: AuthUser, secret: string): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return false;
  let referer: URL;
  try {
    referer = new URL(request.referer);
  } catch {
    return false;
  }
  if (referer.origin !== request.url.origin) return false;
  const rootPath = new URL(request.rootUrl).pathname.replace(/\/+$/, '');
  if (rootPath && referer.pathname !== rootPath && !referer.pathname.startsWith(`${rootPath}/`)) return false;
  const supplied = request.query.get('_') ?? String(form.get('_') ?? '');
  const expected = securityToken(secret, request.referer, user);
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

async function upload(db: Db, request: RequestContext, form: FormData, user: AuthUser, bucket: R2Bucket): Promise<Response> {
  const file = form.get('file');
  if (!(file instanceof File) || !file.name) return textResponse('No file selected', 400);
  if (file.size < 1 || file.size > MAX_FILE_BYTES) return textResponse('File must be between 1 byte and 5 MB.', 413);
  const name = file.name.split(/[\\/]/).pop() ?? '';
  if (!name || new TextEncoder().encode(name).length > 150 || /[\u0000-\u001f\u007f<>"'&]/.test(name)) return textResponse('Invalid file name', 400);
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const mime = Object.hasOwn(IMAGE_TYPES, extension) ? IMAGE_TYPES[extension] : undefined;
  if (!mime) return textResponse('Only JPG, PNG, GIF and WebP images are supported.', 415);
  if (file.type && file.type !== 'application/octet-stream' && file.type !== mime) return textResponse('File type does not match its extension.', 415);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!matchesImageSignature(bytes, mime)) return textResponse('File contents do not match its extension.', 415);

  const parentInput = request.query.get('cid') ?? String(form.get('cid') ?? '0');
  if (!/^\d+$/.test(parentInput) || !Number.isSafeInteger(Number(parentInput))) return textResponse('Invalid parent ID', 400);
  const parent = Number(parentInput);
  if (parent) {
    const content = await db.first<{ cid: number }>("SELECT cid FROM table.contents WHERE cid = ? AND type IN ('post', 'page')", [parent]);
    if (!content) return textResponse('Parent content not found', 404);
  }

  const now = new Date();
  const key = `uploads/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${extension}`;
  const path = `/usr/${key}`;
  const attachment: AttachmentData = { name, path, size: bytes.length, type: extension, mime };
  try {
    const stored = await bucket.put(key, bytes, { httpMetadata: { contentType: mime } });
    if (!stored) throw new Error('R2 upload failed');
  } catch {
    try {
      await bucket.delete(key);
    } catch (error) {
      console.error('Could not clean up failed R2 upload', error);
    }
    return textResponse('Could not store uploaded file.', 500);
  }

  let cid = 0;
  try {
    const row = await db.first<{ cid: number }>(
      `INSERT INTO table.contents (title, slug, created, modified, text, "order", authorId, template, type, status, password, commentsNum, allowComment, allowPing, allowFeed, parent)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL, 'attachment', 'publish', NULL, 0, '0', '0', '1', ?) RETURNING cid`,
      [name, `upload-${crypto.randomUUID()}`, Math.floor(now.getTime() / 1000), Math.floor(now.getTime() / 1000), JSON.stringify(attachment), user.uid, parent]
    );
    cid = Number(row?.cid ?? 0);
    if (!cid) throw new Error('No inserted attachment ID');
  } catch {
    try {
      await bucket.delete(key);
    } catch (error) {
      console.error('Could not clean up failed attachment upload', error);
    }
    return textResponse('Could not save attachment metadata.', 500);
  }
  const url = `${request.rootUrl}${path}`;
  return jsonResponse([url, {
    cid, title: name, type: extension, size: bytes.length,
    bytes: `${Math.ceil(bytes.length / 1024).toLocaleString('en-US')} Kb`,
    isImage: true, url, permalink: `${request.rootUrl}/attachment/${cid}/`,
  }]);
}

function matchesImageSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mime === 'image/gif') return bytes.length >= 6 && [71, 73, 70, 56].every((value, index) => bytes[index] === value) && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97;
  return bytes.length >= 12 && [82, 73, 70, 70].every((value, index) => bytes[index] === value) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value);
}

async function deleteAttachment(db: Db, request: RequestContext, form: FormData, bucket: R2Bucket): Promise<Response> {
  const input = String(form.get('cid') ?? '');
  if (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input))) return textResponse('Invalid attachment ID', 400);
  const cid = Number(input);
  const row = await db.first<AttachmentRow>("SELECT cid, title, text, authorId, parent, created FROM table.contents WHERE cid = ? AND type = 'attachment'", [cid]);
  if (!row) return textResponse('Attachment not found', 404);
  const attachment = parseAttachment(row.text);
  if (!attachment) return textResponse('Unsupported attachment storage path', 409);
  const key = attachment.path.slice('/usr/'.length);
  let original: R2ObjectBody | null;
  let backup: ArrayBuffer | null = null;
  try {
    original = await bucket.get(key);
    if (original) backup = await original.arrayBuffer();
    await bucket.delete(key);
  } catch {
    return textResponse('Could not delete stored file.', 500);
  }
  try {
    const result = await db.run("DELETE FROM table.contents WHERE cid = ? AND type = 'attachment'", [cid]);
    if (!result.success) throw new Error('Attachment metadata deletion failed');
  } catch {
    if (backup && original) {
      try {
        await bucket.put(key, backup, { httpMetadata: original.httpMetadata });
      } catch (error) {
        console.error('Could not restore attachment after metadata deletion failure', error);
      }
    }
    return textResponse('Could not delete attachment metadata.', 500);
  }
  return redirect(`${request.rootUrl}/admin/manage-medias.php?deleted=1`);
}

function parseAttachment(raw: string): AttachmentData | null {
  try {
    const value = JSON.parse(raw) as Partial<AttachmentData>;
    if (typeof value.path !== 'string' || !STORED_PATH.test(value.path)) return null;
    if (typeof value.name !== 'string' || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_FILE_BYTES ||
        typeof value.type !== 'string' || value.mime !== IMAGE_TYPES[value.type] || !value.path.endsWith(`.${value.type}`)) return null;
    return value as AttachmentData;
  } catch {
    return null;
  }
}

function mediaPage(request: RequestContext, user: AuthUser, secret: string, rows: AttachmentRow[], page: number): string {
  const referer = `${request.url.origin}${request.url.pathname}${request.url.search}`;
  const token = securityToken(secret, referer, user);
  const uploadAction = `${request.rootUrl}/action/upload?_=${token}`;
  const deleteAction = `${request.rootUrl}/action/contents-attachment-edit?_=${token}`;
  const entries = rows.slice(0, 50).map((row) => {
    const attachment = parseAttachment(row.text);
    const url = attachment ? `${request.rootUrl}${attachment.path}` : '';
    return `<tr><td>${url ? `<a href="${escapeHtml(url)}">${escapeHtml(row.title)}</a>` : escapeHtml(row.title)}</td><td>${attachment ? escapeHtml(`${Math.ceil(attachment.size / 1024)} Kb`) : '未知'}</td><td><form method="post" action="${escapeHtml(deleteAction)}"><input type="hidden" name="do" value="delete"><input type="hidden" name="cid" value="${row.cid}"><button type="submit"${attachment ? '' : ' disabled'}>删除</button></form></td></tr>`;
  }).join('');
  const previous = page > 1 ? `<a href="${escapeHtml(request.rootUrl)}/admin/manage-medias.php?page=${page - 1}">上一页</a>` : '';
  const next = rows.length > 50 ? `<a href="${escapeHtml(request.rootUrl)}/admin/manage-medias.php?page=${page + 1}">下一页</a>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>附件管理 · Typecho</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 18px;color:#26333d}nav a{margin-right:18px;color:#257059}table{width:100%;border-collapse:collapse}th,td{padding:12px;text-align:left;border-bottom:1px solid #ddd}button{padding:7px 16px}form{margin:0}input[type=file]{max-width:100%}</style></head><body><nav><a href="${escapeHtml(request.rootUrl)}/admin/">后台</a><a href="${escapeHtml(request.rootUrl)}/admin/manage-posts.php">文章</a></nav><h1>附件管理</h1>${request.query.has('deleted') ? '<p role="status">已删除。</p>' : ''}<form method="post" enctype="multipart/form-data" action="${escapeHtml(uploadAction)}"><label>选择图片（JPG、PNG、GIF、WebP；最大 5 MB）<input type="file" name="file" accept=".jpg,.jpeg,.png,.gif,.webp" required></label><button type="submit">上传</button></form><p id="upload-message" role="alert"></p><table><thead><tr><th>文件</th><th>大小</th><th>操作</th></tr></thead><tbody>${entries || '<tr><td colspan="3">暂无附件</td></tr>'}</tbody></table><nav>${previous} ${next}</nav><script>document.querySelector('form[enctype]').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const message=document.getElementById('upload-message');message.textContent='上传中…';try{const response=await fetch(form.action,{method:'POST',body:new FormData(form),credentials:'same-origin'});if(!response.ok)throw new Error(await response.text());location.assign(location.pathname+location.search);}catch(error){message.textContent=String(error);}});</script></body></html>`;
}

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
}
function htmlResponse(html: string): Response {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
}
function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json; charset=UTF-8' } });
}
function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
