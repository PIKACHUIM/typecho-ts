import { PHP_HOST, type PhpHost } from '../../php-compat/host';
import { dateFormat } from '../../php-compat/date';
import { escapeHtml, subStr } from '../core/common';
import type { Db } from '../core/db';
import type { SiteOptions } from '../core/options';
import type { RequestContext } from '../core/request';
import { listComments, type CommentRow } from '../repo/content';

export interface CommentsInit {
  db: Db;
  options: SiteOptions;
  request: RequestContext;
  echo: (value: unknown) => void;
  cid: number;
  respondId: string;
  allowComment: boolean;
}

/** Minimal `Widget\Comments\Archive` compatible host for the default theme. */
export class CommentsWidget implements PhpHost {
  readonly [PHP_HOST] = true as const;
  private readonly db: Db;
  private readonly options: SiteOptions;
  private readonly request: RequestContext;
  private readonly echo: (value: unknown) => void;
  private readonly cid: number;
  private readonly respondId: string;
  private readonly allowComment: boolean;

  private rows: CommentRow[] | null = null;
  private index = -1;
  private currentRow: CommentRow | null = null;

  constructor(init: CommentsInit) {
    this.db = init.db;
    this.options = init.options;
    this.request = init.request;
    this.echo = init.echo;
    this.cid = init.cid;
    this.respondId = init.respondId;
    this.allowComment = init.allowComment;
  }

  private async load(): Promise<void> {
    if (this.rows === null) this.rows = await listComments(this.db, this.cid);
  }

  async to(): Promise<this> {
    return this;
  }

  async have(): Promise<boolean> {
    await this.load();
    return (this.rows?.length ?? 0) > 0;
  }

  async next(): Promise<boolean> {
    await this.load();
    if (!this.rows) return false;
    if (this.index + 1 >= this.rows.length) return false;
    this.index++;
    this.currentRow = this.rows[this.index];
    return true;
  }

  async permalink(): Promise<void> {
    const row = this.currentRow;
    if (!row) return;
    const post = this.options.router.url('post', { cid: String(row.cid) }, this.options.derived.index);
    this.echo(`${post}#comment-${row.coid}`);
  }

  async author(autoLink: boolean | null = null, noFollow: boolean | null = null): Promise<void> {
    const row = this.currentRow;
    if (!row) return;
    const name = escapeHtml(row.author ?? '');
    const shouldLink = autoLink === null ? !!row.url : autoLink;
    if (shouldLink && row.url) {
      const rel = noFollow ? ' rel="nofollow"' : '';
      this.echo(`<a href="${escapeHtml(row.url)}"${rel}>${name}</a>`);
    } else {
      this.echo(name);
    }
  }

  async excerpt(length = 100, trim = '...'): Promise<void> {
    const row = this.currentRow;
    if (!row) return;
    const plain = (row.text ?? '').replace(/<[^>]*>/g, '');
    this.echo(escapeHtml(subStr(plain, 0, length, trim)));
  }

  async date(format?: string | null): Promise<void> {
    const row = this.currentRow;
    if (!row) return;
    const fmt = format || String(this.options.get('commentDateFormat') ?? 'F jS, Y \a\t h:ia');
    this.echo(dateFormat(row.created, fmt, Number(this.options.get('timezone') ?? 0)));
  }

  async content(): Promise<void> {
    this.echo(this.currentRow?.text ?? '');
  }

  async listComments(): Promise<void> {
    await this.load();
    const rows = this.rows ?? [];
    if (rows.length === 0) return;
    const parts: string[] = [`<ol class="comment-list">`];
    for (const row of rows) {
      parts.push(renderComment(row, this.options));
    }
    parts.push('</ol>');
    this.echo(parts.join('\n'));
  }

  async pageNav(): Promise<void> {
    // comment pagination is a M6 concern; single page output matches Typecho
  }

  async cancelReply(): Promise<void> {
    this.echo(`<a rel="nofollow" id="cancel-comment-reply-link" href="${this.commentUrl()}" style="display:none;">取消回复</a>`);
  }


  async allowComment_(): Promise<boolean> {
    return this.allowComment;
  }

  phpGet(name: string): unknown {
    if (name === 'respondId') return this.respondId;
    if (name === 'commentsNum') return this.rows?.length ?? 0;
    return null;
  }

  phpCall(name: string, args: unknown[]): unknown {
    if (name === 'to') return this;
    const fn = (this as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
    if (typeof fn === 'function') return fn.apply(this, args);
    return undefined;
  }

  private commentUrl(): string {
    const base = `${this.options.derived.index}`.replace(/\/$/, '');
    return `${base}/action/feedback`;
  }
}

export function renderComment(row: CommentRow, options: SiteOptions): string {
  const permalink = options.router.url('post', { cid: String(row.cid) }, options.derived.index);
  const author = escapeHtml(row.author ?? '');
  const date = dateFormat(row.created, String(options.get('commentDateFormat') ?? 'F jS, Y \a\t h:ia'), Number(options.get('timezone') ?? 0));
  const text = row.text ?? '';
  return `<li id="comment-${row.coid}" class="comment-body comment-parent">
<article id="comment-${row.coid}" class="comment-body">
    <footer class="comment-meta">
        <div class="comment-author vcard">
            <span class="fn">${author}</span>
        </div>
        <div class="comment-metadata">
            <a href="${permalink}#comment-${row.coid}"><time datetime="${new Date(row.created * 1000).toISOString()}">${date}</time></a>
        </div>
    </footer>
    <div class="comment-content">
        ${text}
    </div>
</article>
</li>`;
}
