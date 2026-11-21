/**
 * A harness's last words as the reply under the bar, for a turn that ended without `finish`. They're
 * what it said in its own chat, which is often markdown (bold, code, headings, lists, tables) and longer
 * than the bar holds. The markup goes and its words stay. Paragraphs, headings and list items keep a
 * line each (the bar keeps line breaks), while a paragraph's own line breaks are spaces, as markdown
 * reads them. A long one is cut at the end of a sentence, with "…" for what was left out.
 */

/** The reply, plain, in at most `max` characters ('' when nothing but markup was said). */
export function plainReply(said: string, max = 600): string {
  const lines = said
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\p{Cc}/gu, (c) => (c === '\n' ? c : ' '))
    .split('\n');
  const out: string[] = [];
  /** Whether the next line of prose goes on with the last one (a paragraph's lines are one). */
  let goesOn = false;
  let fenced = false;
  for (const raw of lines) {
    let line = raw.replace(/\s+/g, ' ').trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      goesOn = false;
      continue;
    }
    if (fenced) {
      // code stays as it was written, a line each
      if (line) out.push(line);
      goesOn = false;
      continue;
    }
    // a blank line, a rule or a table's line under its heads ends the paragraph
    if (!line || /^([-*_])( ?\1){2,}$/.test(line) || /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line)) {
      goesOn = false;
      continue;
    }
    line = line.replace(/^(> ?)+/, '');
    let own = false;
    let row = false;
    const heading = /^#{1,6} (.*?)(?: #+)?$/.exec(line);
    const bullet = /^[-*+] (.*)$/.exec(line);
    if (heading) {
      line = heading[1] ?? '';
      own = true;
    } else if (bullet) {
      line = `• ${bullet[1] ?? ''}`;
      own = true;
    } else if (/^\d{1,3}[.)] /.test(line)) {
      own = true;
    } else if (line.startsWith('|') && line.endsWith('|') && line.length > 1) {
      line = line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(' · ');
      own = true;
      row = true;
    }
    line = inline(line);
    if (!line) continue;
    if (goesOn && !own) out[out.length - 1] += ` ${line}`;
    else out.push(line);
    // a heading or a table row stands alone; a list item takes the lines that go on with it
    goesOn = !heading && !row;
  }
  return cut(out.join('\n'), max);
}

/** One line's inline markup gone: code, links, bold, italics, strikethrough, escapes. */
function inline(line: string): string {
  // code and escaped characters are kept aside (marked by a private-use character, taken out of what
  // was said first), so nothing in them reads as markup
  const kept: string[] = [];
  const keep = (text: string) => `\uE000${kept.push(text) - 1}\uE000`;
  const text = line
    .replace(/\uE000/g, '')
    .replace(/(`+)(.+?)\1/g, (_, _ticks: string, code: string) => keep(code.trim()))
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, c: string) => keep(c))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, '$1$2')
    // what's left of markup cut short (a bold never closed)
    .replace(/\*\*|`/g, '');
  return text
    .replace(/\uE000(\d+)\uE000/g, (_, i: string) => kept[Number(i)] ?? '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** At most `max` characters: up to the last sentence or line that fits (when it keeps half), else the last word. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  let end = -1;
  for (const m of room.matchAll(/[.!?…](?=\s)|\n/g)) end = m.index + (m[0] === '\n' ? 0 : 1);
  if (end >= max / 2) return `${room.slice(0, end).trimEnd()} …`;
  const space = room.lastIndexOf(' ');
  return `${(space >= max / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}
