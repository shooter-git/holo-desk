/**
 * The engine this file is. Pinning fills it in (the fingerprint, commit and date of the HO[LO]
 * sources it was made from, and the checksum of the libraries file made with it); run from HO[LO]'s
 * own sources it is null.
 */
import type { EngineIdentity } from './identity.ts';

export const PINNED: (EngineIdentity & { packsSha256: string }) | null = /* @pinned */ null;
