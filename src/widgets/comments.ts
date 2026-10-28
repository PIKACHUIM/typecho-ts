import { PHP_HOST, type PhpHost } from '../../php-compat/host';
import { PhpArray } from '../../php-compat/values';
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
  private roots: CommentNode[] = [];
  private visible: CommentNode[] = [];
  private currentPage = 1;
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
    if (this.rows !== null) return;
    this.rows = await listComments(this.db, this.cid);
    const threaded = this.options.get('commentsThreaded') === '1' || this.options.get('commentsThreaded') === true;
    const maxLevels = Math.max(1, Number(this.options.get('commentsMaxNestingLevels')) || 5);
    this.roots = commentTree(this.rows, threaded, maxLevels);
    if (String(this.options.get('commentsOrder') ?? '').toUpperCase() === 'DESC') {
      const reverse = (nodes: CommentNode[]) => {
        nodes.reverse();
        for (const node of nodes) reverse(node.children);
      };
      reverse(this.roots);
    }

    const size = this.pageSize();
    const match = this.options.router.match(this.request.pathInfo);
    const requested = match?.route.name === 'comment_page'
      ? match.params?.commentPage
      : this.request.query.get('commentPage');
    const parsed = requested && /^\d+$/.test(requested) ? Number(requested) : 0;
    const totalPages = Math.max(1, Math.ceil(this.roots.length / size));
    this.currentPage = Number.isSafeInteger(parsed) && parsed > 0 ? parsed
      : this.options.get('commentsPageDisplay') === 'last' ? totalPages : 1;
    if (this.options.get('commentsPageBreak') === '1' || this.options.get('commentsPageBreak') === true) {
      this.visible = this.roots.slice((this.currentPage - 1) * size, this.currentPage * size);
    } else {
      this.visible = this.roots;
    }
  }

  private pageSize(): number {
    const size = Number(this.options.get('commentsPageSize'));
    return Number.isSafeInteger(size) && size > 0 ? size : 10;
  }

  private parentPath(): string {
    const match = this.options.router.match(this.request.pathInfo);
    const path = match?.route.name === 'comment_page' ? match.params?.permalink ?? '' : this.request.pathInfo;
    const parent = this.options.router.match(path);
    if (parent && ['post', 'page', 'attachment'].includes(parent.route.name)) {
      return this.options.router.url(parent.route.name, parent.params, '');
    }
    return this.options.router.url('post', { cid: String(this.cid) }, '');
  }

  private parentUrl(): string {
    const path = this.parentPath();
    return `${String(this.options.derived.index).replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  private pageUrl(page: number): string {
    const params = { permalink: this.parentPath().replace(/\/+$/, ''), cid: String(this.cid), commentPage: String(page) };
    return `${this.options.router.url('comment_page', params, this.options.derived.index)}#comments`;
  }

  async to(): Promise<this> {
    return this;
  }

  async have(): Promise<boolean> {
    await this.load();
    return this.visible.length > 0;
  }

  async next(): Promise<boolean> {
    await this.load();
    if (this.index + 1 >= this.visible.length) return false;
    this.index++;
    this.currentRow = this.visible[this.index].row;
    return true;
  }

  async permalink(): Promise<void> {
    const row = this.currentRow;
    if (!row) return;
    this.echo(`${this.parentUrl()}#comment-${row.coid}`);
  }

  async author(autoLink: boolean | null = null, noFollow: boolean | null = null): Promise<void> {
    const row = this.currentRow;
    if (!row) return;
    const name = escapeHtml(row.author ?? '');
    const shouldLink = autoLink === null ? !!row.url : autoLink;
    if (shouldLink && row.url && /^https?:\/\//i.test(row.url)) {
      const rel = noFollow ? ' rel="nofollow"' : '';
      this.echo(`<a href="${escapeHtml(row.url)}"${rel}>${name}</a>`);
    } else {
      this.echo(name);
    }
  }

  async excerpt(length = 100, trim = '...'): Promise<void> {
    const row = this.currentRow;
    if (!row) return;
    const plain = commentExcerptText(row.text ?? '');
    this.echo(escapeHtml(subStr(plain, 0, length, trim)));
  }

  async date(format?: string | null): Promise<void> {
    const row = this.currentRow;
    if (!row) return;
    const fmt = format || String(this.options.get('commentDateFormat') ?? 'F jS, Y \a\t h:ia');
    this.echo(dateFormat(row.created, fmt, Number(this.options.get('timezone') ?? 0)));
  }

  async content(): Promise<void> {
    this.echo(safeCommentHtml(this.currentRow?.text ?? ''));
  }

  async listComments(_config?: unknown): Promise<void> {
    await this.load();
    if (this.visible.length === 0) return;
    const parentUrl = this.parentUrl();
    const render = (nodes: CommentNode[]): string => nodes.map((node) => renderComment(
      node.row,
      this.options,
      node.children.length > 0 ? `<div class="comment-children"><ol class="comment-list">${render(node.children)}</ol></div>` : '',
      node.depth,
      parentUrl
    )).join('\n');
    this.echo(`<ol class="comment-list">${render(this.visible)}</ol>`);
    if (this.allowComment && (this.options.get('commentsThreaded') === '1' || this.options.get('commentsThreaded') === true)) {
      this.echo(replyScript());
    }
  }

  async pageNav(prev = '&laquo;', next = '&raquo;', splitPage = 3, splitWord = '...', config?: unknown): Promise<void> {
    await this.load();
    if (this.options.get('commentsPageBreak') !== '1' && this.options.get('commentsPageBreak') !== true) return;
    const totalPages = Math.ceil(this.roots.length / this.pageSize());
    if (totalPages <= 1 || !this.options.router.get('comment_page')) return;

    const template = config instanceof PhpArray ? config.toObject()
      : typeof config === 'string' ? Object.fromEntries(new URLSearchParams(config))
      : config && typeof config === 'object' ? config as Record<string, unknown> : {};
    const tag = (value: unknown, fallback: string): string => {
      const name = String(value ?? fallback);
      return /^(?:ol|ul|li|div|span|nav)$/.test(name) ? name : fallback;
    };
    const wrapTag = tag(template.wrapTag, 'ol');
    const itemTag = tag(template.itemTag, 'li');
    const textTag = tag(template.textTag, 'span');
    const wrapClass = escapeHtml(template.wrapClass ?? 'page-navigator');
    const currentClass = escapeHtml(template.currentClass ?? 'current');
    const prevClass = escapeHtml(template.prevClass ?? 'prev');
    const nextClass = escapeHtml(template.nextClass ?? 'next');
    const item = (body: string, className = '') => `<${itemTag}${className ? ` class="${className}"` : ''}>${body}</${itemTag}>`;
    const link = (page: number, label: string) => `<a href="${escapeHtml(this.pageUrl(page))}">${label}</a>`;
    const from = Math.max(1, this.currentPage - Math.max(0, splitPage));
    const to = Math.min(totalPages, this.currentPage + Math.max(0, splitPage));
    const parts: string[] = [`<${wrapTag}${wrapClass ? ` class="${wrapClass}"` : ''}>`];
    if (this.currentPage > 1) parts.push(item(link(this.currentPage - 1, prev === '&laquo;' ? '&laquo;' : escapeHtml(prev)), prevClass));
    if (from > 1) {
      parts.push(item(link(1, '1')));
      if (from > 2) parts.push(item(`<${textTag}>${escapeHtml(splitWord)}</${textTag}>`));
    }
    for (let page = from; page <= to; page++) {
      parts.push(item(link(page, String(page)), page === this.currentPage ? currentClass : ''));
    }
    if (to < totalPages) {
      if (to < totalPages - 1) parts.push(item(`<${textTag}>${escapeHtml(splitWord)}</${textTag}>`));
      parts.push(item(link(totalPages, String(totalPages))));
    }
    if (this.currentPage < totalPages) parts.push(item(link(this.currentPage + 1, next === '&raquo;' ? '&raquo;' : escapeHtml(next)), nextClass));
    parts.push(`</${wrapTag}>`);
    this.echo(parts.join(''));
  }

  async cancelReply(): Promise<void> {
    this.echo(`<a rel="nofollow" id="cancel-comment-reply-link" href="${escapeHtml(this.parentUrl())}#${escapeHtml(this.respondId)}" style="display:none;">取消回复</a>`);
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

}

