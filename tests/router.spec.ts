import { describe, expect, it } from 'vitest';
import { Router } from '../src/core/router';
import { SiteOptions } from '../src/core/options';
import { buildRequestContext, pathInfoFromUrl } from '../src/core/request';
import { DEFAULT_ROUTING_TABLE } from './helpers/render-theme';
import { subStr, url, fixHtml } from '../src/core/common';

describe('Router (Typecho routing table port)', () => {
  const router = Router.from(DEFAULT_ROUTING_TABLE);

  it('matches the index route', () => {
    const match = router.match('/');
    expect(match?.route.name).toBe('index');
    expect(match?.params).toBeNull();
  });

  it('matches post routes and extracts cid', () => {
    const match = router.match('/archives/42/');
    expect(match?.route.name).toBe('post');
    expect(match?.params).toEqual({ cid: '42' });
  });

  it('matches paginated category routes in order', () => {
    const match = router.match('/category/default/2/');
    expect(match?.route.name).toBe('category_page');
    expect(match?.params).toEqual({ slug: 'default', page: '2' });
  });

  it('matches Typecho feed root and nested comment feed paths', () => {
    expect(router.match('/feed/')?.params).toEqual({ feed: '/' });
    expect(router.match('/feed/rss/comments/')?.params).toEqual({ feed: '/rss/comments/' });
  });

  it('builds urls from the format string', () => {
    expect(router.url('post', { cid: '42' }, 'http://example.com')).toBe('http://example.com/archives/42/');
    expect(router.url('index', null, 'http://example.com')).toBe('http://example.com/');
    expect(router.url('category', { slug: 'default' }, 'http://example.com')).toBe('http://example.com/category/default/');
    expect(router.url('index_page', { page: '3' }, 'http://example.com')).toBe('http://example.com/page/3/');
  });

  it('leaves unknown params as placeholders', () => {
    expect(router.url('post', null, 'http://example.com')).toBe('http://example.com/archives/{cid}/');
  });
});

describe('SiteOptions permalink rewrite mode', () => {
  it('treats a stored string 0 as disabled and keeps index.php in post and feed URLs', () => {
    const root = 'https://example.test';
    const request = buildRequestContext(new Request(`${root}/`));
    for (const rewrite of ['0', 0, false]) {
      const options = new SiteOptions({ values: { rewrite, routingTable: DEFAULT_ROUTING_TABLE }, request, echo: () => undefined });
      expect(options.derived.index).toBe(`${root}/index.php`);
      expect(options.derived.feedUrl).toBe(`${root}/index.php/feed/`);
      const post = options.router.url('post', { cid: '42' }, options.derived.index);
      expect(post).toBe(`${root}/index.php/archives/42/`);
      expect(options.router.match(pathInfoFromUrl(new URL(post)))?.route.name).toBe('post');
    }
    const rewritten = new SiteOptions({ values: { rewrite: '1', routingTable: DEFAULT_ROUTING_TABLE }, request, echo: () => undefined });
    expect(rewritten.derived.index).toBe(root);
  });
});

describe('Common helpers', () => {
  it('joins urls like Typecho\\Common::url', () => {
    expect(url(null, 'http://example.com')).toBe('http://example.com/');
    expect(url('a/b', 'http://example.com/')).toBe('http://example.com/a/b');
    expect(url('/a//b', 'http://example.com')).toBe('http://example.com/a/b');
  });

  it('truncates multibyte strings', () => {
    expect(subStr('你好世界', 0, 3)).toBe('...');
    expect(subStr('hi', 0, 10)).toBe('hi');
  });

  it('closes dangling html tags', () => {
    expect(fixHtml('<p>hello <strong>world')).toBe('<p>hello <strong>world</strong></p>');
    expect(fixHtml('<p>abc<')).toBe('<p>abc</p>');
  });
});
