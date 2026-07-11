# Contributing to OpenLive

Thanks for wanting to help. OpenLive is a small, focused codebase, and it stays
that way on purpose. This guide gets you running and shows where things live.

## Setup

You need Node 22.13 or newer and pnpm (the repo pins the version in
`package.json`).

```bash
pnpm install
pnpm desktop:dev      # web + agent servers, opens the desktop window
```

For UI work you often don't need the whole desktop shell:

```bash
pnpm dev              # web + agent only, open http://localhost:3000
```

Useful scripts:

```bash
pnpm typecheck        # tsc across every package (CI runs this)
pnpm desktop:build:mac # build the macOS app locally
pnpm desktop:build:win # build the Windows installer (run on Windows)
```

## Where things live

```
apps/desktop     Electron shell: local servers, permissions, window, auto-update
apps/web         Next.js UI + the on-device voice engine in src/lib/live
services/agent   the /live WebSocket and the model tools
packages/harness model adapters (Anthropic / OpenAI Responses / OpenAI Chat), model listing
packages/shared  the wire protocol and shared types
packages/db      JSON-file store for keys, settings, conversations
```

The voice loop (VAD, STT, end-of-turn, TTS, barge-in) is in
`apps/web/src/lib/live`. The model turn goes out from `services/agent`.

## Sending a change

1. Fork and branch off `main`.
2. Keep the change small and focused. One idea per pull request.
3. Run `pnpm typecheck` before you push. CI will run it too.
4. Write a clear title and say what changed and why. Screenshots help for UI.
5. Match the style around you. This codebase favors short, direct code over
   layers of abstraction, and comments that explain the why.

New models, new tools, latency wins, and bug fixes are all welcome. If you're
planning something large, open an issue first so we can agree on the shape.

## Reporting bugs

Open an issue with your OS, the app version (Settings shows it, or the About
menu), what you did, and what happened. Console logs from the app help a lot.

## License

By contributing you agree that your work ships under the [MIT license](LICENSE).
