import type { Db } from './db';
import { renderContent } from './markdown';
import type { SiteOptions } from './options';
import type { RequestContext } from './request';

interface FeedPost {
  cid: number;
  title: string | null;
  slug: string | null;
  created: number;
  modified: number;
  text: string | null;
  type: string;
  authorName: string | null;
}

interface FeedComment {
  coid: number;
  cid: number;
  created: number;
  author: string | null;
  text: string | null;
  title: string | null;
  slug: string | null;
  type: string;
}

function xml(value: unknown): string {
  let clean = '';
  for (const char of String(value ?? '')) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if ((code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) continue;
    clean += char;
  }
  return clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function limit(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(50, Math.floor(parsed)) : 10;
}

function permalink(options: SiteOptions, row: Pick<FeedPost, 'cid' | 'slug' | 'type'>): string {
  const route = row.type === 'page' ? 'page' : 'post';
  return options.router.url(route, { cid: String(row.cid), slug: row.slug ?? '' }, options.derived.index);
}

function rssDate(seconds: number): string {
  return new Date(seconds * 1000).toUTCString();
}

function atomDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Returns null for paths outside the supported public feed routes. */
export async function handleFeed(db: Db, request: RequestContext, options: SiteOptions): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  const route = /^\/feed(?:\/(rss|atom))?(?:\/(comments))?$/.exec(path);
  if (!route) return null;

  const format = route[1] === 'atom' ? 'atom' : 'rss';
  const comments = route[2] === 'comments';
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const now = Math.floor(Date.now() / 1000);
  const rows = comments
    ? await db.all<FeedComment>(
      `SELECT cm.coid, cm.cid, cm.created, cm.author, cm.text, p.title, p.slug, p.type
         FROM table.comments cm JOIN table.contents p ON p.cid = cm.cid
        WHERE cm.status = 'approved' AND cm.type = 'comment' AND cm.created <= ?
          AND p.type IN ('post', 'page') AND p.status = 'publish' AND p.created <= ?
          AND p.allowFeed IS NOT NULL AND p.allowFeed <> '0'
          AND (p.password IS NULL OR p.password = '')
        ORDER BY cm.created DESC, cm.coid DESC LIMIT ?`,
      [now, now, limit(options.get('commentsListSize'))]
    )
    : await db.all<FeedPost>(
      `SELECT p.cid, p.title, p.slug, p.created, p.modified, p.text, p.type,
              COALESCE(NULLIF(u.screenName, ''), u.name) AS authorName
         FROM table.contents p LEFT JOIN table.users u ON u.uid = p.authorId
        WHERE p.type = 'post' AND p.status = 'publish' AND p.created <= ?
          AND p.allowFeed IS NOT NULL AND p.allowFeed <> '0'
          AND (p.password IS NULL OR p.password = '')
        ORDER BY p.created DESC, p.cid DESC LIMIT ?`,
      [now, limit(options.get('postsListSize'))]
    );

  const title = options.text('title');
  const siteUrl = String(options.derived.siteUrl);
  const description = options.text('description');
  const selfUrl = `${request.url.origin}${request.url.pathname}`;
  const updated = rows.length
    ? Math.max(...rows.map((row) => comments ? Number(row.created) : Math.max(Number(row.created), Number((row as FeedPost).modified))))
    : now;
  const entries = comments
    ? (rows as FeedComment[]).map((row) => ({
      title: `${row.author || 'Anonymous'} on ${row.title ?? ''}`,
      url: `${permalink(options, row)}#comment-${row.coid}`,
      created: Number(row.created),
      updated: Number(row.created),
      author: row.author || 'Anonymous',
      html: renderContent(row.text ?? ''),
    }))
    : (rows as FeedPost[]).map((row) => ({
      title: row.title ?? '',
      url: permalink(options, row),
      created: Number(row.created),
      updated: Math.max(Number(row.created), Number(row.modified)),
      author: row.authorName || title,
      html: renderContent(row.text ?? ''),
    }));

  const output = format === 'rss'
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n<title>${xml(comments ? `${title} - Comments` : title)}</title>\n<link>${xml(siteUrl)}</link>\n<description>${xml(description)}</description>\n<lastBuildDate>${xml(rssDate(updated))}</lastBuildDate>\n${entries.map((entry) => `<item><title>${xml(entry.title)}</title><link>${xml(entry.url)}</link><guid isPermaLink="true">${xml(entry.url)}</guid><pubDate>${xml(rssDate(entry.created))}</pubDate><description>${xml(entry.html)}</description></item>`).join('\n')}\n</channel></rss>`
    : `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n<title>${xml(comments ? `${title} - Comments` : title)}</title>\n<subtitle>${xml(description)}</subtitle>\n<id>${xml(selfUrl)}</id>\n<link rel="self" href="${xml(selfUrl)}" />\n<link rel="alternate" href="${xml(siteUrl)}" />\n<updated>${xml(atomDate(updated))}</updated>\n${entries.map((entry) => `<entry><title>${xml(entry.title)}</title><id>${xml(entry.url)}</id><link href="${xml(entry.url)}" /><published>${xml(atomDate(entry.created))}</published><updated>${xml(atomDate(entry.updated))}</updated><author><name>${xml(entry.author)}</name></author><content type="html">${xml(entry.html)}</content></entry>`).join('\n')}\n</feed>`;
  return new Response(request.method === 'HEAD' ? null : output, {
    headers: {
      'content-type': `application/${format === 'rss' ? 'rss' : 'atom'}+xml; charset=UTF-8`,
      'x-content-type-options': 'nosniff',
    },
  });
}
