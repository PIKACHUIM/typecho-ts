import { describe, expect, it, vi } from 'vitest';
import { PhpArray } from '../php-compat/values';
import type { Db } from '../src/core/db';
import { SiteOptions, type OptionValues } from '../src/core/options';
import { buildRequestContext } from '../src/core/request';
import type { ContentRow, MetaRow } from '../src/repo/content';
import { Archive } from '../src/widgets/archive';
import { siteValues } from './helpers/render-theme';

const row = {
  cid: 12, slug: 'hello', title: '测试文章', type: 'post', status: 'publish',
  created: 1700000000, text: '<p>介绍一下</p><!--more--><p>后文</p>',
  template: null, password: null, allowFeed: '1',
} as ContentRow;

function setup(type: string, params: Record<string, string> = {}, values: OptionValues = {}, rows: { single?: ContentRow | null; metas?: MetaRow[]; tags?: MetaRow[]; count?: number } = {}) {
  const request = buildRequestContext(new Request('http://example.com/'));
  const output: string[] = [];
  const echo = (value: unknown) => output.push(String(value));
  const options = new SiteOptions({ values: siteValues({ keywords: '站点词', description: '站点简介', ...values }), request, echo });
  const all = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.includes('FROM table.metas') && sql.includes("type = 'category'")) return rows.metas ?? [];
    if (sql.includes('FROM table.metas') && sql.includes("type = 'tag'")) return rows.tags ?? [];
    return [];
  });
  const count = vi.fn(async (_sql: string, _params?: unknown[]) => rows.count ?? 0);
  const first = vi.fn(async () => rows.single ?? null);
  const db = { all, count, first } as unknown as Db;
  return { widget: new Archive({ db, options, request, echo, type, params }), all, count, first, output, html: () => output.join('') };
}

