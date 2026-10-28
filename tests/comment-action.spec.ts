import { describe, expect, it } from 'vitest';
import { handleCommentRequest } from '../src/core/comment-action';
import { cookiePrefix, typechoHash } from '../src/core/auth';
import { Db } from '../src/core/db';
import { SiteOptions } from '../src/core/options';
import { buildRequestContext } from '../src/core/request';
import type { ContentRow } from '../src/repo/content';

const base = 'https://example.test';
const postUrl = `${base}/archives/12/`;
const user = { uid: 4, name: 'reader', group: 'subscriber', screenName: 'Reader', password: '', mail: 'reader@example.test', authCode: 'abcdef0123456789abcdef0123456789' };
const cookie = `${cookiePrefix(base)}__typecho_uid=4; ${cookiePrefix(base)}__typecho_authCode=${encodeURIComponent(typechoHash(user.authCode, 'abcdef123'))}`;
const now = Math.floor(Date.now() / 1000);

function sampleRow(overrides: Partial<ContentRow> = {}): ContentRow {
  return { cid: 12, title: 'Post', slug: 'post', created: now - 1000, modified: now - 1000, text: '', order: 0, authorId: 2,
    template: null, type: 'post', status: 'publish', password: null, commentsNum: 0, allowComment: '1', allowPing: '1', allowFeed: '1', parent: 0, ...overrides };
}

function fakeDb(row: ContentRow | null = sampleRow()) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const stored = { row, parent: true, recent: false, duplicate: false, approved: false, registered: false };
  const d1 = {
    prepare(sql: string) {
      const statement = {
        sql,
        params: [] as unknown[],
        bind(...params: unknown[]) { statement.params = params; return statement; },
        async first() {
          statements.push({ sql, params: statement.params });
          if (sql.includes('FROM typecho_users') && sql.includes('WHERE uid = ?')) return user;
          if (sql.includes('FROM typecho_users')) return stored.registered ? { uid: user.uid } : null;
          if (sql.includes('FROM typecho_contents')) return stored.row;
          if (sql.includes('coid = ? AND cid = ?')) return stored.parent ? { coid: 5 } : null;
          if (sql.includes('created > ?') && sql.includes('text = ?')) return stored.duplicate ? { coid: 9 } : null;
          if (sql.includes('created > ?')) return stored.recent ? { coid: 9 } : null;
          if (sql.includes("status = 'approved'")) return stored.approved ? { coid: 5 } : null;
          return null;
        },
        async run() { statements.push({ sql, params: statement.params }); return { results: [{ coid: 7 }] }; },
      };
      return statement;
    },
    async batch(entries: Array<{ sql: string; params: unknown[] }>) {
      statements.push(...entries.map((entry) => ({ sql: entry.sql, params: entry.params })));
      return [{ results: [{ coid: 7 }] }, { results: [] }];
    },
  } as unknown as D1Database;
  return { db: new Db(d1), statements, stored };
}

function options(values: Record<string, unknown> = {}): SiteOptions {
  const request = buildRequestContext(new Request(postUrl));
  return new SiteOptions({
    request, echo: () => {},
    values: {
      rewrite: '1',
      routingTable: {
        post: { url: '/archives/[cid:digital]/', widget: '\\Widget\\Archive' },
        page: { url: '/[slug:alpha].html', widget: '\\Widget\\Archive' },
        comment_page: { url: '[permalink:string]/comment-page-[commentPage:digital]', widget: '\\Widget\\CommentPage' },
        feedback: { url: '[permalink:string]/[type:alpha]', widget: '\\Widget\\Feedback' },
      },
      ...values,
    },
  });
}

function submit(fields: Record<string, string> = {}, referer = postUrl, headers: Record<string, string> = {}, action = '/action/feedback') {
  const form = new FormData();
  for (const [key, value] of Object.entries({ author: 'Reader', mail: 'reader@example.test', text: '<script>alert(1)</script>\nHello', ...fields })) form.set(key, value);
  return buildRequestContext(new Request(`${base}${action}`, { method: 'POST', body: form,
    headers: { origin: base, referer, 'cf-connecting-ip': '192.0.2.1', ...headers } }));
}

function inserts(statements: Array<{ sql: string; params: unknown[] }>) {
  return statements.filter((entry) => entry.sql.includes('INSERT INTO typecho_comments'));
}

