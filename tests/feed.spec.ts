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
        `${path.includes('/atom/') ? 'application/atom+xml' : path.includes('/rss/') ? 'application/rdf+xml' : 'application/rss+xml'}; charset=UTF-8`
      );
      expect(response?.headers.get('x-content-type-options')).toBe('nosniff');
      const body = await response?.text();
      expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(body).toContain(path.includes('/comments/') ? 'A &amp; &lt;B&gt; 的评论' : 'A &amp; &lt;B&gt;');
    }
  );

  it('emits RSS 2 namespaces, description, full content and safe public links', async () => {
    const { db, options, request } = setup('/feed/?token=ignored', [post]);
    const response = await handleFeed(db, request, options);
    const xml = await response!.text();
    expect(xml).toContain('<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"');
    expect(xml).toContain('<title>A &amp; &lt;B&gt;</title>');
    expect(xml).toContain('<title>Hello &lt;World&gt; &amp; &quot;you&quot; &apos;</title>');
    expect(xml).toContain('<link>https://example.com/</link>');
    expect(xml).toContain('<link>https://example.com/archives/42/</link>');
    expect(xml).toContain('<atom:link href="https://example.com/feed/" rel="self" type="application/rss+xml" />');
    expect(xml).toContain('<dc:creator>Author &amp; Co</dc:creator>');
    expect(xml).toContain('<description>A  &amp; good</description>');
    expect(xml).toContain('<content:encoded xml:lang="zh-CN">&lt;p&gt;A &lt;b&gt; &amp; good&lt;/p&gt;</content:encoded>');
    expect(xml).not.toContain('\u0001');
    expect(xml).not.toContain('\u0002');
  });

  it('emits RSS 1.0 RDF with a sequence and escaped item URLs', async () => {
    const row = { ...post, slug: 'hello', title: 'RSS1 & <item>', text: 'A &amp; B' };
    const { db, options, request } = setup('/feed/rss/', [row]);
    const response = await handleFeed(db, request, options);
    const xml = await response!.text();
    expect(response!.headers.get('content-type')).toBe('application/rdf+xml; charset=UTF-8');
    expect(xml).toContain('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"');
    expect(xml).toContain('<channel rdf:about="https://example.com/feed/rss/">');
    expect(xml).toContain('<rdf:Seq><rdf:li resource="https://example.com/archives/42/" /></rdf:Seq>');
    expect(xml).toContain('<title>RSS1 &amp; &lt;item&gt;</title>');
    expect(xml).toContain('<description>A &amp; B</description>');
    expect(xml).toContain('<dc:date>2020-09-13T12:26:40.000Z</dc:date>');
  });

  it.each(['/feed/', '/feed/atom/'])(
    'includes escaped post categories and approved-comment counts in %s', async (path) => {
      const { options, request } = setup(path);
      const all = vi.fn(async (_sql: string, _params: unknown[]) => all.mock.calls.length === 1
        ? [{ ...post, commentsNum: 2 }]
        : [{ cid: 42, name: 'News & <Items>', slug: 'news' }]);
      const response = await handleFeed({ all } as unknown as Db, request, options);
      const output = await response!.text();
      if (path === '/feed/') {
        expect(output).toContain('<category>News &amp; &lt;Items&gt;</category>');
        expect(output).toContain('<slash:comments>2</slash:comments>');
      } else {
        expect(output).toContain('<category scheme="https://example.com/category/news/" term="News &amp; &lt;Items&gt;" />');
        expect(output).toContain('thr:count="2"');
      }
      expect(all.mock.calls[1][0]).toContain("m.type = 'category'");
      expect(all.mock.calls[1][1]).toEqual([42]);
    }
  );

  it('includes stable self links and escaped HTML content in Atom', async () => {
    const { db, options, request } = setup('/feed/atom/?ignored=1', [post]);
    const xml = await (await handleFeed(db, request, options))!.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom" xmlns:thr="http://purl.org/syndication/thread/1.0"');
    expect(xml).toContain('<link rel="self" type="application/atom+xml" href="https://example.com/feed/atom/" />');
    expect(xml).toContain('<entry><title type="html">Hello &lt;World&gt;');
    expect(xml).toContain('<author><name>Author &amp; Co</name></author>');
    expect(xml).toContain('<summary type="html">A  &amp; good</summary>');
    expect(xml).toContain('<content type="html" xml:base="https://example.com/archives/42/" xml:lang="zh-CN">&lt;p&gt;A &lt;b&gt; &amp; good&lt;/p&gt;</content>');
    expect(xml).toContain('<published>2020-09-13T12:26:40.000Z</published>');
    expect(xml).toContain('<updated>2020-09-13T12:26:40.000Z</updated>');
  });

  it.each(['/feed/', '/feed/rss/', '/feed/atom/'])(
    'honors feedFullText=false only when <!--more--> exists in %s', async (path) => {
      const row = { ...post, title: 'Title " & <tag>', text: '<!--markdown-->Before **more**\n\n<!--more-->\n\nPrivate remainder' };
      const { db, options, request } = setup(path, [row]);
      options.values.feedFullText = '0';
      const shortened = await (await handleFeed(db, request, options))!.text();
      expect(shortened).toContain('Before');
      expect(shortened).toContain('[...]');
      expect(shortened).not.toContain('Private remainder');
      if (path !== '/feed/rss/') {
        expect(shortened).toContain('title=&quot;Title &amp;quot; &amp;amp; &amp;lt;tag&amp;gt;&quot;');
      }
      options.values.feedFullText = '1';
      const full = await (await handleFeed(db, request, options))!.text();
      expect(full).toContain('Private remainder');
      expect(full).not.toContain('[...]');
      options.values.feedFullText = '0';
      row.text = 'No separator and complete text';
      const noSeparator = await (await handleFeed(db, request, options))!.text();
      expect(noSeparator).toContain('No separator and complete text');
    }
  );

  it('excludes disallowed XML code points from metadata and content', async () => {
    const { db, options, request } = setup('/feed/atom/', [{ ...post, title: 'Bad\ufffeName', text: 'A\u0000B\ud800C\u{1fffe}D' }]);
    const xml = await (await handleFeed(db, request, options))!.text();
    expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\ud800\udfff]/u);
    expect(xml).not.toContain('\u{1fffe}');
    expect(xml).toContain('ABCD');
  });

  it('reads only approved comments of public eligible contents and omits private columns', async () => {
    const { db, all, options, request } = setup('/feed/comments/', [comment]);
    const xml = await (await handleFeed(db, request, options))!.text();
    expect(xml).toContain('https://example.com/archives/42/#comment-18');
    expect(xml).toContain('<title>&lt;Alice&gt; &amp; Bob</title>');
    expect(xml).not.toContain('on Hello');
    expect(xml).toContain('&lt;p&gt;A  &amp; B&lt;/p&gt;');
    expect(xml).not.toContain('&lt;script&gt;');
    expect(xml).not.toContain('Hello &amp; world');
    const [sql, params] = all.mock.calls[0];
    expect(sql).toMatch(/cm\.status = 'approved' AND cm\.type = 'comment'/);
    expect(sql).toMatch(/cm\.created <= \?/);
    expect(sql).toMatch(/p\.type IN \('post', 'page'\) AND p\.status = 'publish' AND p\.created <= \?/);
    expect(sql).toMatch(/p\.allowFeed IS NOT NULL AND p\.allowFeed <> '0'/);
    expect(sql).toMatch(/p\.password IS NULL OR p\.password = ''/);
    expect(sql).not.toMatch(/cm\.(mail|ip|agent)/);
    expect(params).toHaveLength(3);
    expect(params[2]).toBe(10);
  });

  it('limits post queries to public, unprotected, feed-enabled published posts', async () => {
    const { db, all, options, request } = setup('/feed/', [post]);
    await handleFeed(db, request, options);
    const [sql, params] = all.mock.calls[0];
    expect(sql).toMatch(/p\.type = 'post' AND p\.status = 'publish' AND p\.created <= \?/);
    expect(sql).toMatch(/p\.allowFeed IS NOT NULL AND p\.allowFeed <> '0'/);
    expect(sql).toMatch(/p\.password IS NULL OR p\.password = ''/);
    expect(params).toHaveLength(2);
    expect(params[1]).toBe(10);
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
