import type { Db } from './db';
import { renderContent } from './markdown';
import type { SiteOptions } from './options';
import type { RequestContext } from './request';

interface FeedPost {
  cid: number;
  title: string | null;
  slug: string | null;
  created: number;
  text: string | null;
  type: string;
  authorName: string | null;
  commentsNum?: number;
}

interface FeedComment {
  coid: number;
  cid: number;
  created: number;
  author: string | null;
  text: string | null;
  slug: string | null;
  type: string;
}

function xml(value: unknown): string {
  let clean = '';
  for (const char of String(value ?? '')) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if ((code >= 0xd800 && code <= 0xdfff) || (code & 0xffff) >= 0xfffe) continue;
    clean += char;
  }
  return clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|#(?:x[\da-f]+|\d+));/gi, (entity, name: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (!name.startsWith('#')) return named[name.toLowerCase()] ?? entity;
    const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

function postExcerpt(html: string): string {
  const text = [...plainText(html)];
  return text.length > 100 ? `${text.slice(0, 97).join('')}...` : text.join('');
}

interface FeedEntry {
  title: string;
  url: string;
  created: number;
  author: string;
  html: string;
  excerpt: string;
  commentsNum?: number;
  categories?: Array<{ name: string; url: string }>;
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

  const format = route[1] === 'atom' ? 'atom' : route[1] === 'rss' ? 'rss1' : 'rss2';
  const comments = route[2] === 'comments';
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const now = Math.floor(Date.now() / 1000);
  const rows = comments
    ? await db.all<FeedComment>(
      `SELECT cm.coid, cm.cid, cm.created, cm.author, cm.text, p.slug, p.type
         FROM table.comments cm JOIN table.contents p ON p.cid = cm.cid
        WHERE cm.status = 'approved' AND cm.type = 'comment' AND cm.created <= ?
          AND p.type IN ('post', 'page') AND p.status = 'publish' AND p.created <= ?
          AND p.allowFeed IS NOT NULL AND p.allowFeed <> '0'
          AND (p.password IS NULL OR p.password = '')
        ORDER BY cm.coid DESC LIMIT ?`,
      [now, now, 10]
    )
    : await db.all<FeedPost>(
      `SELECT p.cid, p.title, p.slug, p.created, p.text, p.type, p.commentsNum,
              COALESCE(NULLIF(u.screenName, ''), u.name) AS authorName
         FROM table.contents p LEFT JOIN table.users u ON u.uid = p.authorId
        WHERE p.type = 'post' AND p.status = 'publish' AND p.created <= ?
          AND p.allowFeed IS NOT NULL AND p.allowFeed <> '0'
          AND (p.password IS NULL OR p.password = '')
        ORDER BY p.created DESC, p.cid DESC LIMIT ?`,
      [now, 10]
    );

