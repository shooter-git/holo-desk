# Contributing

Thank you for helping make HO[LO] Desk better. Issues and pull requests are welcome.

## Getting set up

```bash
pnpm install
cp .env.example .env
git config core.hooksPath .githooks   # the secrets check before each commit
pnpm dev
```

## Before you open a pull request

```bash
pnpm lint && pnpm typecheck && pnpm test
```

- Keep each pull request to one change, and say what it changes for someone using the studio.
- The audio thread (`apps/web/src/audio/worklet`) must never allocate or wait while audio runs.
  Prefer preallocated buffers; measure before and after any change to it.
- New plugin parameters go in `packages/session/src/plugins.ts`, so the engine, the plugin windows,
  the command line and the AI read the same ranges.
- Changes to the session format need a version bump and a migration in `validate.ts`: creations keep
  session files in their own repositories.
- UI changes should work with a mouse, a pen and a finger, on desktop, tablet and phone (portrait and
  landscape).

## Commits

Commits are signed off with GitHub's private noreply address, never a personal one; the pre-commit
hook checks. Don't commit secrets, `.env`, sample audio or anything from `data/`.

By contributing you agree that your contributions are licensed under the MIT licence.
