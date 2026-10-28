const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** PHP `date($format, $timestamp)` with an explicit timezone offset (seconds). */
export function dateFormat(ts: number, format: string, offset = 0): string {
  const date = new Date((Math.trunc(ts) + offset) * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const day = date.getUTCDay();
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  const hour = date.getUTCHours();
  const map: Record<string, string> = {
    Y: String(year),
    y: pad(year % 100),
    m: pad(month + 1),
    n: String(month + 1),
    d: pad(date.getUTCDate()),
    j: String(date.getUTCDate()),
    H: pad(hour),
    G: String(hour),
    h: pad(hour % 12 === 0 ? 12 : hour % 12),
    g: String(hour % 12 === 0 ? 12 : hour % 12),
    i: pad(date.getUTCMinutes()),
    s: pad(date.getUTCSeconds()),
    a: hour < 12 ? 'am' : 'pm',
    A: hour < 12 ? 'AM' : 'PM',
    w: String(day),
    N: String(day === 0 ? 7 : day),
    l: DAYS[day],
    D: DAYS[day].slice(0, 3),
    F: MONTHS[month],
    M: MONTHS[month].slice(0, 3),
    t: String(new Date(Date.UTC(year, month + 1, 0)).getUTCDate()),
    L: new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1 ? '1' : '0',
    U: String(Math.trunc(ts)),
    c: new Date((Math.trunc(ts) + offset) * 1000).toISOString().replace('Z', '+00:00'),
    r: `${DAYS[day].slice(0, 3)}, ${pad(date.getUTCDate())} ${MONTHS[month].slice(0, 3)} ${year} ${pad(hour)}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`,
    O: '+0000',
    P: '+00:00',
    T: 'UTC',
    Z: String(offset),
    e: 'UTC',
    W: pad(Math.ceil((Date.UTC(year, month, date.getUTCDate()) - Date.UTC(year, 0, 1)) / 86400000 / 7)),
  };

  let out = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch === '\\') {
      out += format[++i] ?? '';
      continue;
    }
    out += map[ch] ?? ch;
  }
  return out;
}
