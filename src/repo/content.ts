import type { Db } from '../core/db';
import { renderContent } from '../core/markdown';

export interface ContentRow {
  cid: number;
  title: string | null;
  slug: string | null;
  created: number;
  modified: number;
  text: string | null;
  order: number;
  authorId: number;
  template: string | null;
  type: string;
  status: string;
  password: string | null;
  commentsNum: number;
  allowComment: string;
  allowPing: string;
  allowFeed: string;
  parent: number;
}

export interface MetaRow {
  mid: number;
  name: string;
  slug: string;
  type: string;
  description: string | null;
  count: number;
  order: number;
  parent: number;
}

export interface UserRow {
  uid: number;
  name: string;
  screenName: string | null;
  mail: string | null;
  url: string | null;
  password: string;
  created: number;
  group: string;
}

export interface CommentRow {
  coid: number;
  cid: number;
  created: number;
  author: string | null;
  authorId: number;
  ownerId: number;
  mail: string | null;
  url: string | null;
  ip: string | null;
  agent: string | null;
  text: string | null;
  type: string;
  status: string;
  parent: number;
}

export interface ContentListQuery {
  type?: string;
  status?: string;
  limit?: number;
  offset?: number;
  authorId?: number;
  categorySlug?: string;
  tagSlug?: string;
  keywords?: string;
  year?: number;
  month?: number;
  day?: number;
}

const PUBLISHED = 'publish';

function buildWhere(query: ContentListQuery): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  where.push('table.contents.type = ?');
  params.push(query.type ?? 'post');
  where.push('table.contents.status = ?');
  params.push(query.status ?? PUBLISHED);
  where.push('table.contents.created < ?');
  params.push(Math.floor(Date.now() / 1000));

  if (query.authorId) {
    where.push('table.contents.authorId = ?');
    params.push(query.authorId);
  }
  if (query.categorySlug || query.tagSlug) {
    where.push(
      'table.contents.cid IN (SELECT r.cid FROM table.relationships r JOIN table.metas m ON m.mid = r.mid WHERE m.slug = ? AND m.type = ?)'
    );
    params.push(query.categorySlug ?? query.tagSlug, query.categorySlug ? 'category' : 'tag');
  }
  if (query.keywords) {
    where.push('(instr(lower(table.contents.title), lower(?)) > 0 OR instr(lower(table.contents.text), lower(?)) > 0)');
    params.push(query.keywords, query.keywords);
  }
  if (query.year) {
    const start = Math.floor(Date.UTC(query.year, (query.month ?? 1) - 1, query.day ?? 1) / 1000);
    const end = query.day
      ? start + 86400
      : query.month
        ? Math.floor(Date.UTC(query.year, query.month, 1) / 1000)
        : Math.floor(Date.UTC(query.year + 1, 0, 1) / 1000);
    where.push('table.contents.created >= ? AND table.contents.created < ?');
    params.push(start, end);
  }

  return { sql: where.join(' AND '), params };
}

export async function listContents(db: Db, query: ContentListQuery): Promise<ContentRow[]> {
  const { sql: where, params } = buildWhere(query);
  params.push(query.limit ?? 10, query.offset ?? 0);
  return db.all<ContentRow>(
    `SELECT * FROM table.contents WHERE ${where} ORDER BY table.contents.created DESC, table.contents.cid DESC LIMIT ? OFFSET ?`,
    params
  );
}

export async function countContents(db: Db, query: ContentListQuery): Promise<number> {
  const { sql: where, params } = buildWhere(query);
  return db.count(`SELECT COUNT(cid) AS num FROM table.contents WHERE ${where}`, params);
}

export async function findContent(db: Db, filter: { cid?: number; slug?: string; type?: string }): Promise<ContentRow | null> {
  if (filter.cid) {
    return db.first<ContentRow>('SELECT * FROM table.contents WHERE cid = ?', [filter.cid]);
  }
  if (filter.slug) {
    return db.first<ContentRow>('SELECT * FROM table.contents WHERE slug = ? AND status = ?', [filter.slug, PUBLISHED]);
  }
  return null;
}

export async function listCategories(db: Db, cid?: number): Promise<MetaRow[]> {
  if (cid) {
    return db.all<MetaRow>(
      `SELECT m.* FROM table.metas m JOIN table.relationships r ON r.mid = m.mid WHERE r.cid = ? AND m.type = 'category' ORDER BY m."order" ASC`,
      [cid]
    );
  }
  return db.all<MetaRow>(`SELECT * FROM table.metas WHERE type = 'category' ORDER BY "order" ASC, mid ASC`);
}

export async function listTags(db: Db, cid?: number): Promise<MetaRow[]> {
  if (cid) {
    return db.all<MetaRow>(
      `SELECT m.* FROM table.metas m JOIN table.relationships r ON r.mid = m.mid WHERE r.cid = ? AND m.type = 'tag' ORDER BY m."order" ASC`,
      [cid]
    );
  }
  return db.all<MetaRow>(`SELECT * FROM table.metas WHERE type = 'tag' ORDER BY "order" ASC, mid ASC`);
}

export async function findUser(db: Db, uid: number): Promise<UserRow | null> {
  return db.first<UserRow>('SELECT * FROM table.users WHERE uid = ?', [uid]);
}

export async function listComments(db: Db, cid: number): Promise<CommentRow[]> {
  return db.all<CommentRow>(
    `SELECT * FROM table.comments WHERE cid = ? AND status = 'approved' AND type = 'comment' ORDER BY created ASC, coid ASC`,
    [cid]
  );
}

export async function countComments(db: Db, cid: number): Promise<number> {
  return db.count(`SELECT COUNT(coid) AS num FROM table.comments WHERE cid = ? AND status = 'approved' AND type = 'comment'`, [cid]);
}

export async function listRecentComments(db: Db, limit = 5, includeCommentOnly = true): Promise<CommentRow[]> {
  const typeFilter = includeCommentOnly ? `AND type = 'comment'` : '';
  return db.all<CommentRow>(
    `SELECT * FROM table.comments WHERE status = 'approved' ${typeFilter} ORDER BY created DESC LIMIT ?`,
    [limit]
  );
}

export async function listPages(db: Db): Promise<ContentRow[]> {
  return db.all<ContentRow>(
    `SELECT * FROM table.contents WHERE type = 'page' AND status = 'publish' ORDER BY "order" ASC, cid ASC`
  );
}

export interface FieldMap {
  [name: string]: unknown;
}

export async function loadFields(db: Db, cid: number): Promise<FieldMap> {
  const rows = await db.all<{ name: string; type: string; str_value: string | null; int_value: number; float_value: number }>(
    'SELECT * FROM table.fields WHERE cid = ?',
    [cid]
  );
  const fields: FieldMap = {};
  for (const row of rows) {
    if (row.type === 'json' && row.str_value) {
      try {
        fields[row.name] = JSON.parse(row.str_value);
      } catch {
        fields[row.name] = row.str_value;
      }
    } else if (row.type === 'int') fields[row.name] = row.int_value;
    else if (row.type === 'float') fields[row.name] = row.float_value;
    else fields[row.name] = row.str_value;
  }
  return fields;
}

export function contentHtml(row: ContentRow): string {
  return renderContent(row.text ?? '');
}

export function excerptHtml(row: ContentRow, length = 100, trim = '...'): string {
  const content = contentHtml(row);
  const [excerpt] = content.split('<!--more-->');
  const plain = excerpt.replace(/<[^>]*>/g, '');
  if ([...plain].length <= length) return plain;
  const cut = [...plain].slice(0, Math.max(0, length - [...trim].length)).join('');
  return cut + trim;
}