describe('Typecho 归档 PHP 行为', () => {
  it.each([
    ['archive_year', { year: '2026' }, 'year', '2026年', 'http://example.com/2026/'],
    ['archive_month', { year: '2026', month: '10' }, 'month', '2026年10月', 'http://example.com/2026/10/'],
    ['archive_day', { year: '2026', month: '10', day: '28' }, 'day', '2026年10月28日', 'http://example.com/2026/10/28/'],
  ])('为 %s 使用 date 类型、日期标题及站点时区', async (type, params, slug, title, url) => {
    const fixture = setup(type, params, { timezone: '28800', routingTable: {
      ...siteValues().routingTable,
      archive_year: { url: '/[year:digital:4]/', widget: '\\Widget\\Archive' },
      archive_month: { url: '/[year:digital:4]/[month:digital:2]/', widget: '\\Widget\\Archive' },
      archive_day: { url: '/[year:digital:4]/[month:digital:2]/[day:digital:2]/', widget: '\\Widget\\Archive' },
    } });
    await fixture.widget.ensureLoaded();
    expect(fixture.widget.archiveType).toBe('date');
    expect(fixture.widget.is('date', slug)).toBe(true);
    expect(fixture.widget.archiveSlug).toBe(slug);
    expect(fixture.widget.titleText).toBe(title);
    expect(fixture.widget.archiveUrl).toBe(url);
    expect(fixture.all.mock.calls[0][1]).toContain('post');
    const start = Date.UTC(2026, Number('month' in params ? params.month : 1) - 1, Number('day' in params ? params.day : 1)) / 1000 - 28800;
    expect(fixture.all.mock.calls[0][1]).toContain(start);
    expect(fixture.count.mock.calls[0][1]).toContain(start);
    await fixture.widget.archiveTitle(new PhpArray([['date', '%s · 归档']]), '', '');
    expect(fixture.html()).toBe(`${title} · 归档`);
  });

  it('拒绝非法日期而不查询文章', async () => {
    const fixture = setup('archive_day', { year: '2026', month: '02', day: '30' });
    await fixture.widget.ensureLoaded();
    expect(fixture.widget.notFound).toBe(true);
    expect(fixture.all).not.toHaveBeenCalled();
  });

  it('分类与标签使用元信息的描述和关键词，同时转义头部属性', async () => {
    for (const type of ['category', 'tag']) {
      const meta = { mid: 1, type, slug: 'news', name: '新闻', description: '介绍 <img src=x onerror="bad()">' } as MetaRow;
      const fixture = setup(type, { slug: 'news' }, {}, { metas: [meta], tags: [meta] });
      await fixture.widget.ensureLoaded();
      expect(fixture.widget.archiveDescription).toBe(meta.description);
      expect(fixture.widget.archiveKeywords).toBe(meta.name);
      expect(fixture.widget.archiveFeedUrl).toBe(fixture.widget.options.derived.feedUrl);
      await fixture.widget.header();
      expect(fixture.html()).toContain('content="介绍 &lt;img src=x onerror=&quot;bad()&quot;&gt;"');
      expect(fixture.html()).not.toContain('<img');
    }
  });

  it('归档标题始终转义不可信的分类名称', async () => {
    const meta = { mid: 1, type: 'category', slug: 'news', name: '<script>alert(1)</script>', description: null } as MetaRow;
    const fixture = setup('category', { slug: 'news' }, {}, { metas: [meta] });
    await fixture.widget.archiveTitle([], '', '');
    expect(fixture.html()).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('单篇使用纯文本摘要和关联标签作为元信息，并拒绝向模板泄露受保护文章', async () => {
    const fixture = setup('post', { cid: '12' }, {}, { single: row, tags: [
      { name: '甲', slug: 'a' }, { name: '乙', slug: 'b' },
    ] as MetaRow[] });
    await fixture.widget.ensureLoaded();
    expect(fixture.widget.archiveDescription).toBe('介绍一下');
    expect(fixture.widget.archiveKeywords).toBe('甲,乙');
    expect(fixture.widget.titleText).toBe('测试文章');
    const hidden = setup('post', { cid: '12' }, {}, { single: null });
    await hidden.widget.ensureLoaded();
    expect(hidden.widget.notFound).toBe(true);
    expect(hidden.widget.archiveDescription).toBe('站点简介');
    expect(hidden.widget.archiveKeywords).toBe('站点词');
  });

  it('page: 首页继承站点元信息；file: 首页只选安全主题文件，不执行任何 PHP', async () => {
    const front = setup('index', {}, { frontPage: 'page:12' }, { single: { ...row, type: 'page' } });
    await front.widget.ensureLoaded();
    expect(front.widget.makeSinglePageAsFrontPage).toBe(true);
    expect(front.widget.archiveDescription).toBe('站点简介');
    expect(front.widget.archiveKeywords).toBe('站点词');
    expect(front.widget.titleText).toBe('');
    const file = setup('index', {}, { frontPage: 'file:landing.php' });
    await file.widget.ensureLoaded();
    expect(file.widget.themeFile).toBe('landing.php');
    expect(file.all).not.toHaveBeenCalled();
    expect(file.first).not.toHaveBeenCalled();
    const unsafe = setup('index', {}, { frontPage: 'file:../secret.php' });
    await unsafe.widget.ensureLoaded();
    expect(unsafe.widget.themeFile).toBe('');
  });

  it('classic-22 第五参数配置 ul/li 并转义标签、类和链接文字', async () => {
    const fixture = setup('index', {}, { pageSize: '1' }, { count: 4 });
    await fixture.widget.pageNav('前一页', '<img src=x onerror=bad()>', 1, '...', new PhpArray([
      ['wrapTag', 'ul'], ['itemTag', 'li'], ['wrapClass', 'classic-pages'],
    ]));
    expect(fixture.html()).toContain('<ul class="classic-pages">');
    expect(fixture.html()).toContain('<li class="next"><a href="http://example.com/page/2/">&lt;img src=x onerror=bad()&gt;</a></li>');
    expect(fixture.html()).not.toContain('<img');
    fixture.output.length = 0;
    await fixture.widget.pageNav('前', '后', 1, '...', new PhpArray([
      ['wrapTag', 'img onerror=bad()'], ['itemTag', 'li onmouseover=bad()'], ['wrapClass', '" onmouseover="bad()'],
    ]));
    expect(fixture.html()).toContain('<ol class="&quot; onmouseover=&quot;bad()">');
    expect(fixture.html()).not.toContain('<img');
    expect(fixture.html()).not.toContain('<li onmouseover');
  });
});