interface CommentNode {
  row: CommentRow;
  parent: CommentNode | null;
  children: CommentNode[];
  depth: number;
}

function commentTree(rows: CommentRow[], threaded: boolean, maxLevels: number): CommentNode[] {
  const nodes = new Map(rows.map((row) => [row.coid, { row, parent: null, children: [], depth: 0 } as CommentNode]));
  const roots: CommentNode[] = [];
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const attach = (node: CommentNode): void => {
    if (visited.has(node.row.coid)) return;
    if (visiting.has(node.row.coid)) return;
    visiting.add(node.row.coid);
    let parent = threaded ? nodes.get(node.row.parent) : undefined;
    if (parent && parent !== node && !visiting.has(parent.row.coid)) {
      attach(parent);
      while (parent && parent.depth >= maxLevels - 1) parent = parent.parent ?? undefined;
    } else {
      parent = undefined;
    }
    node.parent = parent ?? null;
    node.depth = parent ? parent.depth + 1 : 0;
    if (parent) parent.children.push(node);
    else roots.push(node);
    visiting.delete(node.row.coid);
    visited.add(node.row.coid);
  };
  for (const row of rows) attach(nodes.get(row.coid)!);
  return roots;
}

export function renderComment(row: CommentRow, options: SiteOptions, children = '', depth = 0, parentUrl?: string): string {
  const permalink = parentUrl ?? options.router.url('post', { cid: String(row.cid) }, options.derived.index);
  const author = escapeHtml(row.author ?? '');
  const date = dateFormat(row.created, String(options.get('commentDateFormat') ?? 'F jS, Y \a\t h:ia'), Number(options.get('timezone') ?? 0));
  const text = safeCommentHtml(row.text ?? '');
  const role = row.authorId ? row.authorId === row.ownerId ? ' comment-by-author' : ' comment-by-user' : '';
  const level = depth > 0 ? `comment-child comment-level-${depth % 2 ? 'odd' : 'even'}` : 'comment-parent';
  const nesting = Number(options.get('commentsMaxNestingLevels')) || 5;
  const canReply = (options.get('commentsThreaded') === '1' || options.get('commentsThreaded') === true) && depth < nesting - 1;
  const reply = canReply ? `<div class="comment-reply"><a rel="nofollow" data-reply-to="${row.coid}" href="${escapeHtml(permalink)}#comment-${row.cid}">回复</a></div>` : '';
  return `<li id="comment-${row.coid}" class="comment-body ${level}${role}">
<article class="comment-body">
    <footer class="comment-meta">
        <div class="comment-author vcard">
            <span class="fn">${author}</span>
        </div>
        <div class="comment-metadata">
            <a href="${escapeHtml(permalink)}#comment-${row.coid}"><time datetime="${new Date(row.created * 1000).toISOString()}">${date}</time></a>
        </div>
    </footer>
    <div class="comment-content">
        ${text}
    </div>
    ${reply}
</article>${children ? `\n${children}` : ''}
</li>`;
}

