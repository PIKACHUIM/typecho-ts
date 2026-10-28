import { PHP_HOST, type PhpHost } from '../../php-compat/host';
import { PhpArray } from '../../php-compat/values';
import { dateFormat } from '../../php-compat/date';
import { escapeHtml, fixHtml, subStr, url as joinUrl } from '../core/common';
import type { Db } from '../core/db';
import type { SiteOptions } from '../core/options';
import type { RequestContext } from '../core/request';
import {
  countContents,
  findContent,
  findUser,
  listCategories,
  listContents,
  listPages,
  listTags,
  loadFields,
  contentHtml,
  type ContentRow,
  type FieldMap,
  type MetaRow,
  type UserRow,
} from '../repo/content';
import { CommentsWidget } from './comments';
import { RowsWidget } from './rows';

export interface ArchiveInit {
  db: Db;
  options: SiteOptions;
  request: RequestContext;
  echo: (value: unknown) => void;
  params?: Record<string, string> | null;
  /** Route name from the routing table (index, post, category, ...). */
  type?: string;
}

type ArchiveKind = 'index' | 'post' | 'page' | 'attachment' | 'category' | 'tag' | 'author' | 'search' | 'archive' | 'date' | 'front';

export class Archive implements PhpHost {
  readonly [PHP_HOST] = true as const;
  readonly db: Db;
  readonly options: SiteOptions;
  readonly request: RequestContext;
  private readonly echo: (value: unknown) => void;
  private readonly routeName: string;
  private readonly params: Record<string, string>;

  posts: ContentRow[] = [];
  total = 0;
  currentPage = 1;
  pageSize = 10;
  archiveType: ArchiveKind = 'index';
  archiveSlug = '';
  archiveSingle = false;
  notFound = false;
  archiveUrl = '';
  titleText = '';
  archiveDescription = '';
  archiveKeywords = '';
  archiveFeedUrl = '';
  archiveFeedRssUrl = '';
  archiveFeedAtomUrl = '';
  themeFile = '';
  makeSinglePageAsFrontPage = false;

  private index = -1;
  private currentRow: ContentRow | null = null;
  private categoriesCache: MetaRow[] = [];
  private tagsCache: MetaRow[] = [];
  private fieldsCache: FieldMap | null = null;
  private authorCache: UserRow | null = null;
  private loaded = false;
  private loading?: Promise<void>;
  private commentsCache: CommentsWidget | null = null;
  private pagesCache: RowsWidget | null = null;

  /** Set by the renderer so `need()` can execute sibling templates. */
  renderInclude?: (file: string) => Promise<void>;

