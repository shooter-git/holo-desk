# Credits

HO[LO] Desk installs these sample libraries on request. They aren't stored in this repository: only
their sample maps are (`packs/manifests/`, made from measurements of the samples) and every file's
checksum (`packs/checksums/`). `pnpm packs install`, and an experience's own build, fetch the audio
from its source: the git libraries at a pinned commit, the Iowa notes cut from the university's own
downloads, and the FreePats guitar decoded from the project's own archive.

| Pack | Authors | Licence | Source |
|---|---|---|---|
| VSCO 2 Community Edition | Versilian Studios: Sam Gossner and contributors; the pipe organ by Simon Dalzell | CC0 1.0 | <https://github.com/sgossner/VSCO-2-CE> |
| Versilian Community Sample Library | Versilian Studios: Sam Gossner and contributors | CC0 1.0 | <https://github.com/sgossner/VCSL> |
| Meatbass | Karoryfer Samples: a 1958 Otto Rubner double bass, played and sampled by Drogomir Smolken | CC0 1.0 | <https://github.com/sfzinstruments/karoryfer.meatbass> |
| Spanish Classical Guitar | The FreePats project | CC0 1.0 | <https://freepats.zenvoid.org/Guitar/acoustic-guitar.html> |
| Clarinet and Bassoon | University of Iowa Electronic Music Studios (Musical Instrument Samples) | Free to use without restriction | <https://theremin.music.uiowa.edu/MIS.html> |

The samples' measurements (true pitch, level, start, end and loop points) come from
[Hallowed Lanterns](https://github.com/shooter-git/hallowed-lanterns)' sample catalogues.

The studio's fonts are [Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/)
(SIL Open Font License), and its icons are [Lucide](https://lucide.dev) (ISC).

## Code

- HO[LO] Engine's sound devices are [miniaudio](https://miniaud.io) by David Reid (public domain or
  MIT-0), fetched by the build at a pinned release.

- The engine draws random numbers as [NumPy](https://numpy.org) does (`packages/engine/src/random.ts`):
  its `SeedSequence` seeding, the PCG64 generator (by Melissa O'Neill) and its uniform, integer and
  normal draws, with NumPy's ziggurat tables (`ziggurat.ts`). NumPy is BSD-3-Clause, © NumPy
  Developers; PCG is MIT or Apache 2.0, © Melissa O'Neill.
- Sample archives are read without other programs: `packages/music/src/lzma.ts` is the LZMA decoder
  of Igor Pavlov's [LZMA SDK](https://7-zip.org/sdk.html) (public domain) written out in TypeScript,
  `sevenzip.ts` reads the 7z container (Deflate through Node's zlib) and `flac.ts` decodes FLAC as
  [RFC 9639](https://www.rfc-editor.org/rfc/rfc9639) specifies it.
- The Performance sampler, Glass, the effects ported for parity (Parametric EQ, Transient Softener,
  Stereo Width, Tape Warmth, Wow & Flutter, Shimmer, the compressor's linear detector), Stage and the
  finish follow [Hallowed Lanterns](https://github.com/shooter-git/hallowed-lanterns)' audio code, by
  the same author. The finish's true-peak interpolator is the one SciPy's `resample_poly` designs
  (BSD-3-Clause, © SciPy Developers).
