import { PHP_HOST, type PhpHost } from '../../php-compat/host';
import { dateFormat } from '../../php-compat/date';
import { escapeHtml, parseOption } from '../core/common';
import type { Db } from '../core/db';
import type { SiteOptions } from '../core/options';
import type { RequestContext } from '../core/request';
import type { CommentRow, ContentRow, MetaRow } from '../repo/content';

type Row = ContentRow | MetaRow | CommentRow | Record<string, any>;

export interface RowsInit {
  db: Db;
  options: SiteOptions;
  request: RequestContext;
  echo: (value: unknown) => void;
  rows?: Row[];
  loader?: () => Promise<Row[]>;
  kind?: 'contents' | 'metas' | 'comments' | 'dates';
  archiveDateFormat?: string;
}

/** Host object backing `Widget\Contents\Page\Rows`, `Contents\Post\Recent`, ... */
export class RowsWidget implements PhpHost {
  readonly [PHP_HOST] = true as const;
  private readonly db: Db;
  private readonly options: SiteOptions;
  private readonly request: RequestContext;
  private readonly echo: (value: unknown) => void;
  private readonly loader?: () => Promise<Row[]>;
  private readonly kind: 'contents' | 'metas' | 'comments' | 'dates';
  private readonly archiveDateFormat: string;

  private rows: Row[] | null;
  private index = -1;
  private currentRow: Row | null = null;

  constructor(init: RowsInit) {
    this.db = init.db;
    this.options = init.options;
    this.request = init.request;
    this.echo = init.echo;
    this.loader = init.loader;
    this.rows = init.rows ?? null;
    this.kind = init.kind ?? 'contents';
    this.archiveDateFormat = init.archiveDateFormat ?? 'F Y';
  }

  async ensure(): Promise<void> {
    if (this.rows === null && this.loader) this.rows = await this.loader();
  }

  async to(): Promise<this> {
    return this;
  }

  async have(): Promise<boolean> {
    await this.ensure();
    return (this.rows?.length ?? 0) > 0;
  }

  async next(): Promise<boolean> {
    await this.ensure();
    if (!this.rows) return false;
    if (this.index + 1 >= this.rows.length) return false;
    this.index++;
    this.currentRow = this.rows[this.index];
    return true;
  }

  async permalink(): Promise<void> {
    this.echo(this.permalinkValue());
  }

  private permalinkValue(): string {
    const row = this.currentRow;
    if (!row) return this.options.derived.siteUrl;
    if (this.kind === 'dates') return String((row as { permalink: string }).permalink);
    if (this.kind === 'contents') {
      const content = row as ContentRow;
      if (content.type === 'page') return this.options.router.url('page', { slug: content.slug ?? '' }, this.options.derived.index);
      if (content.type === 'attachment') return this.options.router.url('attachment', { cid: String(content.cid) }, this.options.derived.index);
      return this.options.router.url('post', { cid: String(content.cid) }, this.options.derived.index);
    }
    if (this.kind === 'metas') {
      const meta = row as MetaRow;
      return this.options.router.url(meta.type === 'tag' ? 'tag' : 'category', { slug: meta.slug }, this.options.derived.index);
    }
    const comment = row as CommentRow;
    return `${this.options.router.url('post', { cid: String(comment.cid) }, this.options.derived.index)}#comment-${comment.coid}`;
  }

  async title(): Promise<void> {
    const row = this.currentRow as ContentRow | null;
    this.echo(escapeHtml(row?.title ?? ''));
  }

  async name(): Promise<void> {
    const row = this.currentRow as MetaRow | null;
    this.echo(escapeHtml(row?.name ?? ''));
  }

  async date(format?: string | null): Promise<void> {
    const row = this.currentRow as ContentRow | null;
    if (!row) return;
    const fmt = format || (this.kind === 'dates' ? this.archiveDateFormat : String(this.options.get('postDateFormat') ?? 'F j, Y'));
    this.echo(dateFormat(row.created, fmt, Number(this.options.get('timezone') ?? 0)));
  }

  async count(): Promise<void> {
    const row = this.currentRow as MetaRow | null;
    this.echo(String(row?.count ?? 0));
  }

  async author(): Promise<void> {
    const row = this.currentRow as CommentRow | null;
    this.echo(escapeHtml(row?.author ?? ''));
  }

  async excerpt(length = 35, trim = '...'): Promise<void> {
    const row = this.currentRow as CommentRow | null;
    const plain = (row?.text ?? '').replace(/<[^>]*>/g, '');
    const chars = [...plain];
    this.echo(escapeHtml(chars.length > Number(length) ? chars.slice(0, Number(length)).join('') + String(trim) : plain));
  }

  async parse(template: string): Promise<void> {
    await this.ensure();
    const rows = this.rows ?? [];
    const html = rows
      .map((row) => {
        let out = template;
        const content = row as ContentRow;
        const meta = row as MetaRow;
        out = out.replace(/\{permalink\}/g, this.permalinkFor(row));
        out = out.replace(/\{title\}/g, escapeHtml(content.title ?? meta.name ?? ''));
        out = out.replace(/\{name\}/g, escapeHtml(meta.name ?? ''));
        out = out.replace(/\{slug\}/g, escapeHtml(content.slug ?? meta.slug ?? ''));
        out = out.replace(/\{count\}/g, String(meta.count ?? 0));
        out = out.replace(/\{description\}/g, escapeHtml(meta.description ?? ''));
        out = out.replace(
          /\{date\}/g,
          dateFormat(Number(content.created ?? 0), this.archiveDateFormat, Number(this.options.get('timezone') ?? 0))
        );
        return out;
      })
      .join('\n');
    this.echo(html);
  }

  private permalinkFor(row: Row): string {
    const saved = this.currentRow;
    this.currentRow = row;
    const value = this.permalinkValue();
    this.currentRow = saved;
    return value;
  }

  /** Widget\Metas\Category\Rows::listCategories($options) */
  async listCategories(option: unknown = ''): Promise<void> {
    await this.ensure();
    const config = parseOption(option);
    const wrapTag = config.wrapTag || 'ul';
    const wrapClass = config.wrapClass || 'category-list';
    const itemTag = config.itemTag || 'li';
    const parts: string[] = [`<${wrapTag}${wrapClass ? ` class="${wrapClass}"` : ''}>`];
    for (const row of this.rows ?? []) {
      const meta = row as MetaRow;
      const link = this.options.router.url('category', { slug: meta.slug }, this.options.derived.index);
      const count = config.showCount ? ` <span class="count">(${meta.count})</span>` : '';
      parts.push(`<${itemTag}><a href="${link}">${escapeHtml(meta.name)}</a>${count}</${itemTag}>`);
    }
    parts.push(`</${wrapTag}>`);
    this.echo(parts.join('\n'));
  }

  phpGet(name: string): unknown {
    const row = this.currentRow as Record<string, any> | null;
    if (!row) return null;
    if (name === 'slug') return row.slug ?? '';
    if (name === 'cid') return row.cid ?? 0;
    if (name === 'coid') return row.coid ?? 0;
    if (name === 'mid') return row.mid ?? 0;
    if (name === 'title' || name === 'name') return row.title ?? row.name ?? '';
    if (name === 'count') return row.count ?? 0;
    if (name === 'created') return row.created ?? 0;
    if (name === 'permalink') return this.permalinkValue();
    return null;
  }

  phpCall(name: string, args: unknown[]): unknown {
    if (name === 'to') return this;
    const fn = (this as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
    if (typeof fn === 'function') return fn.apply(this, args);
    return undefined;
  }
}
