/**
 * Sessions as text that reads well and diffs well in git: anything that fits on a line (a note, a
 * controller point, a small object) stays on one line; everything bigger opens up, one item per
 * line. A creation's sessions are committed with it, so a change to three notes is three lines.
 */
export function formatJson(value: unknown, width = 100): string {
  return `${write(value, '', width)}\n`;
}

function write(value: unknown, indent: string, width: number): string {
  const compact = JSON.stringify(value);
  if (compact === undefined) return 'null';
  if (value === null || typeof value !== 'object' || compact.length + indent.length <= width) return compact;
  const inner = `${indent} `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => inner + write(v, inner, width)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${write(v, inner, width)}`).join(',\n')}\n${indent}}`;
}
