# Contributing to OpenLive

Thanks for wanting to help. OpenLive is a small, focused codebase, and it stays
that way on purpose. This guide gets you running and shows where things live.

## Setup

You need Node 22.13 or newer and pnpm (the repo pins the version in
`package.json`). Flow's input addon (`native/ol-input`) is Rust, so the desktop
app also needs Rust from [rustup.rs](https://rustup.rs) plus a C toolchain: the
Xcode Command Line Tools on macOS, the Visual Studio Build Tools ("Desktop
development with C++") on Windows, `build-essential` or equivalent on Linux.
`pnpm desktop:dev` builds the addon when it is missing or its sources changed
(a no-op otherwise); `pnpm native:build` does the same on its own.

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
pnpm voice:bakeoff    # expressive voice engine bake-off, see below
pnpm voiceprint:eval  # voiceprint error rates and latency, see below
pnpm addressee:eval   # side talk check accuracy and latency, see below
pnpm addressee:train  # your own side talk head from the judgment log, see below
pnpm addressee:simulate # a simulated judgment log, for checking the training (macOS)
pnpm converse:eval    # listening sounds over scripted calls, see below (macOS)
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
tools/voice-regress voice continuity check against one-go renders (pnpm voice:regress),
                 and the voice engine bake-off (pnpm voice:bakeoff)
tools/voiceprint  speaker verification eval behind the voiceprint's model and thresholds (pnpm voiceprint:eval)
tools/addressee   side talk eval behind its model, head and threshold (pnpm addressee:eval),
                 and the user's own head from the judgment log (pnpm addressee:train)
tools/converse    scripted calls through the real turn-taking, for listening
                 sounds (pnpm converse:eval)
```

The voice loop (VAD, STT, end-of-turn, TTS — Kokoro, Supertonic, or a cloned
voice — and barge-in) is in `apps/web/src/lib/live`. The model turn goes out from
`services/agent`, which either streams a provider reply or drives a coding agent
(Claude Code, Codex, Cursor, OpenCode, Hermes) over ACP as a child process.

## Voiceprint eval

`pnpm voiceprint:eval` measures how well each candidate speaker embedding model
tells an enrolled user from other voices, through the agent's own worker: the
40 LibriSpeech test-clean speakers (CC BY 4.0) each enrolled on about 15 s,
against the other 39 and the agent's own voices, each utterance also heard
through a narrow quiet mic, an overdriven one, an echoey room, 4-talker babble,
pink noise and all of those at once. It prints the equal error rate, the
threshold that blocks at most `--frr` (default 1%) of the user's trials, and
the false accept rates at it, per window of speech (0.5, 1, 2, 4 s and whole),
plus the extraction time. The thresholds in
`services/agent/src/voice/voiceprint.ts` come from it.

```bash
pnpm voiceprint:eval                                  # every candidate model, about 6 minutes each
pnpm voiceprint:eval --models campplus-zh-en --frr 0.02 --json out.json
```

It needs `ffmpeg` on the PATH. LibriSpeech (347 MB) and the models download
into `VOICEPRINT_CACHE` or the OS cache dir under `openlive-voiceprint`, the
models checked against pinned SHA-256 sums; the agent's voices come from the
engines `pnpm voice:regress --engine all` has downloaded, and any missing one is
skipped with a message.

## Side talk eval

`pnpm addressee:eval` measures the side talk check: the sentence embedding
model, through the agent's own worker, with a logistic head fitted on
`tools/addressee/data/train.en.json` and the context rules of
`packages/shared/src/speech/addressee.ts`, on held-out English and nine-language
splits. The data is synthetic, written for the eval (no openly licensed corpus
of room side talk was found). It prints AUC, the share of addressed sentences
ignored, side talk caught and precision, with the voiceprint off and labelling
voices, plus the embedding time. The threshold ignores at most `--rate`
(default 1%) of the training split's addressed sentences, scored out of fold.
`--write` saves the head as `packages/shared/src/speech/addressee-head.ts`.

```bash
pnpm addressee:eval                        # about 300 MB download, then under a minute
pnpm addressee:eval --rate 0.02 --json out.json
```

The model downloads into `ADDRESSEE_CACHE` or the OS cache dir under
`openlive-addressee`, checked against pinned SHA-256 sums.

`pnpm addressee:train` fits a head on the training split plus the judgment log
the agent keeps when Settings → Voice → Turn-taking → Side talk → "Keep a
judgment log to train on" is on (docs/ARCHITECTURE.md). It reads the log and
the downloaded model from the agent's data dir (`OPENLIVE_DATA_DIR`, else the
default), prints the log's out-of-fold numbers for the shipped head and the new
one with and without the sound features, and the synthetic held-out splits, and
writes `addressee-head.json` beside the log. The agent uses it only when its
eval passed. `--dry` prints without writing; `--rate` sets the share of your
addressed sentences it may ignore (default 1%).

`pnpm addressee:simulate` fills a log with no one talking: each held-out
English sentence rendered by `say -o` (to a file, never played) in two voices
at levels 6 dB apart, transcribed by a running agent and judged there with the
log on, labelled with its truth. `--cue level` renders side talk 6 dB quieter,
a planted cue the sound features should find. Point it at a standalone agent
with a scratch data dir, never your own:

```bash
AGENT_PORT=48787 OPENLIVE_DATA_DIR=/tmp/ol-sim pnpm --filter @openlive/agent start   # needs the side talk model and the STT engine in that dir
AGENT_URL=http://127.0.0.1:48787 pnpm addressee:simulate --cue none
OPENLIVE_DATA_DIR=/tmp/ol-sim pnpm addressee:train --dry
```

Its log is drawn from the held-out English split, so that split's numbers after
training on it are not held out.

## Listening sounds eval

`pnpm converse:eval` plays scripted conversations (`say -o`, never aloud)
through the app's own VoiceEngine in real time: vad-web's Silero v6 frame
processor with the browser's settings, the agent's streaming speech-to-text
(`STT`, default Nemotron English), Smart-Turn v3, and the agent's built-in
brain with its configured model over `/live`. Speech is not synthesized, so the
latency is end of speech to the first reply audio handed to the player. It runs
each conversation with listening sounds off and on and prints p50 / p95
latency, and the listening sounds with any overlap with the user's speech. Each
turn is a real model call: run it against a scratch agent.

```bash
OPENLIVE_DATA_DIR=/tmp/ol-eval AGENT_PORT=47901 pnpm --filter @openlive/agent start   # the model and Nemotron set up there
AGENT_URL=http://127.0.0.1:47901 ROUNDS=2 CONVERSE_OUT=out.json pnpm converse:eval
```

Smart-Turn and its feature extractor download into `CONVERSE_CACHE` or
`~/Library/Caches/openlive-converse`.

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

## Voice engine bake-off

`pnpm voice:bakeoff` weighs a candidate voice engine against the ones the app
ships, on this computer. It runs the agent's own benchmark on every execution
provider the device has and renders on the one the agent would pick, then
renders the regression corpus, four replies full of numbers and dates (as
`toSpeech` speaks them) and, for an engine that takes them, six lines ending in
a tag like `[laugh]`. It reports first audio and real-time factor (median and
95th percentile), the regression's join metrics, word error rate through
Parakeet, a quality score from UTMOS22 (MIT), whether each tag was performed
(the CED AudioSet tagger, Apache-2.0, over the end of the line, and the tag not
read out), languages, size and RAM. Audio goes to files; nothing plays.

```bash
pnpm voice:bakeoff --engine chatterbox-turbo --out bake   # one engine per run, so RAM is its own
pnpm voice:bakeoff --engine supertonic-agent --out bake
pnpm voice:bakeoff --engine kokoro-native --out bake
pnpm voice:bakeoff --table bake                          # the results side by side
```

Models download into the same cache as `voice:regress`, checked against the
sums pinned in `src/bakeoff.ts`. Chatterbox-Turbo alone is 1.4 GB, and UTMOS
0.4 GB. A run takes 5 to 15 minutes per engine. The word error rate and tag
scoring have unit tests (`src/score.test.ts`) in `pnpm test`.

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
