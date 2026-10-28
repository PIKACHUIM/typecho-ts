import { describe, expect, it, vi } from 'vitest';
import { handleFeed } from '../src/core/feed';
import type { Db } from '../src/core/db';
import { SiteOptions } from '../src/core/options';
import { buildRequestContext } from '../src/core/request';
import { siteValues } from './helpers/render-theme';

function setup(path: string, rows: Record<string, unknown>[] = [], method = 'GET') {
  const request = buildRequestContext(new Request(`https://example.com${path}`, { method }));
  const options = new SiteOptions({
    values: siteValues({ title: 'A & <B>\u0001', description: 'A "site" & more', siteUrl: 'https://example.com', rewrite: '1' }),
    request,
    echo: () => {},
  });
  const all = vi.fn(async (_sql: string, _params: unknown[]) => rows);
  const db = { all } as unknown as Db;
  return { db, all, options, request };
}

const post = {
  cid: 42,
  title: `Hello <World> & "you" '\u0002`,
  slug: 'hello',
  created: 1_600_000_000,
  modified: 1_600_000_001,
  text: 'A <b> & good',
  type: 'post',
  authorName: 'Author & Co',
};

const comment = {
  coid: 18,
  cid: 42,
  created: 1_600_000_000,
  author: '<Alice> & Bob',
  text: 'A <script> & B',
  title: 'Hello & world',
  slug: 'hello',
  type: 'post',
};

describe('public feeds', () => {
  it.each(['/feed/', '/feed/rss/', '/feed/atom/', '/feed/comments/', '/feed/rss/comments/', '/feed/atom/comments/'])(
    'supports %s', async (path) => {
      const { db, options, request } = setup(path);
      const response = await handleFeed(db, request, options);
      expect(response?.status).toBe(200);
      expect(response?.headers.get('content-type')).toBe(
        `application/${path.includes('/atom/') ? 'atom' : 'rss'}+xml; charset=UTF-8`
      );
      expect(response?.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response?.text()).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    }
  );

  it('escapes XML data and uses the configured post permalink in RSS', async () => {
    const { db, options, request } = setup('/feed/rss/?token=ignored', [post]);
    const response = await handleFeed(db, request, options);
    const xml = await response!.text();
    expect(xml).toContain('<title>A &amp; &lt;B&gt;</title>');
    expect(xml).toContain('<title>Hello &lt;World&gt; &amp; &quot;you&quot; &apos;</title>');
    expect(xml).toContain('<link>https://example.com/</link>');
    expect(xml).toContain('<link>https://example.com/archives/42/</link>');
    expect(xml).toContain('<description>&lt;p&gt;A &lt;b&gt; &amp; good&lt;/p&gt;</description>');
    expect(xml).not.toContain('\u0001');
    expect(xml).not.toContain('\u0002');
    expect(xml).not.toContain('<script>');
  });

  it('includes stable self links and escaped HTML content in Atom', async () => {
    const { db, options, request } = setup('/feed/atom/?ignored=1', [post]);
    const xml = await (await handleFeed(db, request, options))!.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain('<link rel="self" href="https://example.com/feed/atom/" />');
    expect(xml).toContain('<entry><title>Hello &lt;World&gt;');
    expect(xml).toContain('<author><name>Author &amp; Co</name></author>');
    expect(xml).toContain('<content type="html">&lt;p&gt;A &lt;b&gt; &amp; good&lt;/p&gt;</content>');
    expect(xml).toContain('<published>2020-09-13T12:26:40.000Z</published>');
  });

  it('reads only approved comments of public eligible contents and omits private columns', async () => {
    const { db, all, options, request } = setup('/feed/comments/', [comment]);
    const xml = await (await handleFeed(db, request, options))!.text();
    expect(xml).toContain('https://example.com/archives/42/#comment-18');
    expect(xml).toContain('&lt;Alice&gt; &amp; Bob on Hello &amp; world');
    expect(xml).toContain('&lt;p&gt;A &lt;script&gt; &amp; B&lt;/p&gt;');
    const [sql, params] = all.mock.calls[0];
    expect(sql).toMatch(/cm\.status = 'approved' AND cm\.type = 'comment'/);
    expect(sql).toMatch(/cm\.created <= \?/);
    expect(sql).toMatch(/p\.type IN \('post', 'page'\) AND p\.status = 'publish' AND p\.created <= \?/);
    expect(sql).toMatch(/p\.allowFeed IS NOT NULL AND p\.allowFeed <> '0'/);
    expect(sql).toMatch(/p\.password IS NULL OR p\.password = ''/);
    expect(sql).not.toMatch(/cm\.(mail|ip|agent)/);
    expect(params).toHaveLength(3);
  });

  it('limits post queries to public, unprotected, feed-enabled published posts', async () => {
    const { db, all, options, request } = setup('/feed/', [post]);
    await handleFeed(db, request, options);
    const [sql, params] = all.mock.calls[0];
    expect(sql).toMatch(/p\.type = 'post' AND p\.status = 'publish' AND p\.created <= \?/);
    expect(sql).toMatch(/p\.allowFeed IS NOT NULL AND p\.allowFeed <> '0'/);
    expect(sql).toMatch(/p\.password IS NULL OR p\.password = ''/);
    expect(params).toHaveLength(2);
    expect(params[1]).toBe(5);
  });

  it('returns no match for paths outside the supported feeds and rejects writes', async () => {
    const other = setup('/feed/not-supported/');
    expect(await handleFeed(other.db, other.request, other.options)).toBeNull();
    expect(other.all).not.toHaveBeenCalled();
    const write = setup('/feed/', [], 'POST');
    const response = await handleFeed(write.db, write.request, write.options);
    expect(response?.status).toBe(405);
    expect(response?.headers.get('allow')).toBe('GET, HEAD');
    expect(write.all).not.toHaveBeenCalled();
  });

  it('serves HEAD with no body', async () => {
    const { db, options, request } = setup('/feed/atom/', [post], 'HEAD');
    const response = await handleFeed(db, request, options);
    expect(response?.headers.get('content-type')).toBe('application/atom+xml; charset=UTF-8');
    expect(await response?.text()).toBe('');
  });
});
