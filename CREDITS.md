# Credits

## Sample packs

HO[LO] Desk installs free sample packs on request. Their audio isn't stored here, and neither are their
maps: both live with the packs in [HO[LO] Packs](https://github.com/shooter-git/holo-packs). Its
[CREDITS.md](https://github.com/shooter-git/holo-packs/blob/main/CREDITS.md) names every library's
authors, licence and source, and each pack's page says more about it.

They are:
- VSCO 2 Community Edition and the Versilian Community Sample Library (Versilian Studios);
- Meatbass, Big Rusty Drums and Frankensnare (Karoryfer Samples);
- Virtuosity Drums (Versilian Studios and Karoryfer Samples);
- the FreePats Spanish Classical Guitar;
- the University of Iowa Musical Instrument Samples;
- the bitKlavier Grand (Princeton University, CC BY 4.0).

The studio shows each pack's credit in its Library, and an experience's pinned `packs.json` keeps it.

## Fonts and icons

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
- Scores are engraved by [Verovio](https://www.verovio.org) (LGPL-3.0, © RISM Digital Center and
  Verovio's contributors), used unmodified as the npm package `verovio` and loaded as its own file
  (the score worker), so it can be swapped for another build of Verovio. HO[LO] writes the score it
  draws as MEI (`packages/score/src/mei.ts`); Verovio's source is at
  [github.com/rism-digital/verovio](https://github.com/rism-digital/verovio).
