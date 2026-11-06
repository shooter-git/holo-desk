/**
 * The engine this file is. Pinning fills it in: the fingerprints, commit and date of the HO[LO]
 * sources it was made from, and every pack its lock pins with that pack's hash (the `catalog`: the
 * packs it will play, each only as that map). Engines pinned before the lock name the one libraries
 * file they play instead (`packsSha256`). Run from HO[LO]'s own sources it is null.
 */
import type { EngineIdentity } from './identity.ts';

export type PinnedSelf = EngineIdentity & { catalog?: Record<string, string>; packsSha256?: string };

export const PINNED: PinnedSelf | null = /* @pinned */ null;