function replyScript(): string {
  return `<script>document.addEventListener('DOMContentLoaded',function(){
var list=document.getElementById('comments');
var form=document.getElementById('comment-form');
if(!list||!form||form.dataset.replyReady)return;
var response=form.closest('.respond')||form.parentElement;
if(!response||!response.parentNode)return;
form.dataset.replyReady='1';
var marker=document.createComment('comment-form-position');
response.parentNode.insertBefore(marker,response);
var field=form.querySelector('input[name="parent"]');
if(!field){field=document.createElement('input');field.type='hidden';field.name='parent';form.appendChild(field)}
field.value='0';
var cancel=document.getElementById('cancel-comment-reply-link');
list.addEventListener('click',function(event){
var source=event.target;
if(!(source instanceof Element))return;
var link=source.closest('a[data-reply-to]');
if(!link)return;
var id=link.getAttribute('data-reply-to');
if(!id||!/^[0-9]+$/.test(id))return;
var target=document.getElementById('comment-'+id);
if(!target||target.tagName!=='LI')return;
event.preventDefault();
field.value=id;
target.appendChild(response);
if(cancel)cancel.style.display='';
response.scrollIntoView({block:'center'});
});
if(cancel)cancel.addEventListener('click',function(event){
event.preventDefault();
field.value='0';
marker.parentNode.insertBefore(response,marker.nextSibling);
cancel.style.display='none';
});
});</script>`;
}

export function commentExcerptText(source: string): string {
  return decodeCommentEntities(source.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''));
}

function safeCommentHtml(source: string): string {
  const withLines = source.replace(/<br\s*\/?\s*>/gi, '\n');
  return escapeHtml(decodeCommentEntities(withLines)).replace(/\r\n?|\n/g, '<br />\n');
}

function decodeCommentEntities(source: string): string {
  return source.replace(/&(?:amp|lt|gt|quot|apos|#039|#(?:x[0-9a-f]+|[0-9]+));/gi, (entity) => {
    const code = entity.slice(1, -1).toLowerCase();
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#039': "'" };
    if (code in named) return named[code];
    const number = code.startsWith('#x') ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  });
}
