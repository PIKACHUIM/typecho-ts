import { describe, expect, it } from 'vitest';
import { renderTheme, siteValues } from './helpers/render-theme';
import { Archive } from '../src/widgets/archive';
import { RowsWidget } from '../src/widgets/rows';
import { buildRequestContext } from '../src/core/request';
import type { Db } from '../src/core/db';
import type { SiteOptions } from '../src/core/options';
import type { ClassDef } from '../php-compat/runtime';

const post1 = {
  cid: 1,
  title: 'First Post',
  slug: 'first-post',
  created: 1700000000,
  modified: 1700000000,
  text: '<!--markdown-->Hello **world**',
  order: 0,
  authorId: 1,
  template: null,
  type: 'post',
  status: 'publish',
  password: null,
  commentsNum: 2,
  allowComment: '1',
  allowPing: '1',
  allowFeed: '1',
  parent: 0,
};

const post2 = { ...post1, cid: 2, title: 'Second Post', slug: 'second-post', created: 1700001000, commentsNum: 0 };
const pageRow = { ...post1, cid: 3, title: 'About', slug: 'about', type: 'page' };

const category = { mid: 1, name: 'Default', slug: 'default', type: 'category', description: null, count: 2, order: 1, parent: 0 };

const comment = {
  coid: 1,
  cid: 1,
  created: 1700000500,
  author: 'Alice',
  authorId: 0,
  ownerId: 0,
  mail: 'a@example.com',
  url: null,
  ip: '127.0.0.1',
  agent: 'vitest',
  text: 'Nice post',
  type: 'comment',
  status: 'approved',
  parent: 0,
};

const fakeDb = {
  all: async () => [],
  first: async () => null,
  count: async () => 0,
} as unknown as Db;

function rowsWidget(options: SiteOptions, echo: (v: unknown) => void, rows: unknown[], kind: 'contents' | 'metas' | 'comments' = 'contents') {
  return new RowsWidget({ db: fakeDb, options, request: buildRequestContext(new Request('http://example.com/')), echo, rows: rows as any[], kind });
}

function classes(options: SiteOptions, echo: (v: unknown) => void): ClassDef[] {
  return [
    { kind: 'host', name: 'Widget\\Contents\\Page\\Rows', statics: { alloc: () => rowsWidget(options, echo, [pageRow]) } },
    { kind: 'host', name: 'Widget\\Contents\\Post\\Recent', statics: { alloc: () => rowsWidget(options, echo, [post1, post2]) } },
    { kind: 'host', name: 'Widget\\Metas\\Category\\Rows', statics: { alloc: () => rowsWidget(options, echo, [category], 'metas') } },
    { kind: 'host', name: 'Widget\\Comments\\Recent', statics: { alloc: () => rowsWidget(options, echo, [comment], 'comments') } },
  ];
}

describe('default theme rendering', () => {
  it('renders the index page from the real theme templates', async () => {
    const values = siteValues();
    const html = await renderTheme('index.php', {
      values,
      createClasses: classes,
      createSelf: (options, echo) => {
        const archive = new Archive({ db: fakeDb, options, request: buildRequestContext(new Request('http://example.com/')), echo, type: 'index' });
        Object.assign(archive, { posts: [post1, post2], total: 2, archiveType: 'index', loaded: true, index: -1 });
        return archive;
      },
    });

    expect(html).toContain('<!DOCTYPE HTML>');
    expect(html).toContain('<title>Test Site</title>');
    expect(html).toContain('<meta name="generator" content="Typecho 1.3.1" />');
    expect(html).toContain('<a id="logo" href="http://example.com/">Test Site</a>');
    expect(html).toContain('href="http://example.com/archives/1/"');
    expect(html).toContain('First Post');
    expect(html).toContain('Second Post');
    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain('href="http://example.com/author/1/"');
    expect(html).not.toContain('page-navigator');
    expect(html).toContain('class="widget-list"');
    expect(html).toContain('href="http://example.com/about.html"');
    expect(html).toContain('Alice');
    expect(html).toContain('http://example.com/admin/login.php');
  });

  it('renders a single post page with comments form', async () => {
    const values = siteValues();
    const html = await renderTheme('post.php', {
      values,
      url: 'http://example.com/archives/1/',
      createClasses: classes,
      createSelf: (options, echo) => {
        const archive = new Archive({
          db: fakeDb,
          options,
          request: buildRequestContext(new Request('http://example.com/archives/1/')),
          echo,
          type: 'post',
          params: { cid: '1' },
        });
        Object.assign(archive, {
          posts: [post1],
          total: 1,
          archiveType: 'post',
          archiveSingle: true,
          archiveUrl: 'http://example.com/archives/1/',
          titleText: 'First Post',
          loaded: true,
          index: -1,
        });
        return archive;
      },
    });

    expect(html).toContain('<h1 class="post-title" itemprop="name headline">');
    expect(html).toContain('Hello <strong>world</strong>');
    expect(html).toContain('Alice');
    expect(html).toContain('action="http://example.com/action/feedback"');
    expect(html).toContain('name="author"');
    expect(html).toContain('<link rel="canonical" href="http://example.com/archives/1/" />');
  });
});
