import { describe, expect, it } from 'vitest';
import { PhpArray } from '../php-compat/values';
import { SiteOptions } from '../src/core/options';
import type { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';
import type { CommentRow } from '../src/repo/content';
import { CommentsWidget } from '../src/widgets/comments';

const routingTable = {
  post: { url: '/archives/[cid:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  page: { url: '/[slug:alpha].html', widget: '\\Widget\\Archive', action: 'render' },
  comment_page: { url: '[permalink:string]/comment-page-[commentPage:digital]', widget: '\\Widget\\CommentPage', action: 'action' },
};

function comment(coid: number, parent = 0, text = `评论 ${coid}`): CommentRow {
  return {
    coid, cid: 1, created: 1700000000 + coid, author: `作者 ${coid}`, authorId: 0, ownerId: 1,
    mail: null, url: null, ip: null, agent: null, text, type: 'comment', status: 'approved', parent,
  };
}

function setup(rows: CommentRow[], url = 'https://example.test/archives/1/', overrides: Record<string, unknown> = {}) {
  const request = buildRequestContext(new Request(url));
  const output: string[] = [];
  const echo = (value: unknown) => output.push(String(value));
  const options = new SiteOptions({
    values: {
      rewrite: '1', routingTable, commentsThreaded: '1', commentsPageBreak: '1',
      commentsPageSize: '1', commentsMaxNestingLevels: '3', commentDateFormat: 'Y-m-d', ...overrides,
    },
    request, echo,
  });
  const db = { all: async () => rows } as unknown as Db;
  return {
    widget: new CommentsWidget({ db, options, request, echo, cid: 1, respondId: 'comment-1', allowComment: true }),
    html: () => output.join(''),
    clear: () => { output.length = 0; },
  };
}

describe('Typecho 评论导航与回复树', () => {
  it('按根评论分页，完整保留当前页的回复树和安全内容', async () => {
    const { widget, html, clear } = setup([
      comment(1), comment(2, 1, '&lt;script&gt;alert(1)&lt;/script&gt;<img onerror=alert(1)>'),
      comment(3, 2), comment(4),
    ]);
    expect(await widget.have()).toBe(true);
    await widget.listComments();
    const first = html();
    expect(first).toContain('id="comment-1"');
    expect(first).toContain('id="comment-2"');
    expect(first).toContain('id="comment-3"');
    expect(first).not.toContain('id="comment-4"');
    expect(first).toContain('<div class="comment-children"><ol class="comment-list">');
    expect(first).toContain('comment-child comment-level-odd');
    expect(first).toContain('&lt;script&gt;');
    expect(first).not.toContain('<script>alert(1)</script>');
    expect(first).not.toContain('<img');
    expect(first).toContain('data-reply-to="1"');
    expect(first).toContain('name="parent"');
    expect((first.match(/id="comment-2"/g) ?? []).length).toBe(1);
    clear();
    await widget.pageNav();
    expect(html()).toContain('href="https://example.test/archives/1/comment-page-2#comments"');
    expect(html()).toContain('class="next"');
    expect(html()).not.toContain('class="prev"');
  });

  it('支持默认最后一页、路由页码和主题的分页标签配置', async () => {
    const rows = [comment(1), comment(2), comment(3)];
    const latest = setup(rows, 'https://example.test/archives/1/', { commentsPageDisplay: 'last' });
    await latest.widget.listComments();
    expect(latest.html()).toContain('id="comment-3"');
    expect(latest.html()).not.toContain('id="comment-1"');

    const middle = setup(rows, 'https://example.test/archives/1/comment-page-2');
    await middle.widget.listComments();
    expect(middle.html()).toContain('id="comment-2"');
    expect(middle.html()).not.toContain('id="comment-1"');
    middle.clear();
    await middle.widget.pageNav('前一页', '后一页', 1, '…', new PhpArray([
      ['wrapTag', 'ul'], ['itemTag', 'li'], ['wrapClass', 'custom-pages'],
    ]));
    expect(middle.html()).toContain('<ul class="custom-pages">');
    expect(middle.html()).toContain('href="https://example.test/archives/1/comment-page-1#comments"');
    expect(middle.html()).toContain('href="https://example.test/archives/1/comment-page-3#comments"');
    expect(middle.html()).toContain('class="current"');
    expect(middle.html()).not.toContain('<ol class="page-navigator">');
  });

  it('静态页面生成分页链接时保留页面 slug，回复锚点不指向文章', async () => {
    const { widget, html, clear } = setup([comment(1), comment(2)], 'https://example.test/notes.html');
    await widget.listComments();
    expect(html()).toContain('href="https://example.test/notes.html#comment-1"');
    clear();
    await widget.pageNav();
    expect(html()).toContain('href="https://example.test/notes.html/comment-page-2#comments"');
  });

  it('非重写链接不重复拼接 index.php 路径', async () => {
    const { widget, html } = setup([comment(1), comment(2)], 'https://example.test/index.php/archives/1/', { rewrite: 0 });
    await widget.pageNav();
    expect(html()).toContain('href="https://example.test/index.php/archives/1/comment-page-2#comments"');
    expect(html()).not.toContain('/index.php/index.php/');
  });

  it('禁用分页时全部呈现；禁用线程时回复作为同级评论', async () => {
    const { widget, html } = setup([comment(1), comment(2, 1), comment(3)], undefined, {
      commentsPageBreak: '0', commentsThreaded: '0',
    });
    await widget.listComments();
    await widget.pageNav();
    expect(html()).toContain('id="comment-1"');
    expect(html()).toContain('id="comment-2"');
    expect(html()).toContain('id="comment-3"');
    expect(html()).not.toContain('comment-children');
    expect(html()).not.toContain('page-navigator');
  });

  it('降级孤儿评论并限制最大回复层级，拒绝导航属性注入', async () => {
    const { widget, html, clear } = setup([
      comment(1), comment(2, 1), comment(3, 2), comment(4, 999),
    ], undefined, { commentsPageBreak: '0', commentsMaxNestingLevels: '2' });
    await widget.listComments();
    expect(html()).toContain('id="comment-4"');
    expect(html()).not.toContain('comment-level-even');
    clear();

    const paginated = setup([comment(1), comment(2)], 'https://example.test/archives/1/comment-page-2', { commentsPageBreak: '1' });
    await paginated.widget.pageNav('<img src=x onerror=alert(1)>', '后', 3, '…', new PhpArray([
      ['wrapTag', 'img onerror=alert(1)'], ['wrapClass', '" onmouseover="alert(1)'],
    ]));
    expect(paginated.html()).not.toContain('<img');
    expect(paginated.html()).not.toContain('class="" onmouseover=');
    expect(paginated.html()).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('评论按 DESC 排列时同时翻转根评论与各级回复', async () => {
    const { widget, html } = setup([comment(1), comment(2, 1), comment(3, 1), comment(4)], undefined, {
      commentsOrder: 'DESC', commentsPageBreak: '0',
    });
    await widget.listComments();
    expect(html().indexOf('id="comment-4"')).toBeLessThan(html().indexOf('id="comment-1"'));
    expect(html().indexOf('id="comment-3"')).toBeLessThan(html().indexOf('id="comment-2"'));
  });
});
