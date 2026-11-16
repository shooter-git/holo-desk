/**
 * A pairing link, as `holo pair` prints it on the host: the studio's address with the code in its
 * fragment (`#agent-pair=123456`), which no server ever sees. Read when the studio starts (or the
 * fragment changes), dropped from the address at once so no history or bookmark keeps it, and taken by
 * Settings › Agent, which shows it filled in for Pair.
 */
let pending: string | null = null;

/** The code in a fragment, if it's a pairing link's. */
export function codeIn(hash: string): string | null {
  return /^#agent-pair=(\d{6})$/.exec(hash)?.[1] ?? null;
}

/** Take the address's pairing link, if it has one (the address loses it): whether it had one. */
export function readPairLink(
  loc: Pick<Location, 'hash' | 'pathname' | 'search'> = location,
  hist: Pick<History, 'state' | 'replaceState'> = history,
): boolean {
  const code = codeIn(loc.hash);
  if (!code) return false;
  pending = code;
  hist.replaceState(hist.state, '', `${loc.pathname}${loc.search}`);
  return true;
}

/** The code a pairing link brought, once. */
export function takePairCode(): string | null {
  const code = pending;
  pending = null;
  return code;
}