describe('comment action', () => {
  it('accepts a safe public post comment and atomically updates approved count', async () => {
    const { db, statements } = fakeDb();
    const response = await handleCommentRequest(db, submit(), options());
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe(`${postUrl}#comment-7`);
    expect(inserts(statements)).toHaveLength(1);
    expect(inserts(statements)[0].params).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br />\nHello');
    expect(inserts(statements)[0].params).toContain('approved');
    expect(statements.some((entry) => entry.sql.includes('UPDATE typecho_contents SET commentsNum'))).toBe(true);
  });

  it('allows comments posted from a paginated comment page', async () => {
    const { db } = fakeDb();
    const referer = `${base}/archives/12/comment-page-2`;
    const response = await handleCommentRequest(db, submit({ text: 'Reply on page two' }, referer), options());
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe(`${postUrl}#comment-7`);
  });

  it('places moderated comments in waiting without changing the approved count', async () => {
    const { db, statements } = fakeDb();
    const response = await handleCommentRequest(db, submit(), options({ commentsRequireModeration: '1' }));
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe(`${postUrl}#comment-12`);
    expect(inserts(statements)[0].params).toContain('waiting');
    expect(statements.some((entry) => entry.sql.includes('UPDATE typecho_contents'))).toBe(false);
  });

  it('requires previous approval when whitelist is enabled', async () => {
    const { db, statements, stored } = fakeDb();
    await handleCommentRequest(db, submit(), options({ commentsWhitelist: '1' }));
    expect(inserts(statements)[0].params).toContain('waiting');
    statements.length = 0;
    stored.approved = true;
    await handleCommentRequest(db, submit(), options({ commentsWhitelist: '1' }));
    expect(inserts(statements)[0].params).toContain('approved');
  });

  it('accepts approved same-content parent and authenticated identity', async () => {
    const { db, statements } = fakeDb();
    const response = await handleCommentRequest(db, submit({ parent: '5', author: 'Spoofed', url: 'https://spoofed.example' }, postUrl, { cookie }), options({ commentsThreaded: '1', commentsRequireLogin: '1' }));
    expect(response?.status).toBe(303);
    expect(inserts(statements)[0].params).toContain(5);
    expect(inserts(statements)[0].params).toContain(4);
    expect(inserts(statements)[0].params).not.toContain('Spoofed');
    expect(inserts(statements)[0].params).not.toContain('https://spoofed.example');
    const admin = fakeDb(sampleRow({ authorId: 4 }));
    await handleCommentRequest(admin.db, submit({}, postUrl, { cookie }), options({ commentsRequireModeration: '1', commentsRequireUrl: '1' }));
    expect(inserts(admin.statements)[0].params).toContain('approved');
  });

  it('rejects cross-origin and absent referer without writes', async () => {
    const { db, statements } = fakeDb();
    expect((await handleCommentRequest(db, submit({}, `${base}/archives/12/`, { origin: 'https://evil.test' }), options()))?.status).toBe(403);
    expect((await handleCommentRequest(db, submit({}, 'https://evil.test/archives/12/'), options()))?.status).toBe(403);
    expect((await handleCommentRequest(db, submit({}, '', { origin: base }), options()))?.status).toBe(403);
    expect(inserts(statements)).toHaveLength(0);
  });

  it('rejects content that is unpublished, future, password-protected, or has comments closed', async () => {
    for (const row of [sampleRow({ status: 'draft' }), sampleRow({ created: now + 1000 }), sampleRow({ password: 'secret' }), sampleRow({ allowComment: '0' })]) {
      const { db, statements } = fakeDb(row);
      const response = await handleCommentRequest(db, submit(), options());
      expect(response?.status).toBeGreaterThanOrEqual(400);
      expect(inserts(statements)).toHaveLength(0);
    }
  });

  it('checks required fields, bounded text, safe URLs, submitted cid and parent', async () => {
    const invalid: Array<Record<string, string>> = [
      { text: '' }, { text: 'x'.repeat(65537) }, { author: '' }, { mail: 'not-mail' },
      { url: 'javascript:alert(1)' }, { cid: '11' }, { parent: '999' },
    ];
    for (const fields of invalid) {
      const { db, statements, stored } = fakeDb();
      stored.parent = false;
      expect((await handleCommentRequest(db, submit(fields), options({ commentsThreaded: '1' })))?.status).toBe(400);
      expect(inserts(statements)).toHaveLength(0);
    }
    const { db } = fakeDb();
    expect((await handleCommentRequest(db, submit({ mail: '' }), options({ commentsRequireMail: '1' })))?.status).toBe(400);
    expect((await handleCommentRequest(db, submit({ url: '' }), options({ commentsRequireUrl: '1' })))?.status).toBe(400);
  });

  it('rejects duplicates, rate-limited submissions, and closed-old comments', async () => {
    const { db, statements, stored } = fakeDb();
    stored.recent = true;
    expect((await handleCommentRequest(db, submit(), options()))?.status).toBe(429);
    stored.recent = false;
    stored.duplicate = true;
    expect((await handleCommentRequest(db, submit(), options()))?.status).toBe(409);
    expect(inserts(statements)).toHaveLength(0);
    expect((await handleCommentRequest(db, submit(), options({ commentsAutoClose: '1', commentsPostTimeout: '60' })))?.status).toBe(403);
  });

  it('handles page slug referrers, direct Typecho feedback routes, and method checks', async () => {
    const { db } = fakeDb(sampleRow({ type: 'page', slug: 'about' }));
    expect((await handleCommentRequest(db, submit({}, `${base}/about.html`), options()))?.headers.get('location')).toBe(`${base}/about.html#comment-7`);
    expect(await handleCommentRequest(db, buildRequestContext(new Request(`${base}/action/login`)), options())).toBeNull();
    expect((await handleCommentRequest(db, buildRequestContext(new Request(`${base}/action/feedback`)), options()))?.status).toBe(405);
    const post = fakeDb();
    expect((await handleCommentRequest(post.db, submit({}, postUrl, {}, '/archives/12/comment'), options()))?.status).toBe(303);
    expect((await handleCommentRequest(post.db, submit({}, postUrl, {}, '/archives/13/comment'), options()))?.status).toBe(400);
  });

  it('prevents anonymous visitors from impersonating registered authors', async () => {
    const { db, stored, statements } = fakeDb();
    stored.registered = true;
    expect((await handleCommentRequest(db, submit(), options()))?.status).toBe(403);
    expect(inserts(statements)).toHaveLength(0);
  });
});
