/** Thin D1 wrapper that mirrors the parts of Typecho\Db we need. */
export class Db {
  constructor(
    private readonly d1: D1Database,
    readonly prefix: string = 'typecho_'
  ) {}

  /** `table.contents` -> `typecho_contents` */
  t(name: string): string {
    return `${this.prefix}${name}`;
  }

  /** Replaces `table.x` references inside raw SQL, like Typecho's Query::prepare. */
  sql(raw: string): string {
    return raw.replace(/table\.([a-zA-Z0-9_]+)/g, (_m, name: string) => this.t(name));
  }

  async all<T = Record<string, unknown>>(rawSql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.d1.prepare(this.sql(rawSql));
    const result = await (params.length > 0 ? stmt.bind(...params) : stmt).all<T>();
    return result.results ?? [];
  }

  async first<T = Record<string, unknown>>(rawSql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.d1.prepare(this.sql(rawSql));
    const result = await (params.length > 0 ? stmt.bind(...params) : stmt).first<T>();
    return result ?? null;
  }

  async run(rawSql: string, params: unknown[] = []): Promise<D1Result> {
    const stmt = this.d1.prepare(this.sql(rawSql));
    return (params.length > 0 ? stmt.bind(...params) : stmt).run();
  }

  /** Executes statements in one D1 batch (atomic, one round trip). */
  async batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<D1Result[]> {
    const prepared = statements.map((item) => {
      const stmt = this.d1.prepare(this.sql(item.sql));
      return item.params && item.params.length > 0 ? stmt.bind(...item.params) : stmt;
    });
    if (prepared.length === 0) return [];
    return this.d1.batch(prepared);
  }

  async insertReturningId(rawSql: string, params: unknown[] = []): Promise<number> {
    const row = await this.first<{ id: number }>(rawSql, params);
    return Number(row?.id ?? 0);
  }

  async count(rawSql: string, params: unknown[] = []): Promise<number> {
    const row = await this.first<{ num: number }>(rawSql, params);
    return Number(row?.num ?? 0);
  }

  /** D1 caps a statement at 100 bound parameters. */
  static chunk<T>(items: T[], paramsPerItem: number): T[][] {
    const size = Math.max(1, Math.floor(100 / Math.max(1, paramsPerItem)));
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
  }
}
