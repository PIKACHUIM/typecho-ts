import { describe, expect, it } from 'vitest';
import { SiteOptions } from '../src/core/options';
import { buildRequestContext } from '../src/core/request';
import { renderComment } from '../src/widgets/comments';
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
});
