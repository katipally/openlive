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

`pnpm desktop:dev` opens Chrome DevTools Protocol on port 9333 (packaged builds open no debugging port). A test there opens or closes Flow exactly as a double Ctrl does by running `await openlive.flow.trigger("flow", true)` in the main window. The trigger exists only in dev builds.

For UI work you often don't need the whole desktop shell:

```bash
pnpm dev              # web + agent only, open http://localhost:3000
```

Useful scripts:

```bash
pnpm typecheck        # tsc across every package (CI runs this)
pnpm test             # unit tests (vitest; CI runs this)
pnpm voice:regress    # voice continuity check, see below
pnpm desktop:build:mac # build the macOS app locally
pnpm desktop:build:win # build the Windows installer (run on Windows)
```

## Where things live

```
apps/desktop     Electron shell: local servers, permissions, window, Flow's orb,
                 tray + notifications, auto-update
apps/web         Next.js UI + the on-device voice engine in src/lib/live + /api
                 routes (agent install/auth, history discovery, settings)
services/agent   the /live WebSocket, the ACP coding-agent driver (agents/*),
                 local voice cloning (voice/*), and the built-in model tools
packages/harness model adapters (Anthropic / OpenAI Responses / OpenAI Chat), model listing
packages/shared  the agent registry (single source of agent identity), wire
                 protocol, shared types
packages/db      JSON-file store for keys, settings, conversations
tools/voice-regress voice continuity check against one-go renders (pnpm voice:regress)
```

The voice loop (VAD, STT, end-of-turn, TTS — Kokoro, Supertonic, or a cloned
voice — and barge-in) is in `apps/web/src/lib/live`. The model turn goes out from
`services/agent`, which either streams a provider reply or drives a coding agent
(Claude Code, Codex, Cursor, OpenCode, Hermes) over ACP as a child process.

## Voice regression check

`pnpm voice:regress` streams 14 replies (`tools/voice-regress/corpus.json`)
through the app's own sentence chunker, synthesizes each chunk as the app
speaks it (the agent's native worker, or the browser engines' trimming), plays
the chunks back to back and compares every join with one render of the whole
reply: pitch step, pause, loudness step, the pitch a chunk starts on, lead and
tail silence, length, and broken audio (NaN, clipping, silent chunks). It fails
past a threshold or when a metric drifts from `baseline/<engine>.json`.

```bash
pnpm voice:regress                    # fast tier (Kitten nano, browser Kokoro), as PR CI runs it
pnpm voice:regress --engine all       # plus sherpa Kokoro and Matcha, as the nightly job runs it
pnpm voice:regress --engine supertonic,supertonic-agent # local only: its OpenRAIL-M license keeps it out of CI; browser and agent paths side by side
pnpm voice:regress --engine piper-lessac # local only too: its dataset license is research-only
pnpm voice:regress --update           # rewrite the baselines after an intended change
pnpm voice:regress --chunker path/to/voiceText.ts --report out  # try another chunker, keep per-join JSON
```

Models download on first use into `VOICE_REGRESS_CACHE`, or the OS cache dir
(`~/Library/Caches`, `~/.cache` or `%LOCALAPPDATA%`, under
`openlive-voice-regress`), and are checked against the SHA-256 sums pinned in
`src/engines.ts`. Offline with nothing cached, an engine is skipped with a
message (`--strict` fails instead, as CI does). The run takes two to five minutes
per engine on a laptop CPU. The sherpa engines (Kitten, Kokoro, Piper, Matcha)
render a little differently every run, so their drift allowance is wider;
Kitten, the PR gate, renders the corpus three times at once and gates on the
metrics pooled over the three, so its noise never fails a pull request
(`renders` in `src/engines.ts`, with the measurements behind it). Browser Kokoro
and Supertonic render the same every time, and `supertonic-agent` (the same
Supertonic on onnxruntime-node, as the agent runs it) matches the browser's. The analyzer has unit tests (`src/analyze.test.ts`)
in `pnpm test`.

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
