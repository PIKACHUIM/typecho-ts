import { describe, expect, it } from 'vitest';
import { SiteOptions } from '../src/core/options';
import type { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';
import { CommentsWidget, renderComment } from '../src/widgets/comments';
import { RowsWidget } from '../src/widgets/rows';
import type { CommentRow } from '../src/repo/content';

const options = new SiteOptions({
  values: { title: 'Blog', rewrite: '1', routingTable: { post: { url: '/archives/[cid:digital]/', widget: '\\Widget\\Archive', action: 'render' } } },
  request: buildRequestContext(new Request('https://example.test/')),
  echo: () => undefined,
});

describe('public comment rendering', () => {
  it('escapes imported HTML while preserving line breaks and original entities', () => {
    const row: CommentRow = {
      coid: 1, cid: 1, created: 1700000000, author: '<a>', authorId: 0, ownerId: 1, mail: null, url: null,
      ip: null, agent: null, text: '&lt;script&gt;alert(1)&lt;/script&gt;<br />next <img src=x onerror=alert(1)>',
      type: 'comment', status: 'approved', parent: 0,
    };
    const rendered = renderComment(row, options);
    expect(rendered).not.toContain('<script>');
    expect(rendered).not.toContain('<img');
    expect(rendered).toContain('&lt;script&gt;');
    expect(rendered).toContain('<br />');
    expect(rendered).toContain('&lt;a&gt;');
  });

  it('does not double-escape new comment entities in article or sidebar excerpts', async () => {
    const row: CommentRow = {
      coid: 2, cid: 1, created: 1700000000, author: 'Guest', authorId: 0, ownerId: 1,
      mail: null, url: null, ip: null, agent: null,
      text: '&lt;script&gt;alert(1)&lt;/script&gt;<br />next &amp; more',
      type: 'comment', status: 'approved', parent: 0,
    };
    const output: string[] = [];
    const echo = (value: unknown) => output.push(String(value));
    const request = buildRequestContext(new Request('https://example.test/archives/1/'));
    const db = { all: async () => [row] } as unknown as Db;
    const comments = new CommentsWidget({ db, options, request, echo, cid: 1, respondId: 'comment-1', allowComment: true });
    expect(await comments.next()).toBe(true);
    await comments.excerpt(100);
    const articleExcerpt = output.join('');
    expect(articleExcerpt).toContain('&lt;script&gt;');
    expect(articleExcerpt).not.toContain('&amp;lt;');
    expect(articleExcerpt).not.toContain('<script>');
    output.length = 0;
    const recent = new RowsWidget({ db, options, request, echo, rows: [row], kind: 'comments' });
    expect(await recent.next()).toBe(true);
    await recent.excerpt(100);
    expect(output.join('')).toBe(articleExcerpt);
  });
});