  constructor(init: ArchiveInit) {
    this.db = init.db;
    this.options = init.options;
    this.request = init.request;
    this.echo = init.echo;
    this.routeName = init.type ?? 'index';
    this.params = init.params ?? {};
    this.pageSize = Number(init.options.text('pageSize', '10')) || 10;
    this.currentPage = Math.max(1, Number(this.params.page ?? this.request.query.get('page') ?? 1) || 1);
    this.archiveUrl = init.options.derived.siteUrl;
    this.archiveDescription = init.options.text('description');
    this.archiveKeywords = init.options.text('keywords');
    this.archiveFeedUrl = init.options.derived.feedUrl;
    this.archiveFeedRssUrl = init.options.derived.feedRssUrl;
    this.archiveFeedAtomUrl = init.options.derived.feedAtomUrl;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) this.loading = this.load();
    await this.loading;
    this.loaded = true;
  }

  private async load(): Promise<void> {
    const route = this.routeName;

    if (route === 'index' || route === 'index_page') {
      const frontPage = String(this.options.get('frontPage') ?? '');
      if (frontPage.startsWith('page:')) {
        const cid = Number(frontPage.slice(5));
        this.makeSinglePageAsFrontPage = true;
        await this.loadSingle({ cid, type: 'page' });
        return;
      }
      if (frontPage.startsWith('file:')) {
        const file = frontPage.slice(5);
        if (/^[a-zA-Z0-9_-]+\.php$/.test(file)) {
          this.themeFile = file;
          return;
        }
      }
      await this.loadList({ type: 'post' }, 'index');
      this.archiveUrl = this.options.router.url(route === 'index_page' ? 'index_page' : 'index', { page: String(this.currentPage) }, this.options.derived.index);
      return;
    }

    if (route === 'post' || route === 'attachment') {
      await this.loadSingle({ cid: Number(this.params.cid), type: route });
      return;
    }

    if (route === 'page') {
      await this.loadSingle(this.params.cid ? { cid: Number(this.params.cid), type: 'page' } : { slug: this.params.slug ?? '', type: 'page' });
      return;
    }

    if (route === 'category' || route === 'category_page') {
      const slug = this.params.slug ?? '';
      await this.loadList({ categorySlug: slug }, 'category');
      this.archiveSlug = slug;
      const metas = await listCategories(this.db);
      const meta = metas.find((m) => m.slug === slug);
      if (!meta) this.notFound = true;
      this.titleText = meta?.name ?? '';
      this.archiveDescription = meta?.description ?? '';
      this.archiveKeywords = meta?.name ?? '';
      this.archiveUrl = this.options.router.url('category', { slug }, this.options.derived.index);
      return;
    }

    if (route === 'tag' || route === 'tag_page') {
      const slug = this.params.slug ?? '';
      await this.loadList({ tagSlug: slug }, 'tag');
      this.archiveSlug = slug;
      const metas = await listTags(this.db);
      const meta = metas.find((m) => m.slug === slug);
      if (!meta) this.notFound = true;
      this.titleText = meta?.name ?? '';
      this.archiveDescription = meta?.description ?? '';
      this.archiveKeywords = meta?.name ?? '';
      this.archiveUrl = this.options.router.url('tag', { slug }, this.options.derived.index);
      return;
    }

    if (route === 'author' || route === 'author_page') {
      const uid = Number(this.params.uid ?? 0);
      await this.loadList({ authorId: uid }, 'author');
      this.archiveSlug = String(uid);
      const user = await findUser(this.db, uid);
      if (!user) this.notFound = true;
      this.titleText = user?.screenName || user?.name || '';
      this.archiveUrl = this.options.router.url(route, { uid: String(uid), page: String(this.currentPage) }, this.options.derived.index);
      return;
    }

    if (route === 'search' || route === 'search_page') {
      const encodedKeywords = this.params.keywords ?? '';
      let keywords: string;
      try {
        keywords = decodeURIComponent(encodedKeywords);
      } catch {
        this.notFound = true;
        return;
      }
      await this.loadList({ keywords }, 'search');
      this.archiveSlug = keywords;
      this.titleText = keywords;
      this.archiveUrl = this.options.router.url(route, { keywords: encodedKeywords, page: String(this.currentPage) }, this.options.derived.index);
      return;
    }

    if (route.startsWith('archive_')) {
      const year = Number(this.params.year ?? 0);
      const month = this.params.month ? Number(this.params.month) : undefined;
      const day = this.params.day ? Number(this.params.day) : undefined;
      if (!Number.isInteger(year) || year < 1 || year > 9999 || (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) || (day !== undefined && (month === undefined || !Number.isInteger(day) || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()))) {
        this.notFound = true;
        return;
      }
      await this.loadList({ year, month, day }, 'date');
      this.archiveSlug = day ? 'day' : month ? 'month' : 'year';
      this.titleText = `${year}年${month ? `${month}月` : ''}${day ? `${day}日` : ''}`;
      const baseRoute = route.replace(/_page$/, '');
      const dateParams = { year: String(year).padStart(4, '0'), month: String(month ?? '').padStart(2, '0'), day: String(day ?? '').padStart(2, '0') };
      this.archiveUrl = this.options.router.url(baseRoute, dateParams, this.options.derived.index);
      return;
    }

    if ((route === 'archive' || route === 'archive_page') && String(this.options.get('frontPage') ?? '') !== 'recent' && Number(this.options.get('frontArchive')) === 1) {
      await this.loadList({ type: 'post' }, 'front');
      this.archiveUrl = this.options.router.url(route, { page: String(this.currentPage) }, this.options.derived.index);
      return;
    }

    this.notFound = true;
  }

  private async loadList(query: Parameters<typeof listContents>[1], kind: ArchiveKind): Promise<void> {
    this.archiveType = kind;
    this.archiveSingle = false;
    const limit = this.pageSize;
    const offset = (this.currentPage - 1) * limit;
    const filters = kind === 'date' ? { ...query, timezoneOffset: Number(this.options.get('timezone') ?? 0) } : query;
    this.posts = await listContents(this.db, { ...filters, limit, offset });
    this.total = await countContents(this.db, filters);
    if (this.currentPage > 1 && this.posts.length === 0) this.notFound = true;
    this.index = -1;
    this.currentRow = null;
  }

  private async loadSingle(filter: { cid?: number; slug?: string; type: 'post' | 'page' | 'attachment' }): Promise<void> {
    const row = await findContent(this.db, filter);
    if (!row) {
      this.posts = [];
      this.total = 0;
      this.notFound = true;
      return;
    }
    this.posts = [row];
    this.total = 1;
    this.archiveSingle = true;
    // Single views expose the row immediately: templates call content() before next().
    this.index = -1;
    this.currentRow = row;
    this.archiveSlug = row.slug ?? String(row.cid);
    this.archiveType = (row.type as ArchiveKind) ?? 'post';
    const router = this.options.router;
    const routeName = row.type === 'page' ? 'page' : row.type === 'attachment' ? 'attachment' : 'post';
    this.archiveUrl = router.url(routeName, row.type === 'page' ? { slug: row.slug ?? '' } : { cid: String(row.cid) }, this.options.derived.index);
    this.themeFile = row.template && /^[a-zA-Z0-9_-]+\.php$/.test(row.template) ? row.template : '';
    if (row.type === 'post' || row.type === 'page' || row.type === 'attachment') {
      if (!this.makeSinglePageAsFrontPage) {
        this.titleText = row.title ?? '';
        const plainText = contentHtml(row).split('<!--more-->')[0].replace(/<[^>]*>/g, '').trim().replace(/\n/g, '');
        this.archiveDescription = subStr(plainText || row.title || '', 0, 100);
        this.archiveKeywords = (await listTags(this.db, row.cid)).map((tag) => tag.name).join(',');
      }
    }
  }

  get current(): ContentRow | null {
    return this.currentRow;
  }

  // -------------------------------------------------------------- template API

  async next(): Promise<boolean> {
    await this.ensureLoaded();
    if (this.index + 1 >= this.posts.length) return false;
    this.index++;
    this.currentRow = this.posts[this.index];
    this.categoriesCache = [];
    this.tagsCache = [];
    this.fieldsCache = null;
    this.authorCache = null;
    this.commentsCache = null;
    return true;
  }

  async have(): Promise<boolean> {
    await this.ensureLoaded();
    return this.posts.length > 0;
  }

  is(type: string, slug?: string | null): boolean {
    const single = this.archiveSingle;
    const matched =
      type === this.archiveType ||
      ((single ? 'single' : 'archive') === type && this.archiveType !== 'index') ||
      (type === 'index' && this.makeSinglePageAsFrontPage);
    return matched && (!slug || slug === this.archiveSlug);
  }

  async need(file: string): Promise<void> {
    if (!this.renderInclude) throw new Error('renderInclude is not configured');
    await this.renderInclude(file);
  }

  private get row(): ContentRow | null {
    return this.currentRow ?? (this.archiveSingle ? this.posts[0] ?? null : null);
  }

  async title(length = 0, trim = '...'): Promise<void> {
    const row = this.row;
    if (!row) return;
    const title = row.title ?? '';
    this.echo(length > 0 ? subStr(title, 0, length, trim) : title);
  }

  async permalink(): Promise<void> {
    this.echo(await this.permalinkValue());
  }

  async permalinkValue(): Promise<string> {
    const row = this.row;
    if (!row) return this.archiveUrl || this.options.derived.siteUrl;
    const router = this.options.router;
    if (row.type === 'page') {
      return router.url('page', { slug: row.slug ?? '' }, this.options.derived.index);
    }
    if (row.type === 'attachment') {
      return router.url('attachment', { cid: String(row.cid) }, this.options.derived.index);
    }
    return router.url('post', { cid: String(row.cid) }, this.options.derived.index);
  }

  async content(more?: unknown): Promise<void> {
    const row = this.row;
    if (!row) return;
    const html = contentHtml(row);
    if (this.is('single')) {
      this.echo(html);
      return;
    }
    if (more !== null && more !== undefined && more !== false && (row.text ?? '').includes('<!--more-->')) {
      const [excerpt] = html.split('<!--more-->');
      const permalink = await this.permalinkValue();
      const title = escapeHtml(row.title ?? '');
      this.echo(`${fixHtml(excerpt)}<p class="more"><a href="${permalink}" title="${title}">${String(more)}</a></p>`);
      return;
    }
    this.echo(html);
  }

  async excerpt(length = 100, trim = '...'): Promise<void> {
    const row = this.row;
    if (!row) return;
    const html = contentHtml(row).split('<!--more-->')[0];
    const plain = html.replace(/<[^>]*>/g, '');
    this.echo(fixHtml(subStr(plain, 0, length, trim)));
  }

  async date(format?: string | null): Promise<void> {
    const row = this.row;
    if (!row) return;
    const fmt = format || String(this.options.get('postDateFormat') ?? 'F j, Y');
    this.echo(dateFormat(row.created, fmt, Number(this.options.get('timezone') ?? 0)));
  }

  async category(split = ',', link = true, fallback?: unknown): Promise<void> {
    const row = this.row;
    if (!row) return;
    if (this.categoriesCache.length === 0) this.categoriesCache = await listCategories(this.db, row.cid);
    const metas = this.categoriesCache;
    if (metas.length === 0) {
      if (fallback !== null && fallback !== undefined && fallback !== false) this.echo(String(fallback));
      return;
    }
    const parts = metas.map((meta) =>
      link ? `<a href="${this.metaUrl('category', meta)}">${meta.name}</a>` : meta.name
    );
    this.echo(parts.join(String(split)));
  }

  async tags(split = ',', link = true, fallback?: unknown): Promise<void> {
    const row = this.row;
    if (!row) return;
    if (this.tagsCache.length === 0) this.tagsCache = await listTags(this.db, row.cid);
    const metas = this.tagsCache;
    if (metas.length === 0) {
      if (fallback !== null && fallback !== undefined && fallback !== false) this.echo(String(fallback));
      return;
    }
    const parts = metas.map((meta) => (link ? `<a href="${this.metaUrl('tag', meta)}">${meta.name}</a>` : meta.name));
    this.echo(parts.join(String(split)));
  }

  private metaUrl(kind: 'category' | 'tag', meta: MetaRow): string {
    return this.options.router.url(kind, { slug: meta.slug }, this.options.derived.index);
  }

  async author(item = 'screenName'): Promise<void> {
    const row = this.row;
    if (!row) return;
    if (!this.authorCache) this.authorCache = await findUser(this.db, row.authorId);
    this.echo((this.authorCache as any)?.[item] ?? '');
  }

  async commentsNum(...args: unknown[]): Promise<void> {
    const row = this.row;
    if (!row) return;
    const num = Number(row.commentsNum ?? 0);
    const list = args.length > 0 ? args : ['%d'];
    const template = String(list[num] ?? list[list.length - 1] ?? '%d');
    this.echo(template.replace('%d', String(num)));
  }

  async comments(): Promise<CommentsWidget> {
    if (!this.commentsCache) {
      const row = this.row;
      this.commentsCache = new CommentsWidget({
        db: this.db,
        options: this.options,
        request: this.request,
        echo: this.echo,
        cid: row?.cid ?? 0,
        respondId: this.respondIdValue(),
        allowComment: await this.allow('comment'),
      });
    }
    return this.commentsCache;
  }

  async allow(...permissions: string[]): Promise<boolean> {
    const row = this.row;
    if (!row) return false;
    const options = this.options;
    let allow = true;
    for (const raw of permissions) {
      const permission = raw.toLowerCase();
      if (permission === 'comment' || permission === 'ping') {
        const timeout = Number(options.get('commentsPostTimeout') ?? 0);
        if (timeout > 0 && options.get('commentsAutoClose')) {
          if (Number(options.get('time')) - row.created > timeout) return false;
        }
        allow = allow && String((row as any)[`allow${permission[0].toUpperCase()}${permission.slice(1)}`]) === '1';
      } else {
        allow = allow && true;
      }
    }
    return allow;
  }

  respondIdValue(): string {
    return `comment-${this.row?.cid ?? 0}`;
  }

  async respondId(): Promise<void> {
    this.echo(this.respondIdValue());
  }

  async commentUrl(): Promise<void> {
    this.echo(joinUrl('/action/feedback', this.options.derived.index));
  }

  async remember(name: string, asReturn = false): Promise<unknown> {
    const key = `__typecho_remember_${name.toLowerCase()}`;
    const value = this.request.cookies.get(key) ?? '';
    if (asReturn) return value;
    this.echo(escapeHtml(value));
    return undefined;
  }

  async archiveTitle(defines: unknown = [], before = ' &raquo; ', end = ''): Promise<void> {
    await this.ensureLoaded();
    if (!this.titleText) return;
    let template = '%s';
    if (defines instanceof PhpArray && this.archiveType) {
      const defined = defines.get(this.archiveType);
      if (defined) template = String(defined);
    }
    const title = escapeHtml(this.titleText);
    this.echo(`${String(before)}${template.replace('%s', title)}${String(end)}`);
  }

  async keywords(split = ',', fallback = ''): Promise<void> {
    const keywords = this.archiveKeywords;
    this.echo(keywords ? escapeHtml(keywords).replace(/,/g, String(split)) : String(fallback));
  }

  async header(_rule?: string | null): Promise<void> {
    await this.ensureLoaded();
    const o = this.options;
    const allows: Record<string, string> = {
      description: escapeHtml(this.archiveDescription),
      keywords: escapeHtml(this.archiveKeywords),
      generator: o.text('generator'),
      template: o.text('theme'),
      pingback: o.derived.xmlRpcUrl,
      xmlrpc: `${o.derived.xmlRpcUrl}?rsd`,
      rss2: escapeHtml(this.archiveFeedUrl),
      rss1: escapeHtml(this.archiveFeedRssUrl),
      atom: escapeHtml(this.archiveFeedAtomUrl),
      social: '1',
    };
    const allowFeed = !this.is('single') || (await this.allow('feed')) || this.makeSinglePageAsFrontPage;
    const title = `${this.titleText ? `${escapeHtml(this.titleText)} &raquo; ` : ''}${escapeHtml(o.text('title'))}`;

    let header = '';
    if (this.is('single') && !this.is('index')) header += `<link rel="canonical" href="${this.archiveUrl}" />\n`;
    if (allows.pingback && Number(o.get('allowXmlRpc')) === 2) header += `<link rel="pingback" href="${allows.pingback}" />\n`;
    if (allows.xmlrpc && Number(o.get('allowXmlRpc')) > 0) header += `<link rel="EditURI" type="application/rsd+xml" title="RSD" href="${allows.xmlrpc}" />\n`;
    if (allows.rss2 && allowFeed) header += `<link rel="alternate" type="application/rss+xml" title="${title} &raquo; RSS 2.0" href="${allows.rss2}" />\n`;
    if (allows.rss1 && allowFeed) header += `<link rel="alternate" type="application/rdf+xml" title="${title} &raquo; RSS 1.0" href="${allows.rss1}" />\n`;
    if (allows.atom && allowFeed) header += `<link rel="alternate" type="application/atom+xml" title="${title} &raquo; ATOM 1.0" href="${allows.atom}" />\n`;
    if (allows.description) header += `<meta name="description" content="${allows.description}" />\n`;
    if (allows.keywords) header += `<meta name="keywords" content="${allows.keywords}" />\n`;
    if (allows.generator) header += `<meta name="generator" content="${allows.generator}" />\n`;
    if (allows.template) header += `<meta name="template" content="${allows.template}" />\n`;
    if (allows.social) {
      header += `<meta property="og:type" content="${this.is('single') ? 'article' : 'website'}" />\n`;
      header += `<meta property="og:url" content="${this.archiveUrl}" />\n`;
      header += `<meta name="twitter:title" property="og:title" itemprop="name" content="${escapeHtml(this.titleText || o.text('title'))}" />\n`;
      header += `<meta name="twitter:description" property="og:description" itemprop="description" content="${escapeHtml(this.archiveDescription || o.text('description'))}" />\n`;
      header += `<meta property="og:site_name" content="${escapeHtml(o.text('title'))}" />\n`;
      header += '<meta name="twitter:card" content="summary" />\n';
      header += `<meta name="twitter:domain" content="${escapeHtml(String(o.derived.siteDomain))}" />\n`;
    }
    this.echo(header);
  }

  async footer(): Promise<void> {
    // footer plugin hook
  }

  async pageNav(prev = '&laquo;', next = '&raquo;', splitPage = 3, splitWord = '...', config?: unknown): Promise<void> {
    await this.ensureLoaded();
    if (this.total <= this.pageSize) return;
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
    const label = (text: string) => escapeHtml(text).replace(/&amp;(laquo|raquo|hellip|nbsp);/g, '&$1;');
    const link = (page: number, text: string) => `<a href="${escapeHtml(this.pageUrl(page))}">${text}</a>`;
    const item = (html: string, className = '') => `<${itemTag}${className ? ` class="${className}"` : ''}>${html}</${itemTag}>`;
    const totalPage = Math.max(1, Math.ceil(this.total / this.pageSize));
    const current = this.currentPage;
    const from = Math.max(1, current - Math.max(0, splitPage));
    const to = Math.min(totalPage, current + Math.max(0, splitPage));
    const parts: string[] = [`<${wrapTag}${wrapClass ? ` class="${wrapClass}"` : ''}>`];

    if (current > 1) parts.push(item(link(current - 1, label(prev)), prevClass));
    if (from > 1) {
      parts.push(item(link(1, '1')));
      if (from > 2) parts.push(item(`<${textTag}>${label(splitWord)}</${textTag}>`));
    }
    for (let i = from; i <= to; i++) {
      parts.push(item(link(i, String(i)), i === current ? currentClass : ''));
    }
    if (to < totalPage) {
      if (to < totalPage - 1) parts.push(item(`<${textTag}>${label(splitWord)}</${textTag}>`));
      parts.push(item(link(totalPage, String(totalPage))));
    }
    if (current < totalPage) parts.push(item(link(current + 1, label(next)), nextClass));
    parts.push(`</${wrapTag}>`);
    this.echo(parts.join(''));
  }

  private pageUrl(page: number): string {
    const routeName = this.routeName.includes('_page') ? this.routeName : `${this.routeName}_page`;
    const params: Record<string, string> = { ...this.params, page: String(page) };
    if (this.routeName === 'page' || this.routeName === 'post') {
      return this.archiveUrl;
    }
    return this.options.router.url(routeName, params, this.options.derived.index);
  }

  async pageLink(word = '&laquo; Previous Entries', page = 'prev'): Promise<void> {
    await this.ensureLoaded();
    const target = page === 'prev' ? this.currentPage - 1 : this.currentPage + 1;
    if (target < 1 || target > Math.ceil(this.total / this.pageSize)) return;
    this.echo(`<a href="${this.pageUrl(target)}">${word}</a>`);
  }

  async thePrev(template?: string | null, fallback?: unknown): Promise<void> {
    const prev = await this.neighbour('prev');
    if (!prev) {
      if (fallback !== null && fallback !== undefined && fallback !== false) this.echo(String(fallback));
      return;
    }
    const permalink = await this.neighbourUrl(prev);
    const title = escapeHtml(prev.title ?? '');
    const html = template ? String(template).replace('%s', `<a href="${permalink}">${title}</a>`) : `<a href="${permalink}">${title}</a>`;
    this.echo(html);
  }

  async theNext(template?: string | null, fallback?: unknown): Promise<void> {
    const next = await this.neighbour('next');
    if (!next) {
      if (fallback !== null && fallback !== undefined && fallback !== false) this.echo(String(fallback));
      return;
    }
    const permalink = await this.neighbourUrl(next);
    const title = escapeHtml(next.title ?? '');
    const html = template ? String(template).replace('%s', `<a href="${permalink}">${title}</a>`) : `<a href="${permalink}">${title}</a>`;
    this.echo(html);
  }

  private async neighbour(direction: 'prev' | 'next'): Promise<ContentRow | null> {
    const row = this.row;
    if (!row) return null;
    if (direction === 'prev') {
      return this.db.first<ContentRow>(
        `SELECT * FROM table.contents WHERE type = 'post' AND status = 'publish' AND created < ? AND (password IS NULL OR password = '') ORDER BY created DESC LIMIT 1`,
        [Math.min(row.created, Math.floor(Date.now() / 1000))]
      );
    }
    return this.db.first<ContentRow>(
      `SELECT * FROM table.contents WHERE type = 'post' AND status = 'publish' AND created > ? AND created < ? AND (password IS NULL OR password = '') ORDER BY created ASC LIMIT 1`,
      [row.created, Math.floor(Date.now() / 1000)]
    );
  }

  private async neighbourUrl(row: ContentRow): Promise<string> {
    return this.options.router.url('post', { cid: String(row.cid) }, this.options.derived.index);
  }

  async related(): Promise<RowsWidget> {
    const row = this.row;
    if (!row) return new RowsWidget({ db: this.db, options: this.options, request: this.request, echo: this.echo, rows: [] });
    const tags = await listTags(this.db, row.cid);
    if (tags.length === 0) {
      return new RowsWidget({ db: this.db, options: this.options, request: this.request, echo: this.echo, rows: [] });
    }
    const rows = await listContents(this.db, { tagSlug: tags[0].slug, limit: 5 });
    return new RowsWidget({ db: this.db, options: this.options, request: this.request, echo: this.echo, rows: rows.filter((r) => r.cid !== row.cid) });
  }

  pages(): RowsWidget {
    if (!this.pagesCache) {
      this.pagesCache = new RowsWidget({
        db: this.db,
        options: this.options,
        request: this.request,
        echo: this.echo,
        loader: () => listPages(this.db),
      });
    }
    return this.pagesCache;
  }

  async fields(): Promise<PhpArray> {
    const row = this.row;
    if (!row) return new PhpArray();
    if (!this.fieldsCache) this.fieldsCache = await loadFields(this.db, row.cid);
    return new PhpArray(Object.entries(this.fieldsCache));
  }

  // ------------------------------------------------------------------- PhpHost

  phpGet(name: string): unknown {
    switch (name) {
      case 'options':
        return this.options;
      case 'author':
        return this.authorHost();
      case 'user':
        return this.userHost();
      case 'fields':
        return this.fieldsHost();
      case 'archiveType':
        return this.archiveType;
      case 'archiveSlug':
        return this.archiveSlug;
      case 'archiveUrl':
        return this.archiveUrl;
      case 'archiveDescription':
        return this.archiveDescription;
      case 'archiveKeywords':
        return this.archiveKeywords;
      case 'archiveFeedUrl':
        return this.archiveFeedUrl;
      case 'archiveFeedRssUrl':
        return this.archiveFeedRssUrl;
      case 'archiveFeedAtomUrl':
        return this.archiveFeedAtomUrl;
      case 'themeFile':
        return this.themeFile;
      case 'title':
        return this.currentRow?.title ?? '';
      case 'slug':
        return this.currentRow?.slug ?? '';
      case 'cid':
        return this.currentRow?.cid ?? 0;
      case 'created':
        return this.currentRow?.created ?? 0;
      case 'modified':
        return this.currentRow?.modified ?? 0;
      case 'commentsNum':
        return this.currentRow?.commentsNum ?? 0;
      case 'authorId':
        return this.currentRow?.authorId ?? 0;
      case 'text':
        return this.currentRow?.text ?? '';
      case 'type':
        return this.currentRow?.type ?? '';
      case 'template':
        return this.currentRow?.template ?? '';
      case 'password':
        return this.currentRow?.password ?? '';
      case 'date':
        return (this.currentRow?.created ?? 0) + Number(this.options.get('timezone') ?? 0);
      case 'total':
        return this.total;
      case 'currentPage':
        return this.currentPage;
      case 'pages':
        return this.pages();
      default:
        return null;
    }
  }

  phpCall(name: string, args: unknown[]): unknown {
    const call = (this as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
    if (typeof call === 'function') return call.apply(this, args);
    return null;
  }

  private authorHost(): PhpHost {
    const row = this.currentRow;
    const uid = row?.authorId ?? 0;
    return {
      [PHP_HOST]: true as const,
      phpGet: (name: string) => (name === 'uid' ? uid : null),
      phpCall: (name: string) => {
        if (name === 'permalink') {
          this.echo(this.options.router.url('author', { uid: String(uid) }, this.options.derived.index));
          return undefined;
        }
        return (async () => {
          if (!this.authorCache) this.authorCache = await findUser(this.db, uid);
          if (name === 'screenName' || name === 'name') this.echo((this.authorCache as any)?.[name] ?? '');
          return undefined;
        })();
      },
    };
  }

  private userHost(): PhpHost {
    const user = this.options.currentUser;
    const groups = ['administrator', 'editor', 'contributor', 'subscriber', 'visitor'] as const;
    const pass = (group: unknown): boolean => {
      const actual = groups.indexOf(user?.group as (typeof groups)[number]);
      const required = groups.indexOf(String(group) as (typeof groups)[number]);
      return actual >= 0 && required >= 0 && actual <= required;
    };
    return {
      [PHP_HOST]: true as const,
      phpGet: (name: string) => {
        if (name === 'uid') return user?.uid ?? 0;
        if (name === 'hasLogin') return user !== null;
        if (name === 'pass') return pass;
        if (name === 'name' || name === 'screenName' || name === 'mail' || name === 'group') return escapeHtml(user?.[name] ?? '');
        return null;
      },
      phpCall: (name: string, args: unknown[]) => {
        if (name === 'hasLogin') return user !== null;
        if (name === 'pass') return pass(args[0]);
        if (name === 'screenName' || name === 'name' || name === 'mail' || name === 'group') {
          this.echo(escapeHtml(user?.[name] ?? ''));
          return undefined;
        }
        if (name === 'permalink') {
          this.echo(user ? this.options.router.url('author', { uid: String(user.uid) }, this.options.derived.index) : this.options.derived.siteUrl);
          return undefined;
        }
        return undefined;
      },
    };
  }

  private fieldsHost(): PhpHost {
    const cache: FieldMap = {};
    return {
      [PHP_HOST]: true as const,
      phpGet: (name: string) => cache[name] ?? null,
      phpCall: () => null,
      phpIsset: (name: string) => name in cache,
    };
  }
}
