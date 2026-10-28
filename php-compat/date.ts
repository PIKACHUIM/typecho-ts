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
  const dateNumber = date.getUTCDate();
  const suffix = dateNumber >= 11 && dateNumber <= 13 ? 'th' :
    dateNumber % 10 === 1 ? 'st' : dateNumber % 10 === 2 ? 'nd' : dateNumber % 10 === 3 ? 'rd' : 'th';
  const zoneMinutes = Math.floor(Math.abs(offset) / 60);
  const zoneSign = offset < 0 ? '-' : '+';
  const zoneCompact = `${zoneSign}${pad(Math.floor(zoneMinutes / 60))}${pad(zoneMinutes % 60)}`;
  const zoneColon = `${zoneSign}${pad(Math.floor(zoneMinutes / 60))}:${pad(zoneMinutes % 60)}`;
  const timeIso = `${year}-${pad(month + 1)}-${pad(dateNumber)}T${pad(hour)}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  const map: Record<string, string> = {
    Y: String(year),
    y: pad(year % 100),
    m: pad(month + 1),
    n: String(month + 1),
    d: pad(date.getUTCDate()),
    j: String(dateNumber),
    S: suffix,
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
    c: `${timeIso}${zoneColon}`,
    r: `${DAYS[day].slice(0, 3)}, ${pad(dateNumber)} ${MONTHS[month].slice(0, 3)} ${year} ${pad(hour)}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${zoneCompact}`,
    O: zoneCompact,
    P: zoneColon,
    T: offset === 0 ? 'UTC' : `GMT${zoneColon}`,
    Z: String(offset),
    e: offset === 0 ? 'UTC' : `UTC${zoneColon}`,
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
