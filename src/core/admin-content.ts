import { escapeHtml } from './common';
import { renderAdminShell } from './admin-ui';
import { findCurrentUser, securityToken, type AuthUser } from './auth';
import type { Db } from './db';
import type { ContentRow } from '../repo/content';
import { currentRequestUrl, type RequestContext } from './request';

const CONTENT_TYPES = ['post', 'page'] as const;
type ContentType = (typeof CONTENT_TYPES)[number];
type TaxonomyType = 'category' | 'tag';
interface Taxonomy { mid: number; name: string; type: TaxonomyType }

export async function handleAdminContentRequest(db: Db, request: RequestContext, secret: string): Promise<Response | null> {
  const path = request.pathInfo.replace(/\/+$/, '') || '/';
  const listType: ContentType | null = path === '/admin/manage-posts.php' ? 'post' : path === '/admin/manage-pages.php' ? 'page' : null;
  const editType: ContentType | null = path === '/admin/write-post.php' ? 'post' : path === '/admin/write-page.php' ? 'page' : null;

  if (listType) {
    const user = await requireAdministrator(db, request);
    if (user instanceof Response) return user;
    if (request.method !== 'GET') return textResponse('Method Not Allowed', 405);
    const page = Math.min(100000, Math.max(1, Number(request.query.get('page') ?? 1) || 1));
    const rows = await db.all<ContentRow>(
      'SELECT * FROM table.contents WHERE type = ? ORDER BY created DESC, cid DESC LIMIT 51 OFFSET ?',
      [listType, (page - 1) * 50]
    );
    return htmlResponse(contentListPage(request, rows, listType, user, secret, page));
  }

  if (editType) {
    const user = await requireAdministrator(db, request);
    if (user instanceof Response) return user;
    if (request.method !== 'GET') return textResponse('Method Not Allowed', 405);
    const cid = Number(request.query.get('cid') ?? 0);
    let row: ContentRow | null = null;
    if (cid > 0 && Number.isSafeInteger(cid)) {
      row = await db.first<ContentRow>('SELECT * FROM table.contents WHERE cid = ? AND type = ?', [cid, editType]);
      if (!row) return textResponse('Content not found', 404);
    } else if (request.query.has('cid')) return textResponse('Invalid content ID', 400);
    const action = `${request.rootUrl}/action/contents-${editType}-edit?_=${securityToken(secret, currentRequestUrl(request), user)}`;
    const metas = editType === 'post' ? await getTaxonomies(db) : [];
    const selected = row && editType === 'post'
      ? (await db.all<{ mid: number }>('SELECT mid FROM table.relationships WHERE cid = ?', [row.cid])).map((item) => Number(item.mid))
      : [];
    const defaultCategory = editType === 'post' ? await getDefaultCategoryId(db, metas) : null;
    return htmlResponse(contentEditorPage(request, row, editType, action, metas, selected, defaultCategory));
  }

  const saveMatch = /^\/action\/contents-(post|page)-edit$/.exec(path);
  const deleteMatch = /^\/action\/contents-(post|page)-delete$/.exec(path);
  if (!saveMatch && !deleteMatch) return null;
  if (request.method !== 'POST') return textResponse('Method Not Allowed', 405);
  const user = await requireAdministrator(db, request);
  if (user instanceof Response) return user;
  const form = await request.body?.();
  if (!form || !validCsrf(request, form, user, secret)) return textResponse('CSRF validation failed', 403);
  const type = (saveMatch?.[1] ?? deleteMatch?.[1]) as ContentType;
  return saveMatch ? saveContent(db, request, form, user, type) : deleteContent(db, request, form, type);
}

async function requireAdministrator(db: Db, request: RequestContext): Promise<AuthUser | Response> {
  const user = await findCurrentUser(db, request);
  if (!user) return redirect(`${request.rootUrl}/admin/login.php?referer=${encodeURIComponent(currentRequestUrl(request))}`);
  if (user.group !== 'administrator') return textResponse('Forbidden', 403);
  return user;
}

