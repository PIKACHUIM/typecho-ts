import { describe, expect, it, vi } from 'vitest';
import { SiteOptions } from '../src/core/options';
import type { Db } from '../src/core/db';
import { buildRequestContext } from '../src/core/request';
import { dateArchiveRows } from '../src/widgets/date-archive';

const request = buildRequestContext(new Request('https://example.test/'));
const route = { archive_month: { url: '/[year:digital:4]/[month:digital:2]/', widget: '\\Widget\\Archive', action: 'render' } };

function create(rows: Array<{ period: string; created: number; count: number }>, installedRoutes = route) {
  const all = vi.fn(async (_sql: string, _params?: unknown[]) => rows);
  const db = { all } as unknown as Db;
  const output: string[] = [];
  const echo = (value: unknown) => output.push(String(value));
  const options = new SiteOptions({ values: { timezone: '28800', rewrite: '1', routingTable: installedRoutes }, request, echo });
  return { all, db, output, echo, options };
}

describe('Typecho monthly archive sidebar', () => {
  it('groups visible posts by the site timezone and renders a real permalink', async () => {
    const created = Math.floor(Date.parse('2026-10-28T00:30:00Z') / 1000);
    const { all, db, output, echo, options } = create([{ period: '2026-10', created, count: 3 }]);
    const widget = dateArchiveRows(db, options, request, echo, 'type=month&format=F Y');
    await widget.parse('<li><a href="{permalink}">{date}</a></li>');
    expect(output.join('')).toContain('<li><a href="https://example.test/2026/10/">October 2026</a></li>');
    expect(all.mock.calls[0][0]).toContain("status = 'publish'");
    expect(all.mock.calls[0][0]).toContain('created <= ?');
    expect(all.mock.calls[0][1]).toEqual(['%Y-%m', 28800, expect.any(Number)]);
  });

  it('does not render navigation links when the date route is not installed', async () => {
    const { db, output, echo, options } = create([], {} as typeof route);
    await dateArchiveRows(db, options, request, echo, 'type=month').parse('{permalink}');
    expect(output.join('')).toBe('');
  });
});
