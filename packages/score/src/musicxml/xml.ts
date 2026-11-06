/**
 * A small XML reader: enough for MusicXML (elements, attributes, text, entities, CDATA), in plain
 * TypeScript so the server, the command line and the studio read the same way.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Parse a document into its root element. Throws on what isn't well formed enough to read. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1] as XmlNode;
    if (lt < 0) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top.text += src.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
    } else if (src.startsWith('<!', lt)) {
      // a DOCTYPE (with an internal subset, perhaps)
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        if (src[j] === '[') depth++;
        else if (src[j] === ']') depth--;
        else if (src[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end).trim();
      // close up to the matching element (forgiving of a stray one)
      for (let k = stack.length - 1; k > 0; k--) {
        if ((stack[k] as XmlNode).name === name) {
          stack.length = k;
          break;
        }
      }
      i = end + 1;
    } else {
      // a start tag: its name, its attributes (quoted either way), perhaps self-closing
      let j = lt + 1;
      let quote = '';
      for (; j < n; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      const raw = src.slice(lt + 1, j);
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const name = /^[^\s/>]+/.exec(body)?.[0] ?? '';
      const node: XmlNode = { name, attrs: {}, children: [], text: '' };
      for (const m of body.slice(name.length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        node.attrs[m[1] as string] = decodeEntities(m[3] ?? m[4] ?? '');
      }
      top.children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  const first = root.children[0];
  if (!first) throw new Error('Not XML: no element');
  return first;
}

/** The first child of a name (or along a path: "pitch/step"). */
export function child(node: XmlNode | undefined, path: string): XmlNode | undefined {
  let at = node;
  for (const name of path.split('/')) at = at?.children.find((c) => c.name === name);
  return at;
}

export const children = (node: XmlNode | undefined, name: string): XmlNode[] =>
  node?.children.filter((c) => c.name === name) ?? [];

/** A child's text, trimmed ('' when it isn't there). */
export const textOf = (node: XmlNode | undefined, path: string): string => child(node, path)?.text.trim() ?? '';

export const numberOf = (node: XmlNode | undefined, path: string, fallback = 0): number => {
  const v = Number(textOf(node, path));
  return textOf(node, path) !== '' && Number.isFinite(v) ? v : fallback;
};

/** Escaped for XML text and attributes. */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
