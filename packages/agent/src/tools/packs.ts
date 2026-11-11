/**
 * HO[LO] Packs: the installed ones (their instruments and a palette's ready-made sounds), and the
 * catalog of packs that can be installed after the user's click (ask_permission).
 */
import { bool, plural, str, type Tool } from './common.ts';

const megabytes = (bytes: number | null | undefined) =>
  typeof bytes === 'number' && bytes > 0 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : '';

export const packs: Tool = {
  name: 'packs',
  kind: 'see',
  summary:
    'HO[LO] Packs. Without "available": the installed packs, each with its instruments count and, for a palette, its ready-made sounds ("pack/Sound name", which track_add takes as "sound"). With "available": true, the catalog of packs that can be installed (size, license, installed or not); installing one needs the user\'s click (ask_permission with kind "install-pack"). "search" narrows either list by words.',
  args: [
    { name: 'available', type: 'boolean', describe: 'List the catalog instead of the installed packs', default: false },
    { name: 'search', type: 'string', describe: 'Words to look for, e.g. "piano" or "choir"', maxLength: 60 },
  ],
  async run(ctx, args) {
    const query = str(args, 'search')?.trim().toLowerCase();
    const fits = (...texts: (string | undefined)[]) =>
      !query || query.split(/\s+/).every((w) => texts.some((t) => t?.toLowerCase().includes(w)));
    if (bool(args, 'available')) {
      const catalog = await ctx.api.packsAvailable();
      const lines = catalog.offline
        ? [`The catalog can't be reached (${catalog.error ?? 'offline'}); the installed packs still play.`]
        : [];
      for (const p of catalog.packs) {
        const words = [p.id, p.name, p.description, ...p.instruments.map((i) => `${i.title} ${i.category}`)];
        if (!fits(...words, ...(p.sounds ?? []).map((s) => `${s.name} ${s.family}`))) continue;
        const bits = [
          p.installed ? (p.current === false ? 'installed, an update is available' : 'installed') : 'not installed',
          megabytes(p.bytes),
          p.license,
          plural(p.instruments.length, 'instrument'),
          p.sounds?.length ? plural(p.sounds.length, 'sound') : '',
          p.requires?.length ? `needs ${p.requires.join(', ')}` : '',
        ].filter(Boolean);
        lines.push(`${p.id}: ${p.name} (${bits.join(', ')})${p.description ? `: ${p.description}` : ''}`);
      }
      if (lines.length === (catalog.offline ? 1 : 0))
        lines.push(query ? `Nothing matches "${query}".` : 'The catalog is empty.');
      return { text: lines.join('\n') };
    }
    const installed = await ctx.api.packs();
    const lines: string[] = [];
    for (const p of installed) {
      const sounds = (p.sounds ?? []).filter((s) => fits(s.name, s.family, s.note, p.name, p.id));
      const instruments = p.instruments.filter((i) => fits(i.name, i.title, i.category, p.name, p.id));
      if (query && !sounds.length && !instruments.length && !fits(p.name, p.id, p.description)) continue;
      lines.push(
        `${p.id}: ${p.name} (${plural(p.instruments.length, 'instrument')}${p.sounds?.length ? `, ${plural(p.sounds.length, 'sound')}` : ''})${p.description ? `: ${p.description}` : ''}`,
      );
      for (const s of sounds.slice(0, 60))
        lines.push(
          `  sound ${p.id}/${s.name} [${s.family}]${s.coming ? ' (coming: not playable yet)' : ''}${s.note ? `: ${s.note}` : ''}`,
        );
      if (sounds.length > 60) lines.push(`  … ${plural(sounds.length - 60, 'more sound')}: narrow with "search"`);
    }
    if (!lines.length) lines.push(query ? `No installed pack matches "${query}".` : 'No packs are installed.');
    lines.push("The instruments tool lists each pack's instruments as pack/name.");
    return { text: lines.join('\n') };
  },
};

export const packTools: Tool[] = [packs];