  const title = options.text('title');
  const siteUrl = String(options.derived.siteUrl);
  const description = options.text('description');
  const feedUrl = String(options.derived[format === 'rss1' ? 'feedRssUrl' : format === 'atom' ? 'feedAtomUrl' : 'feedUrl']);
  const selfUrl = comments
    ? String(options.derived[format === 'rss1' ? 'commentsFeedRssUrl' : format === 'atom' ? 'commentsFeedAtomUrl' : 'commentsFeedUrl'])
    : feedUrl;
  const updated = rows.length ? Math.max(...rows.map((row) => Number(row.created))) : now;
  const categories = new Map<number, Array<{ name: string; url: string }>>();
  if (!comments && format !== 'rss1' && rows.length) {
    const ids = (rows as FeedPost[]).map((row) => row.cid);
    const metaRows = await db.all<{ cid: number; name: string; slug: string }>(
      `SELECT r.cid, m.name, m.slug FROM table.relationships r JOIN table.metas m ON m.mid = r.mid
        WHERE m.type = 'category' AND r.cid IN (${ids.map(() => '?').join(',')}) ORDER BY m."order", m.mid`,
      ids
    );
    for (const meta of metaRows) {
      if (typeof meta.name !== 'string' || typeof meta.slug !== 'string') continue;
      const values = categories.get(meta.cid) ?? [];
      values.push({ name: meta.name, url: options.router.url('category', { slug: meta.slug }, options.derived.index) });
      categories.set(meta.cid, values);
    }
  }
  const entries: FeedEntry[] = comments
    ? (rows as FeedComment[]).map((row) => {
      const html = renderContent(row.text ?? '').replace(/<\s*(\/?)\s*([a-z][a-z0-9-]*)\b[^>]*>/gi, (_match, slash: string, tag: string) =>
        tag.toLowerCase() === 'p' || tag.toLowerCase() === 'br' ? `<${slash}${tag.toLowerCase()}>` : ''
      );
      return {
        title: row.author || '',
        url: `${permalink(options, row)}#comment-${row.coid}`,
        created: Number(row.created),
        author: row.author || '',
        html,
        excerpt: plainText(html),
      };
    })
    : (rows as FeedPost[]).map((row) => {
      const raw = row.text ?? '';
      const url = permalink(options, row);
      const fullHtml = renderContent(raw);
      const hasMore = raw.includes('<!--more-->');
      const excerptHtml = hasMore ? renderContent(raw.split('<!--more-->')[0]) : fullHtml;
      const fullText = Boolean(options.get('feedFullText')) && options.get('feedFullText') !== '0';
      const html = fullText || !hasMore
        ? fullHtml
        : `${excerptHtml}<p class="more"><a href="${xml(url)}" title="${xml(row.title)}">[...]</a></p>`;
      return {
        title: row.title ?? '',
        url,
        created: Number(row.created),
        author: row.authorName || title,
        html,
        excerpt: postExcerpt(excerptHtml),
        commentsNum: row.commentsNum,
        categories: categories.get(row.cid),
      };
    });
  const feedTitle = comments ? `${title} 的评论` : title;
  const header = '<?xml version="1.0" encoding="UTF-8"?>\n';
  const output = format === 'rss1'
    ? `${header}<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">\n<channel rdf:about="${xml(selfUrl)}"><title>${xml(feedTitle)}</title><link>${xml(siteUrl)}</link><description>${xml(description)}</description><items><rdf:Seq>${entries.map((entry) => `<rdf:li resource="${xml(entry.url)}" />`).join('')}</rdf:Seq></items></channel>\n${entries.map((entry) => `<item rdf:about="${xml(entry.url)}"><title>${xml(entry.title)}</title><link>${xml(entry.url)}</link><dc:date>${xml(atomDate(entry.created))}</dc:date><description>${xml(plainText(entry.html))}</description></item>`).join('\n')}\n</rdf:RDF>`
    : format === 'rss2'
      ? `${header}<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:slash="http://purl.org/rss/1.0/modules/slash/" xmlns:atom="http://www.w3.org/2005/Atom"><channel>\n<title>${xml(feedTitle)}</title><link>${xml(siteUrl)}</link><atom:link href="${xml(selfUrl)}" rel="self" type="application/rss+xml" /><language>zh-CN</language><description>${xml(description)}</description><lastBuildDate>${xml(rssDate(updated))}</lastBuildDate><pubDate>${xml(rssDate(updated))}</pubDate>\n${entries.map((entry) => `<item><title>${xml(entry.title)}</title><link>${xml(entry.url)}</link><guid>${xml(entry.url)}</guid><pubDate>${xml(rssDate(entry.created))}</pubDate><dc:creator>${xml(entry.author)}</dc:creator>${(entry.categories ?? []).map((category) => `<category>${xml(category.name)}</category>`).join('')}<description>${xml(entry.excerpt)}</description><content:encoded xml:lang="zh-CN">${xml(entry.html)}</content:encoded>${entry.commentsNum === undefined ? '' : `<slash:comments>${xml(entry.commentsNum)}</slash:comments>`}${comments ? '' : `<comments>${xml(entry.url)}#comments</comments>`}</item>`).join('\n')}\n</channel></rss>`
      : `${header}<feed xmlns="http://www.w3.org/2005/Atom" xmlns:thr="http://purl.org/syndication/thread/1.0" xml:lang="zh-CN" xml:base="${xml(siteUrl)}">\n<title type="text">${xml(feedTitle)}</title><subtitle type="text">${xml(description)}</subtitle><updated>${xml(atomDate(updated))}</updated><generator>Typecho</generator><link rel="alternate" type="text/html" href="${xml(siteUrl)}" /><id>${xml(selfUrl)}</id><link rel="self" type="application/atom+xml" href="${xml(selfUrl)}" />\n${entries.map((entry) => `<entry><title type="html">${xml(entry.title)}</title><link rel="alternate" type="text/html" href="${xml(entry.url)}" /><id>${xml(entry.url)}</id><updated>${xml(atomDate(entry.created))}</updated><published>${xml(atomDate(entry.created))}</published><author><name>${xml(entry.author)}</name></author>${(entry.categories ?? []).map((category) => `<category scheme="${xml(category.url)}" term="${xml(category.name)}" />`).join('')}<summary type="html">${xml(entry.excerpt)}</summary><content type="html" xml:base="${xml(entry.url)}" xml:lang="zh-CN">${xml(entry.html)}</content>${entry.commentsNum === undefined ? '' : `<link rel="replies" type="text/html" href="${xml(entry.url)}#comments" thr:count="${xml(entry.commentsNum)}" />`}</entry>`).join('\n')}\n</feed>`;
  return new Response(request.method === 'HEAD' ? null : output, {
    headers: {
      'content-type': `${format === 'rss1' ? 'application/rdf+xml' : format === 'rss2' ? 'application/rss+xml' : 'application/atom+xml'}; charset=UTF-8`,
      'x-content-type-options': 'nosniff',
    },
  });
}