function validCsrf(request: RequestContext, form: FormData, user: AuthUser, secret: string): boolean {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.url.origin) return false;
  if (!request.referer) return false;
  try {
    if (new URL(request.referer).origin !== request.url.origin) return false;
  } catch {
    return false;
  }
  const token = request.query.get('_') ?? String(form.get('_') ?? '');
  const expected = securityToken(secret, request.referer, user);
  if (token.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

async function saveContent(db: Db, request: RequestContext, form: FormData, user: AuthUser, type: ContentType): Promise<Response> {
  const rawCid = String(form.get('cid') ?? '0');
  if (!/^\d+$/.test(rawCid)) return textResponse('Invalid content ID', 400);
  const cid = Number(rawCid);
  if (!Number.isSafeInteger(cid)) return textResponse('Invalid content ID', 400);
  const title = String(form.get('title') ?? '').trim();
  const text = String(form.get('text') ?? '');
  const status = String(form.get('status') ?? 'publish');
  const slug = String(form.get('slug') ?? '').trim() || `${type}-${crypto.randomUUID().slice(0, 12)}`;
  const allowComment = form.get('allowComment') === '1' ? '1' : '0';
  if (!title || title.length > 150) return textResponse('Title is required and must not exceed 150 characters.', 400);
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(slug)) return textResponse('Slug must contain only letters, numbers, hyphens, and underscores.', 400);
  if (!['publish', 'draft', 'private'].includes(status)) return textResponse('Invalid content status', 400);
  if (new TextEncoder().encode(text).length > 1024 * 1024) return textResponse('Content exceeds 1 MB.', 413);
  const existing = cid ? await db.first<{ cid: number }>('SELECT cid FROM table.contents WHERE cid = ? AND type = ?', [cid, type]) : null;
  if (cid && !existing) return textResponse('Content not found', 404);
  const conflict = await db.first<{ cid: number }>('SELECT cid FROM table.contents WHERE slug = ? AND cid != ?', [slug, cid]);
  if (conflict) return textResponse('Slug already exists.', 409);

  let selected: number[] = [];
  let previous: number[] = [];
  if (type === 'post') {
    const categories = parseIds(form.getAll('category[]'));
    const tags = parseIds(form.getAll('tags[]'));
    if (!categories || !tags) return textResponse('Invalid category or tag ID', 400);
    const metas = await getTaxonomies(db);
    const byId = new Map(metas.map((meta) => [Number(meta.mid), meta.type]));
    if (categories.some((mid) => byId.get(mid) !== 'category') || tags.some((mid) => byId.get(mid) !== 'tag')) {
      return textResponse('Category or tag not found', 400);
    }
    if (categories.length === 0) {
      const defaultMid = await getDefaultCategoryId(db, metas);
      if (defaultMid !== null) categories.push(defaultMid);
    }
    selected = [...categories, ...tags];
    if (cid) {
      previous = (await db.all<{ mid: number }>(
        "SELECT r.mid FROM table.relationships r JOIN table.metas m ON m.mid = r.mid WHERE r.cid = ? AND m.type IN ('category', 'tag')", [cid]
      )).map((row) => Number(row.mid));
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  if (cid) {
    statements.push({ sql: 'UPDATE table.contents SET title = ?, slug = ?, modified = ?, text = ?, status = ?, allowComment = ? WHERE cid = ? AND type = ?', params: [title, slug, now, text, status, allowComment, cid, type] });
  } else {
    statements.push({
      sql: `INSERT INTO table.contents (title, slug, created, modified, text, "order", authorId, template, type, status, password, commentsNum, allowComment, allowPing, allowFeed, parent)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, NULL, 0, ?, '1', '1', 0)`,
      params: [title, slug, now, now, text, user.uid, type, status, allowComment],
    });
  }
  const removed = previous.filter((mid) => !selected.includes(mid));
  const added = selected.filter((mid) => !previous.includes(mid));
  for (const mid of removed) statements.push({ sql: 'DELETE FROM table.relationships WHERE cid = ? AND mid = ?', params: [cid, mid] });
  for (const mid of added) {
    statements.push(cid
      ? { sql: 'INSERT INTO table.relationships (cid, mid) VALUES (?, ?)', params: [cid, mid] }
      : { sql: "INSERT INTO table.relationships (cid, mid) SELECT cid, ? FROM table.contents WHERE slug = ? AND type = 'post'", params: [mid, slug] });
  }
  for (const mid of [...removed, ...added]) {
    statements.push({ sql: 'UPDATE table.metas SET count = (SELECT COUNT(*) FROM table.relationships WHERE mid = ?) WHERE mid = ?', params: [mid, mid] });
  }
  const result = await db.batch(statements);
  const targetCid = cid || Number(result[0]?.meta.last_row_id ?? 0);
  if (!targetCid) return textResponse('Could not save content.', 500);
  return redirect(`${request.rootUrl}/admin/write-${type}.php?cid=${targetCid}&saved=1`);
}

async function deleteContent(db: Db, request: RequestContext, form: FormData, type: ContentType): Promise<Response> {
  const rawCid = String(form.get('cid') ?? '');
  if (!/^[1-9]\d*$/.test(rawCid) || !Number.isSafeInteger(Number(rawCid))) return textResponse('Invalid content ID', 400);
  const cid = Number(rawCid);
  const existing = await db.first<{ cid: number }>('SELECT cid FROM table.contents WHERE cid = ? AND type = ?', [cid, type]);
  if (!existing) return textResponse('Content not found', 404);
  const related = await db.all<{ mid: number }>('SELECT mid FROM table.relationships WHERE cid = ?', [cid]);
  const statements: Array<{ sql: string; params: unknown[] }> = [
    { sql: 'DELETE FROM table.relationships WHERE cid = ?', params: [cid] },
    { sql: 'DELETE FROM table.fields WHERE cid = ?', params: [cid] },
    { sql: 'DELETE FROM table.comments WHERE cid = ?', params: [cid] },
    { sql: 'DELETE FROM table.contents WHERE cid = ? AND type = ?', params: [cid, type] },
  ];
  for (const mid of new Set(related.map((item) => Number(item.mid)))) {
    statements.push({ sql: 'UPDATE table.metas SET count = (SELECT COUNT(*) FROM table.relationships WHERE mid = ?) WHERE mid = ?', params: [mid, mid] });
  }
  await db.batch(statements);
  return redirect(`${request.rootUrl}/admin/manage-${type === 'post' ? 'posts' : 'pages'}.php?deleted=1`);
}

function parseIds(values: ReturnType<FormData['getAll']>): number[] | null {
  if (values.length > 100) return null;
  const ids: number[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return null;
    if (!ids.includes(Number(value))) ids.push(Number(value));
  }
  return ids;
}

async function getTaxonomies(db: Db): Promise<Taxonomy[]> {
  return db.all<Taxonomy>("SELECT mid, name, type FROM table.metas WHERE type IN ('category', 'tag') ORDER BY type, \"order\", mid");
}

async function getDefaultCategoryId(db: Db, metas: Taxonomy[]): Promise<number | null> {
  const categories = metas.filter((item) => item.type === 'category');
  const option = await db.first<{ value: string }>("SELECT value FROM table.options WHERE name = 'defaultCategory' AND \"user\" = 0");
  const configured = Number(option?.value);
  return categories.some((item) => Number(item.mid) === configured)
    ? configured : categories.reduce<number | null>((first, item) => first === null ? Number(item.mid) : Math.min(first, Number(item.mid)), null);
}

function contentListPage(request: RequestContext, rows: ContentRow[], type: ContentType, user: AuthUser, secret: string, page: number): string {
  const title = type === 'post' ? '文章' : '页面';
  const listPath = `manage-${type === 'post' ? 'posts' : 'pages'}.php`;
  const visible = rows.slice(0, 50);
  const entries = visible.map((row) => {
    const editor = `${request.rootUrl}/admin/write-${type}.php?cid=${row.cid}`;
    const action = `${request.rootUrl}/action/contents-${type}-delete?_=${securityToken(secret, currentRequestUrl(request), user)}`;
    return `<tr><td><a href="${escapeHtml(editor)}"><span data-i18n-skip>${escapeHtml(row.title ?? '(无标题)')}</span></a><small data-i18n-skip>${escapeHtml(row.slug ?? '')}</small></td><td>${escapeHtml(row.status)}</td><td><form method="post" action="${escapeHtml(action)}" onsubmit="return confirm('确认删除？')"><input type="hidden" name="cid" value="${row.cid}"><button class="danger" type="submit">删除</button></form></td></tr>`;
  }).join('');
  const previous = page > 1 ? `<a href="${escapeHtml(request.rootUrl)}/admin/${listPath}?page=${page - 1}">上一页</a>` : '';
  const next = rows.length > 50 ? `<a href="${escapeHtml(request.rootUrl)}/admin/${listPath}?page=${page + 1}">下一页</a>` : '';
  const body = `<h1>${title}管理</h1><p><a href="${escapeHtml(request.rootUrl)}/admin/write-${type}.php">新建${title}</a></p><table><thead><tr><th>标题 / 缩略名</th><th>状态</th><th>操作</th></tr></thead><tbody>${entries || `<tr><td colspan="3">暂无${title}</td></tr>`}</tbody></table><nav>${previous} ${next}</nav>`;
  return adminPage(`${title}管理`, request, body);
}

function contentEditorPage(request: RequestContext, row: ContentRow | null, type: ContentType, action: string, metas: Taxonomy[], selected: number[], defaultCategory: number | null): string {
  const noun = type === 'post' ? '文章' : '页面';
  const status = row?.status ?? 'publish';
  const option = (value: string, label: string) => `<option value="${value}"${status === value ? ' selected' : ''}>${label}</option>`;
  const taxonomyControls = type === 'post' ? (['category', 'tag'] as const).map((kind) => {
    const choices = metas.filter((meta) => meta.type === kind).map((meta) => {
      const mid = Number(meta.mid);
      const checked = row ? selected.includes(mid) : kind === 'category' && mid === defaultCategory;
      return `<label class="check"><input type="checkbox" name="${kind === 'category' ? 'category[]' : 'tags[]'}" value="${mid}"${checked ? ' checked' : ''}>${escapeHtml(meta.name)}${kind === 'category' && mid === defaultCategory ? '<span class="taxonomy-default">（默认分类）</span>' : ''}</label>`;
    }).join('');
    return `<fieldset><legend>${kind === 'category' ? '分类' : '标签'}</legend>${choices || `<p>暂无${kind === 'category' ? '分类' : '标签'}</p>`}</fieldset>`;
  }).join('') : '';
  const editorScript = String.raw`<script>
(() => {
  const editor = document.querySelector('.post-editor');
  if (!(editor instanceof HTMLElement)) return;
  const source = editor.querySelector('textarea[name="text"]');
  const preview = editor.querySelector('[data-preview-content]');
  if (!(source instanceof HTMLTextAreaElement) || !(preview instanceof HTMLElement)) return;
  const fence = String.fromCharCode(96).repeat(3);
  const marker = '<!--markdown-->';
  const markdownButton = editor.querySelector('[data-command="enable-markdown"]');
  const commandPlaceholder = (name, fallback) => editor.querySelector('[data-command="' + name + '"]')?.dataset.placeholder || fallback;

  const appendInline = (container, text) => {
    const pattern = /\*\*(.+?)\*\*|__(.+?)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      container.append(document.createTextNode(text.slice(offset, match.index)));
      if (match[1] !== undefined || match[2] !== undefined) {
        const strong = document.createElement('strong');
        strong.textContent = match[1] ?? match[2];
        container.append(strong);
      } else if (match[3] !== undefined || match[4] !== undefined) {
        const emphasis = document.createElement('em');
        emphasis.textContent = match[3] ?? match[4];
        container.append(emphasis);
      } else {
        const href = match[6];
        let safeHref = null;
        try {
          const url = new URL(href, document.baseURI);
          if (['http:', 'https:', 'mailto:'].includes(url.protocol)) safeHref = url.href;
        } catch {
          safeHref = null;
        }
        if (safeHref) {
          const link = document.createElement('a');
          link.href = safeHref;
          link.textContent = match[5];
          container.append(link);
        } else {
          container.append(document.createTextNode(match[5]));
        }
      }
      offset = match.index + match[0].length;
    }
    container.append(document.createTextNode(text.slice(offset)));
  };

  const render = () => {
    preview.replaceChildren();
    const markdownMode = source.value.startsWith(marker);
    preview.dataset.format = markdownMode ? 'markdown' : 'legacy';
    if (markdownButton instanceof HTMLButtonElement) markdownButton.hidden = markdownMode;
    editor.querySelectorAll('[data-requires-markdown]').forEach((button) => {
      if (button instanceof HTMLButtonElement) button.disabled = !markdownMode;
    });
    if (!markdownMode) {
      for (const block of source.value.split(/\r?\n\s*\r?\n/).filter((value) => value.length > 0)) {
        const paragraph = document.createElement('p');
        paragraph.textContent = block;
        preview.append(paragraph);
      }
      return;
    }
    const markdown = source.value.slice(marker.length).replace(/^\r?\n/, '');
    const lines = markdown.split(/\r?\n/);
    let paragraph = [];
    let list = null;
    let listType = '';
    let codeLines = null;

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      const element = document.createElement('p');
      appendInline(element, paragraph.join(' '));
      preview.append(element);
      paragraph = [];
    };
    const flushList = () => {
      list = null;
      listType = '';
    };
    const flushBlocks = () => {
      flushParagraph();
      flushList();
    };

    for (const line of lines) {
      if (codeLines !== null) {
        if (line.trim() === fence) {
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          code.textContent = codeLines.join('\n');
          pre.append(code);
          preview.append(pre);
          codeLines = null;
        } else {
          codeLines.push(line);
        }
        continue;
      }
      if (line.startsWith(fence)) {
        flushBlocks();
        codeLines = [];
        continue;
      }
      if (!line.trim()) {
        flushBlocks();
        continue;
      }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        flushBlocks();
        const element = document.createElement('h' + heading[1].length);
        appendInline(element, heading[2]);
        preview.append(element);
        continue;
      }
      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph();
        flushList();
        const block = document.createElement('blockquote');
        const paragraphElement = document.createElement('p');
        appendInline(paragraphElement, quote[1]);
        block.append(paragraphElement);
        preview.append(block);
        continue;
      }
      const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
      if (item) {
        flushParagraph();
        const nextType = item[2] ? 'ol' : 'ul';
        if (listType !== nextType) flushList();
        if (!list) {
          list = document.createElement(nextType);
          listType = nextType;
          preview.append(list);
        }
        const entry = document.createElement('li');
        appendInline(entry, item[3]);
        list.append(entry);
        continue;
      }
      flushList();
      paragraph.push(line);
    }
    flushBlocks();
    if (codeLines !== null) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.append(code);
      preview.append(pre);
    }
  };

  const replaceRange = (start, end, replacement, selectionStart, selectionEnd) => {
    source.setRangeText(replacement, start, end, 'select');
    source.focus();
    source.setSelectionRange(selectionStart, selectionEnd);
    render();
  };
  const wrapSelection = (before, after, placeholder) => {
    const start = source.selectionStart;
    const end = source.selectionEnd;
    const selected = source.value.slice(start, end);
    const inserted = selected || placeholder;
    replaceRange(start, end, before + inserted + after, start + before.length, start + before.length + inserted.length);
  };
  const prefixLines = (prefix, numbered) => {
    const start = source.selectionStart;
    const end = source.selectionEnd;
    const lineStart = source.value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = source.value.indexOf('\n', end);
    const stop = lineEnd === -1 ? source.value.length : lineEnd;
    const lines = source.value.slice(lineStart, stop).split('\n');
    const inserted = lines.map((line, index) => (numbered ? (index + 1) + '. ' : prefix) + line).join('\n');
    replaceRange(lineStart, stop, inserted, lineStart, lineStart + inserted.length);
  };

  editor.querySelectorAll('[data-command]').forEach((button) => {
    button.addEventListener('click', () => {
      switch (button.dataset.command) {
        case 'enable-markdown':
          source.setRangeText(marker + '\n', 0, 0, 'end');
          render();
          source.focus();
          break;
        case 'bold': wrapSelection('**', '**', commandPlaceholder('bold', 'Bold')); break;
        case 'italic': wrapSelection('*', '*', commandPlaceholder('italic', 'Italic')); break;
        case 'heading': prefixLines('## ', false); break;
        case 'quote': prefixLines('> ', false); break;
        case 'unordered-list': prefixLines('- ', false); break;
        case 'ordered-list': prefixLines('', true); break;
        case 'link': wrapSelection('[', '](https://example.com)', commandPlaceholder('link', 'Link text')); break;
        case 'image': wrapSelection('![', '](https://example.com/image.png)', commandPlaceholder('image', 'Image description')); break;
        case 'code': wrapSelection(fence + '\n', '\n' + fence, commandPlaceholder('code', 'Code')); break;
        default: break;
      }
    });
  });

  const setView = (view) => {
    editor.dataset.view = view;
    editor.querySelectorAll('[data-view-button]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.viewButton === view));
    });
    editor.querySelector('.post-editor__source').hidden = view === 'preview';
    editor.querySelector('.post-editor__preview').hidden = view === 'source';
  };
  editor.querySelectorAll('[data-view-button]').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.viewButton));
  });
  source.addEventListener('input', render);
  source.addEventListener('keydown', (event) => {
    if (!source.value.startsWith(marker)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      wrapSelection('**', '**', commandPlaceholder('bold', 'Bold'));
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      wrapSelection('*', '*', '斜体');
    }
  });
  render();
})();
</script>`;
  const editorField = `<div class="post-editor" data-view="split"><div class="post-editor__controls"><div class="post-editor__toolbar" role="toolbar" aria-label="Markdown 工具栏"><button type="button" data-command="enable-markdown" aria-label="转换为 Markdown">启用 Markdown</button><button type="button" data-requires-markdown data-command="bold" data-placeholder="粗体" aria-label="加粗">B</button><button type="button" data-requires-markdown data-command="italic" data-placeholder="斜体" aria-label="斜体"><em>I</em></button><button type="button" data-requires-markdown data-command="heading" aria-label="二级标题">H2</button><button type="button" data-requires-markdown data-command="quote" aria-label="引用">❝</button><button type="button" data-requires-markdown data-command="unordered-list" aria-label="无序列表">• 列表</button><button type="button" data-requires-markdown data-command="ordered-list" aria-label="有序列表">1. 列表</button><button type="button" data-requires-markdown data-command="link" data-placeholder="链接文本" aria-label="插入链接">链接</button><button type="button" data-requires-markdown data-command="image" data-placeholder="图片说明" aria-label="插入图片">图片</button><button type="button" data-requires-markdown data-command="code" data-placeholder="代码" aria-label="代码块">代码</button></div><div class="post-editor__view-switch" role="group" aria-label="编辑器视图"><button type="button" data-view-button="source" aria-pressed="false">源码</button><button type="button" data-view-button="preview" aria-pressed="false">预览</button><button type="button" data-view-button="split" aria-pressed="true">分屏</button></div></div><div class="post-editor__panes"><section class="post-editor__source" aria-labelledby="post-editor-source-title"><h2 id="post-editor-source-title">Markdown 源码</h2><textarea id="post-editor-source" name="text" rows="20" spellcheck="false" aria-label="Markdown 源码">${escapeHtml(row?.text ?? '<!--markdown-->')}</textarea></section><section class="post-editor__preview" aria-labelledby="post-editor-preview-title"><h2 id="post-editor-preview-title">预览</h2><div class="post-editor__preview-content" data-preview-content></div></section></div><p class="post-editor__hint">新文章使用 Markdown；旧版 AutoP 正文保持原格式。点击“启用 Markdown”会显式转换正文格式，源码就是实际保存内容。</p>${editorScript}</div>`;
  const body = `<h1>${row ? '编辑' : '新建'}${noun}</h1>${request.query.has('saved') ? '<p role="status">已保存。</p>' : ''}<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="cid" value="${row?.cid ?? 0}"><label>标题<input required maxlength="150" name="title" value="${escapeHtml(row?.title ?? '')}"></label><label>缩略名<input maxlength="150" name="slug" value="${escapeHtml(row?.slug ?? '')}" placeholder="留空自动生成"></label><div class="post-editor__field"><span>正文</span>${editorField}</div>${taxonomyControls}<label>状态<select name="status">${option('publish', '公开')}${option('draft', '草稿')}${option('private', '私密')}</select></label><label class="check"><input type="checkbox" name="allowComment" value="1"${row?.allowComment === '1' || !row ? ' checked' : ''}>允许评论</label><button type="submit">保存${noun}</button></form>`;
  return adminPage(`${row ? '编辑' : '新建'}${noun}`, request, body);
}

function adminPage(title: string, request: RequestContext, body: string): string {
  return renderAdminShell(title, request, body);
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
}
function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=UTF-8' } });
}
function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
