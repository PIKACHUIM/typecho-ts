import { findCurrentUser } from './auth';
import { escapeHtml } from './common';
import type { Db } from './db';
import type { SiteOptions } from './options';
import { pathInfoFromUrl, type RequestContext } from './request';
import type { ContentRow } from '../repo/content';

const MAX_COMMENT_BYTES = 64 * 1024;
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function enabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function text(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
}

function field(form: FormData, name: string): string | null {
  const values = form.getAll(name);
  if (values.length > 1 || (values.length === 1 && typeof values[0] !== 'string')) return null;
  return values.length === 0 ? '' : values[0] as string;
}

/** Handles theme comment forms (which identify their post through the Referer, not a hidden cid). */
export async function handleCommentRequest(db: Db, request: RequestContext, options: SiteOptions): Promise<Response | null> {
  const feedbackPath = request.pathInfo.replace(/\/+$/, '');
  const feedbackRoute = options.router.match(request.pathInfo);
  const routedComment = feedbackRoute?.route.name === 'feedback' && feedbackRoute.params?.type === 'comment';
  if (feedbackPath !== '/action/feedback' && !routedComment) return null;
  if (request.method.toUpperCase() !== 'POST') return text('Method Not Allowed', 405);

  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return text('Invalid request origin', 403);
  let referer: URL;
  try {
    referer = new URL(request.referer);
    if (referer.origin !== request.url.origin) return text('Invalid request origin', 403);
  } catch {
    return text('Missing or invalid Referer', 403);
  }
  const refererPath = pathInfoFromUrl(referer);
  const commentPage = options.router.match(refererPath);
  const parentPath = commentPage?.route.name === 'comment_page'
    ? commentPage.params?.permalink ?? (commentPage.params?.cid
      ? options.router.url('post', { cid: commentPage.params.cid }, '') : '')
    : refererPath;
  const match = options.router.match(parentPath.startsWith('/') ? parentPath : `/${parentPath}`);
  if (!match || (match.route.name !== 'post' && match.route.name !== 'page')) return text('Invalid comment target', 400);
  if (routedComment) {
    const routeTarget = feedbackRoute.params?.permalink;
    if (!routeTarget || routeTarget.replace(/\/+$/, '') !== parentPath.replace(/\/+$/, '')) {
      return text('Invalid comment target', 400);
    }
  }
  const type = match.route.name;
  const cidValue = match.params?.cid;
  if (cidValue !== undefined && (!/^[1-9]\d*$/.test(cidValue) || !Number.isSafeInteger(Number(cidValue)))) {
    return text('Invalid comment target', 400);
  }
  const slug = match.params?.slug;
  if (!cidValue && !slug) return text('Invalid comment target', 400);

  const form = await request.body?.();
  if (!form) return text('Expected form data', 400);
  const submittedCid = field(form, 'cid');
  const authorInput = field(form, 'author');
  const mailInput = field(form, 'mail');
  const urlInput = field(form, 'url');
  const textInput = field(form, 'text');
  const parentInput = field(form, 'parent');
  if ([submittedCid, authorInput, mailInput, urlInput, textInput, parentInput].some((value) => value === null)) {
    return text('Invalid comment form', 400);
  }
  if (submittedCid && (!/^[1-9]\d*$/.test(submittedCid) || !Number.isSafeInteger(Number(submittedCid)))) {
    return text('Invalid content ID', 400);
  }
  const row = cidValue
    ? await db.first<ContentRow>('SELECT * FROM table.contents WHERE cid = ? AND type = ?', [Number(cidValue), type])
    : await db.first<ContentRow>('SELECT * FROM table.contents WHERE slug = ? AND type = ?', [slug, type]);
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.status !== 'publish' || row.created > now || (row.password ?? '') !== '') {
    return text('Content not found', 404);
  }
  if (submittedCid && Number(submittedCid) !== row.cid) return text('Invalid content ID', 400);
  if (row.allowComment !== '1' || (enabled(options.get('commentsAutoClose')) &&
    Number(options.get('commentsPostTimeout') ?? 0) > 0 &&
    now - row.created > Number(options.get('commentsPostTimeout')))) {
    return text('Comments are closed', 403);
  }

  const user = await findCurrentUser(db, request);
  if (enabled(options.get('commentsRequireLogin')) && !user) return text('Login required', 403);
  const author = user ? (user.screenName || user.name).trim() : authorInput!.trim();
  const mail = user ? user.mail.trim() : mailInput!.trim();
  const profile = user ? await db.first<{ url: string | null }>('SELECT url FROM table.users WHERE uid = ?', [user.uid]) : null;
  const website = user ? (profile?.url ?? '').trim() : urlInput!.trim();
  const message = textInput!.trim();
  if (!author || new TextEncoder().encode(author).length > 150 || /[\x00-\x1f\x7f]/.test(author)) {
    return text('Invalid author', 400);
  }
  if (!user && await db.first<{ uid: number }>(
    'SELECT uid FROM table.users WHERE screenName = ? OR name = ? LIMIT 1', [author, author]
  )) return text('Registered name requires login', 403);
  if ((!user && !mail && enabled(options.get('commentsRequireMail'))) ||
    (mail && (mail.length > 150 || !emailPattern.test(mail)))) return text('Invalid email', 400);
  if ((!user && !website && enabled(options.get('commentsRequireUrl'))) || website.length > 255) return text('Invalid website', 400);
  if (website) {
    let parsed: URL;
    try { parsed = new URL(website); } catch { return text('Invalid website', 400); }
    if (!/^https?:\/\//i.test(website) || !['http:', 'https:'].includes(parsed.protocol) ||
      !parsed.hostname || parsed.username || parsed.password || /[\x00-\x1f\x7f]/.test(website)) {
      return text('Invalid website', 400);
    }
  }
  if (!message || new TextEncoder().encode(message).length > MAX_COMMENT_BYTES) return text('Invalid comment text', 400);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) return text('Invalid comment text', 400);
  if (parentInput && !/^(?:0|[1-9]\d*)$/.test(parentInput)) return text('Invalid parent comment', 400);
  const parent = Number(parentInput || '0');
  if (!Number.isSafeInteger(parent)) return text('Invalid parent comment', 400);
  if (parent) {
    if (!enabled(options.get('commentsThreaded'))) return text('Replies are disabled', 403);
    const existing = await db.first<{ coid: number }>(
      "SELECT coid FROM table.comments WHERE coid = ? AND cid = ? AND type = 'comment' AND status = 'approved'",
      [parent, row.cid]
    );
    if (!existing) return text('Parent comment not found', 400);
  }

  // Rate-limit and deduplicate using D1 so limits apply across Worker isolates.
  const canEdit = Boolean(user && (user.uid === row.authorId || user.group === 'administrator' || user.group === 'editor'));
  const ip = request.ip.slice(0, 64);
  const interval = Number(options.get('commentsPostInterval') ?? 60);
  const rateLimitOption = options.get('commentsPostIntervalEnable');
  const rateLimitEnabled = rateLimitOption == null || enabled(rateLimitOption);
  if (rateLimitEnabled && !canEdit && Number.isFinite(interval) && interval > 0) {
    const recent = ip
      ? await db.first<{ coid: number }>(
        "SELECT coid FROM table.comments WHERE cid = ? AND ip = ? AND created > ? AND type = 'comment' LIMIT 1",
        [row.cid, ip, now - interval]
      )
      : await db.first<{ coid: number }>(
        "SELECT coid FROM table.comments WHERE cid = ? AND author = ? AND mail = ? AND created > ? AND type = 'comment' LIMIT 1",
        [row.cid, author, mail, now - interval]
      );
    if (recent) return text('Please wait before commenting again', 429);
  }
  // Text is stored as safe HTML because the theme renders comment text as HTML.
  const safeText = escapeHtml(message).replace(/\r\n?|\n/g, '<br />\n');
  const duplicate = await db.first<{ coid: number }>(
    "SELECT coid FROM table.comments WHERE cid = ? AND author = ? AND text = ? AND type = 'comment' AND created > ? LIMIT 1",
    [row.cid, author, safeText, now - 86400]
  );
  if (duplicate) return text('Duplicate comment', 409);
  let status = enabled(options.get('commentsRequireModeration')) && !canEdit ? 'waiting' : 'approved';
  if (!enabled(options.get('commentsRequireModeration')) && enabled(options.get('commentsWhitelist'))) {
    const approved = mail ? await db.first<{ coid: number }>(
      "SELECT coid FROM table.comments WHERE author = ? AND mail = ? AND status = 'approved' AND type = 'comment' LIMIT 1",
      [author, mail]
    ) : null;
    if (!approved) status = 'waiting';
  }

  const insertSql = `INSERT INTO table.comments (cid, created, author, authorId, ownerId, mail, url, ip, agent, text, type, status, parent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'comment', ?, ?) RETURNING coid`;
  const insertParams = [row.cid, now, author, user?.uid ?? 0, row.authorId, mail, website, ip, request.userAgent.slice(0, 511), safeText, status, parent];
  const inserted = status === 'approved'
    ? (await db.batch([
      { sql: insertSql, params: insertParams },
      { sql: "UPDATE table.contents SET commentsNum = (SELECT COUNT(*) FROM table.comments WHERE cid = ? AND type = 'comment' AND status = 'approved') WHERE cid = ?", params: [row.cid, row.cid] },
    ]))[0]?.results
    : (await db.run(insertSql, insertParams)).results;
  const coid = Number((inserted?.[0] as { coid?: number } | undefined)?.coid ?? 0);
  if (!coid) return text('Could not submit comment', 500);
  const permalink = options.router.url(type, type === 'page' ? { slug: row.slug ?? '' } : { cid: String(row.cid) }, options.derived.index);
  const destination = new URL(permalink, request.url.origin);
  if (destination.origin !== request.url.origin) return text('Invalid comment target', 500);
  destination.hash = status === 'approved' ? `comment-${coid}` : `comment-${row.cid}`;
  return new Response(null, { status: 303, headers: { location: destination.toString() } });
}
