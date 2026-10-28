import { parseOption } from '../core/common';
import type { Db } from '../core/db';
import type { SiteOptions } from '../core/options';
import type { RequestContext } from '../core/request';
import { RowsWidget } from './rows';

/** Backing data for Typecho's monthly/yearly/daily post archive sidebar. */
export function dateArchiveRows(
  db: Db,
  options: SiteOptions,
  request: RequestContext,
  echo: (value: unknown) => void,
  parameter: unknown
): RowsWidget {
  const config = parseOption(parameter);
  const kind = ['year', 'month', 'day'].includes(config.type) ? config.type : 'month';
  const route = `archive_${kind}`;
  const dateFormat = config.format || (kind === 'year' ? 'Y' : kind === 'day' ? 'F j, Y' : 'F Y');
  const sqlFormat = kind === 'year' ? '%Y' : kind === 'day' ? '%Y-%m-%d' : '%Y-%m';
  const rawTimezone = Number(options.get('timezone') ?? 0);
  const timezone = Number.isFinite(rawTimezone) ? Math.max(-43200, Math.min(50400, Math.trunc(rawTimezone))) : 0;
  return new RowsWidget({
    db, options, request, echo, kind: 'dates', archiveDateFormat: dateFormat,
    loader: async () => {
      if (!options.router.get(route)) return [];
      const rows = await db.all<{ period: string; created: number; count: number }>(
        `SELECT strftime(?, created + ?, 'unixepoch') AS period, MAX(created) AS created, COUNT(*) AS count
         FROM table.contents WHERE type = 'post' AND status = 'publish' AND created <= ?
           AND (password IS NULL OR password = '')
         GROUP BY period ORDER BY period DESC LIMIT 120`,
        [sqlFormat, timezone, Math.floor(Date.now() / 1000)]
      );
      return rows.flatMap(({ period, created, count }) => {
        if (!/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(period)) return [];
        const [year, month, day] = period.split('-');
        const permalink = options.router.url(route, {
          year,
          ...(month ? { month } : {}),
          ...(day ? { day } : {}),
        }, options.derived.index);
        return [{ created, count, permalink }];
      });
    },
  });
}
