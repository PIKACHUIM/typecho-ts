/**
 * Markdown renderer aligned with Typecho's HyperDown output for the constructs
 * used by typical posts. HyperDown's exact edge cases are covered by the parity
 * tests; this module is the single place to adjust when a snapshot differs.
 */

const MD_MARKER = '<!--markdown-->';

export function isMarkdownText(text: string): boolean {
  return text.startsWith(MD_MARKER);
}

export function stripMarkdownMarker(text: string): string {
  return isMarkdownText(text) ? text.slice(MD_MARKER.length) : text;
}

export function renderMarkdown(source: string): string {
  const text = stripMarkdownMarker(source ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    // fenced code
    const fence = line.match(/^ {0,3}(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(marker)) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const cls = lang ? ` class="lang-${lang}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}\n</code></pre>`);
      continue;
    }

    // atx heading
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // hr
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // blockquote
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        body.push(lines[i].replace(/^ {0,3}>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>\n${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    // lists
    if (/^ {0,3}([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^ {0,3}\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^ {0,3}([-*+]|\d+\.)\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]) || lines[i].trim() === '')) {
        if (lines[i].trim() === '') {
          i++;
          continue;
        }
        if (/^ {0,3}([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^ {0,3}([-*+]|\d+\.)\s+/, ''));
        } else {
          items[items.length - 1] += `\n${lines[i].trim()}`;
        }
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>\n${items.map((item) => `<li>${inline(item)}</li>`).join('\n')}\n</${tag}>`);
      continue;
    }

    // table (simple pipe tables)
    if (line.includes('|') && i + 1 < lines.length && /^ {0,3}\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => {
        const c = cell.trim();
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        return 'left';
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = header.map((cell, idx) => `<th style="text-align:${align[idx] ?? 'left'}">${inline(cell.trim())}</th>`).join('');
      const body = rows
        .map((row) => `<tr>${row.map((cell, idx) => `<td style="text-align:${align[idx] ?? 'left'}">${inline(cell.trim())}</td>`).join('')}</tr>`)
        .join('\n');
      out.push(`<table>\n<thead>\n<tr>${th}</tr>\n</thead>\n<tbody>\n${body}\n</tbody>\n</table>`);
      continue;
    }

    // html block
    if (/^ {0,3}</.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        body.push(lines[i]);
        i++;
      }
      out.push(body.join('\n'));
      continue;
    }

    // paragraph
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(body.join('\n'))}</p>`);
  }

  return out.join('\n');
}

function isBlockStart(line: string): boolean {
  return (
    /^ {0,3}(```+|~~~+)/.test(line) ||
    /^ {0,3}#{1,6}\s/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}([-*+]|\d+\.)\s+/.test(line) ||
    /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
  );
}

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text: string): string {
  let out = text;
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  out = escapeHtml(out);

  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, alt: string, src: string, title?: string) =>
      `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''} />`
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, label: string, href: string, title?: string) =>
      `<a href="${href}"${title ? ` title="${title}"` : ''}>${label}</a>`
    )
    .replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_m, prefix: string, href: string) => `${prefix}<a href="${href}">${href}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  out = out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codeSpans[Number(index)] ?? '');
  return out;
}

/** Typecho's AutoP: wraps plain text paragraphs in `<p>` tags. */
export function renderAutoP(source: string): string {
  const text = (source ?? '').replace(/\r\n?/g, '\n');
  return text
    .split(/\n{2,}/)
    .map((block) => (block.trim() === '' ? '' : `<p>${block.replace(/^[ \t]+/gm, '')}</p>`))
    .filter(Boolean)
    .join('\n');
}

export function renderContent(text: string): string {
  return isMarkdownText(text) ? renderMarkdown(text) : renderAutoP(text);
}
