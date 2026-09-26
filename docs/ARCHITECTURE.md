# Architecture

How OpenLive fits together, and the few decisions that shape everything else.

## The one big idea: thick client, thin server

The whole voice loop runs **on your machine, in the browser renderer**. The local
agent server is a thin driver in front of the brain you picked — an external coding
agent over ACP, or a chat-model provider. No audio ever crosses the wire.

```
┌──────────────────────────────── your machine ────────────────────────────────┐
│  renderer (apps/web)                        agent server (services/agent)    │
│                                                                              │
│  mic → VAD → STT → end-of-turn ─┐  /live WS  ┌─ LiveSession                  │
│  (Silero)(Whisper)(Smart-Turn)  ├─ text ───▶ │   ├─ AcpAgent ── stdio ──▶ your coding agent
│                                 │  +frames   │   │  (supervised)   (Claude Code / Codex / …)
│  speaker ← TTS ← sentences ─────┘◀─ reply ───┘   └─ or: provider turn loop   │
│           (Kokoro)                 (SSE text)         (BYO model key)        │
│    ▲ camera / screen frames ────────┘                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

The `/live` WebSocket carries text turns + JPEG frames up and streamed reply text
down (plus permission asks, agent metadata, and control messages — see
`packages/shared/src/live-events.ts`). The browser speaks the reply sentence by
sentence as it arrives.

## The agent registry (`packages/shared/src/agent-registry.ts`)

The **single source of agent identity**. Every agent's id, label, brand mark, ACP
adapter command, install/uninstall recipes, login/logout commands, session-store
location + parser, and credential probe lives in one table. The server driver, the
API routes, the History sidebar, and every selector read it — adding an agent is one
entry, and the whole UI (including History discovery) picks it up automatically.
Node-only helpers (credential probing, PATH widening, terminal launch) live in
`@openlive/shared/node`.

Two adapter versions are **pinned** on purpose (guarded by unit tests):
`claude-agent-acp@0.59.0` (OpenLive relies on its `_meta.claudeCode.options`
passthrough) and `hermes-agent[acp]==0.18.2`.

## Driving a coding agent over ACP (`services/agent/src/agents/`)

`AcpAgent` spawns the agent's ACP adapter as a child process and speaks JSON-RPC
over stdio ("LSP for agents"). Design points:

- **No faked capabilities.** OpenLive advertises no fs/terminal capabilities — a
  voice app isn't an editor. The agent uses its own file access and asks permission
  (via `session/request_permission`) before anything risky; the ask is spoken and
  shown as chips, answerable by voice. A "yes" or "no" to it ends the turn at
  once, with no mid-thought hold, and once the question is voiced the orb shows
  the reply waiting on you (listening), not speaking. A sentence that crossed an ask on the wire
  was said before it showed, so the ask is refused and the sentence runs as a turn.
  Outside a turn only a request-scoped elicitation (sign-in or setup before any
  session) is shown; a session-scoped one is a finished turn's and is refused.
- **Sessions belong to the agent.** For Claude, `_meta.claudeCode.options` rides
  `session/new`/`session/load` with `persistSession: true` (sessions land in
  `~/.claude/projects/<cwd-slug>/` where `claude --resume` finds them) and a
  system-prompt append carrying the voice-call context. `CLAUDE_CODE_ENTRYPOINT=
  claude-vscode` keeps them visible in the CLI's `/resume` picker. Other agents get
  a first-turn preamble instead.
- **Resume.** Reopening a conversation calls `session/load`; the replayed updates
  rebuild the transcript. Resume failures fall back to a fresh session silently
  (the original stays on disk and in History).
- **Models / modes / options.** The agent reports its models, modes, and other
  config options over ACP; the UI renders pickers generically and switches them
  mid-session (`set_model` / `set_mode` / `set_option`).
- **Supervision.** Every agent runs inside `AgentSupervisor`: per-turn watchdogs
  (start / first-output / stall), restart-once-then-fail, and every failure ends as
  a *spoken* one-liner + structured error — never a session stuck listening.
- **Cleanup.** Adapters spawn in their own process group so dispose kills the whole
  `npx → node → binary` tree.

History also surfaces each agent's **own** on-disk sessions
(`apps/web/src/app/api/history/agentSessions.ts` — Claude JSONL, Codex rollouts,
Cursor meta, OpenCode/Hermes read-only sqlite), deduped against OpenLive's chats,
so everything you did in the CLI shows up too.

## The voice loop (`apps/web/src/lib/live`)

One turn, end to end:

1. **VAD** (Silero v6.2, v5 selectable) gates the mic: is anyone talking?
2. **STT** (Whisper in the renderer, or a native engine) transcribes speech to
   text as it streams.
3. **End-of-turn** (Smart-Turn v3) decides you actually *finished*, not just paused.
   What you say over the agent's reply is a barge-in and goes out as soon as you
   stop, with no mid-thought hold.
4. The final text (plus the freshest camera/screen frame) goes out over `/live`,
   with each word's onset in ms into the turn's audio (`wordsAt`, the turn's
   speech segments back to back). Parakeet and Nemotron time their own tokens
   (`tokenOnsets` in `timing.ts`, from sherpa-onnx's `timestamps`); Whisper,
   Moonshine and Canary report none, so the words are placed on the mic audio
   the way the agent's are on its voice (`heardOnsets`). The server saves them
   on the user message and in Flow's transcript, for later speaker labelling;
   the user's caption does not use them, since a word is only known once it is
   transcribed, already after it was said.
5. The reply streams back as text; **TTS** (Kokoro or Supertonic in the renderer,
   Supertonic on the agent, a native engine, or a cloned voice, see below) voices it sentence by sentence so speaking starts
   before the full answer exists. A chunk only ever ends at a sentence end (or
   at the 200-character cap): every engine voices the end of its text as the
   end of an utterance, so a cut at a comma would pause and restart the voice.
   The worker trims each Kokoro or Supertonic render to its speech, keeping the
   pause that engine makes between sentences inside one render, so chunks
   played back to back join like one render (`KEEP_S` in
   `packages/shared/src/speech/trim.ts`, the agent's worker trims Supertonic the same way). Native
   Piper and Matcha sentences end with next to no silence, or with a quiet hiss
   that plays as a long pause, depending on the voice; the agent's worker fits
   each one to 10 ms before its speech and 50 ms after (`SENTENCE_EDGE_S` in
   `native-worker.ts`), the pause they make between sentences inside one render.
   `pnpm voice:regress` guards this: it renders a corpus of replies through the
   real chunker, synthesis and trimming, and fails when the joins drift from
   one render of the same reply (`tools/voice-regress`, see CONTRIBUTING.md).
   Each chunk is shown as the model wrote it and spoken as a person would say
   it: `toSpeech` (`packages/shared/src/speech/normalize.ts`, once per chunk,
   before any engine's own cleanup) spells out numbers, dates, times, money,
   units, percentages, ranges, phone numbers, versions, emails, URLs, file
   names, code identifiers, initialisms and symbols in the session language.
   Table and list furniture (column bars, `|---|` rules, box drawing, bullets)
   is a pause between words and nothing at an edge.
   Number words come from n2words, structure (decimal marks, unit and currency
   names and plurals, date order) from `Intl`. The chunker never cuts inside
   such a token ("3.5", "e.g.", "No. 5", "am 3. Oktober"), so a chunk reads as
   the whole reply would. A chunk that grows past what one engine call takes
   (spelled-out prices) is split at a word (`speechPieces`). The user's
   pronunciation dictionary (`pronunciations` in the pipeline config,
   `lexicon.ts`) matches the text as written, one trie-shaped regex per case
   mode, and its respellings are spoken exactly as typed.
   The caption and the transcript reveal each word when it is voiced. No engine
   reports word timing, so `packages/shared/src/speech/timing.ts` places the
   words on each piece's synthesized audio: `normalizeAligned` maps every spoken
   character back to the word it was written as, so a word weighs what it takes
   to say ("$1,200" as "one thousand two hundred dollars"); the voice's pauses
   of 90 ms or more are matched to word boundaries in order, punctuation first;
   between two of them the words share the voiced frames by weight. Chinese and
   Japanese characters are words of their own. Until a streamed piece is all in,
   its words are paced by the engine's estimated rate, and the caption on screen
   is retimed once it is (`onAgentTiming`).
6. **Barge-in**: start talking and it stops mid-word — the client aborts the turn
   (ACP `session/cancel` for agents) and the transcript keeps only what was spoken:
   the sentences voiced, then the words of the playing one begun by the cut, as
   its caption revealed them (`cutReply`, `heardText`). The server saves the same
   text. Hanging up mid-reply is the same cut, sent before the socket closes.
   The reply's own voice leaking from the speakers into the mic is dropped, never
   sent as a turn.
   A sound over a reply, or over a turn still at work, first only pauses it
   (`AudioPlayer.hold`: the audio clock stops, caption with it). Interim captions
   decide nothing here (Whisper reads half a laugh as "have a"): the final with
   any word that is not a backchannel or filler (`isBackchannel`, a
   list per language, plus laughs and throat sounds spelled out: a repeated
   syllable, "ugh", "ahem") cuts it as above, and so does more than 1.5 s of voiced
   talk before any words are in. The reply is silent meanwhile, so waiting on
   the final costs nothing audible. A cough, a laugh or a bare "mm-hmm" resumes it
   from the same sample, the segment dropped. A cut over a paused reply runs
   the audio clock again (`AudioPlayer.flush`). Outside a reply "yeah" is an
   answer and is sent; push-to-talk and a pending ask work as before.

The renderer models run on **WebGPU via transformers.js**. They download once
(roughly 200 MB with Kokoro, more with Supertonic or a bigger Whisper; cached)
and the worker stays warm for the tab's life.

**Model licenses.** Settings → Voice shows each engine's on its card, and Piper's
per voice in its Model menu. Silero VAD and Moonshine: MIT. Smart-Turn:
BSD-2-Clause. Whisper, Kokoro (browser and CPU), Kitten TTS and Matcha: Apache 2.0
(Matcha's LJSpeech data is public domain). Supertonic, the default voice:
[OpenRAIL-M](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE),
which allows commercial use but forbids some uses. Parakeet and Canary: CC BY 4.0.
Nemotron: NVIDIA Open Model License; Nemotron 3.5: OpenMDW-1.1. Pocket TTS: CC BY
4.0, its ONNX export non-commercial. Piper: per voice, its own dataset's
license, with the voice it was fine-tuned from named for information (`PIPER`
in `native-models.ts`); lessac's Blizzard 2013 data is research-only. Cloned voices
(ZipVoice): Apache 2.0 code, no license stated for the weights, trained on
Emilia (CC BY-NC 4.0).

**Restricted licenses are opt-in.** A model is open when its license is MIT,
Apache, BSD, CC BY or looser, or OpenMDW, with no restricting qualifier; the
exceptions, by choice, are Supertonic's OpenRAIL-M (the default voice) and the
NVIDIA Open Model License (Nemotron English). A Piper voice is judged by its own
data's license, not the voice it was fine-tuned from, so the CC0, CC BY and
BSD-style ones are open (`PIPER_OPEN`). Every other model (Pocket TTS, cloned
voices and the Piper voices whose data is research-only, non-commercial,
share-alike, AGPL or unknown) is marked
`restricted` in `pipelineConfig.ts`, and `web-catalog.test.ts` checks that
against the agent's license strings through `licenseTag` (`engineMenu.ts`).
Settings shows those locked; picking one asks first, inline, with what the
license limits and a link, and the OK is saved as `allowRestricted` in the
pipeline config. Without it `chooseVariant` refuses a restricted variant, and
the family defaults, `LANGUAGE_DEFAULTS`, the language-switch picks
(`pickCompatible`) and the browser fallbacks never land on one, so neither does
a warm-up, which only loads the selected engines. A config that already had one
keeps it, and Settings says what its license limits.

**Supertonic on this computer.** On the desktop the agent can run Supertonic
itself, on onnxruntime-node, with the synthesis the browser runs
(`packages/shared/src/speech/supertonic.ts`: the same text preprocessing, the
same seeded noise, the same trim), so both render the same voice. It is a
native engine of its own family (`supertonic-3`, marked `browser: "supertonic"`
in `native-models.ts`), downloaded from Settings → Voice into
`data/models/supertonic-3` file by file from the Hugging Face revision the
regression check pins. It is not a choice of its own: with Supertonic picked,
each call asks the agent once whether its copy is downloaded and can run here
(`GET /voice/engines`, `runnable`: onnxruntime-node ships no binary for Intel
Macs), and if so streams every sentence from it through `/api/voice/tts` and
loads nothing in the browser. A lasting failure (not downloaded, not runnable,
no agent) gives way to the browser's Supertonic, the same voice, quietly and for
the rest of the call; a one-off is tried again on the agent, as for any native
engine. Where it runs follows the native engines' rules below, over
onnxruntime-node's own providers (cpu, webgpu and coreml on Apple Silicon;
DirectML and WebGPU on Windows; CPU, and CUDA once its libraries are installed,
on Linux). Kokoro has no such copy: the sherpa-onnx Kokoro family already runs
the same Kokoro-82M v1.0 weights and voices on the agent, benchmarked the same
way, and kokoro-js cannot be given a thread count.

The **native engines** (`services/agent/src/voice/native*.ts`) are optional
sherpa-onnx models that the agent service downloads into `data/models/<id>` from
Settings → Voice. The catalog groups them in families of variants (size,
precision, chunk latency, voice): Nemotron and Nemotron 3.5 (streaming),
Parakeet, Moonshine and Canary for speech to text, Pocket TTS, Kitten TTS, Piper,
Kokoro and Matcha for speech. Each variant lists the languages it speaks; a call
may name one (`lang`, ISO 639-1) and an engine that does not speak it refuses
with `language-not-supported`. They run on the agent's CPU in worker threads,
at most two loaded models per worker. Batch transcription and synthesis go through `/api/voice`, and speech
streams back as raw Float32 PCM while it is generated. Nemotron takes mic frames
over the `/voice/stream` socket and sends partials while you talk. A missing
engine, an unreachable agent, or a voice engine that never starts on two
sentences in a row switches the call to Whisper or the browser voice
that speaks the session language (Kokoro for English, Supertonic otherwise), once
and for the rest of the call. A missing engine is expected, not an error: its
Settings card reads "Not downloaded, using ..." and the call lobby offers the
download (`missingEngines`, `engineMenu.ts`). A one-off failure (a timeout, a 500) falls back to
Whisper for that utterance; for speech the same voice tries the sentence once
more and, failing again, leaves it unspoken, so a reply never changes voice
mid-way. The stall clock for a sentence starts when the agent starts
synthesizing it, not while it waits on a cold load or another sentence.

**Where native engines run** is decided on each user's own device
(`voice/device.ts`, `voice/accel.ts`). At agent start a local probe records the
OS and version, CPU, logical, physical and (Apple Silicon) performance cores,
RAM, GPUs and driver, and the power source (sysctl, system_profiler and pmset on
macOS; one CIM query on Windows; nvidia-smi, lspci, /proc and /sys on Linux),
plus the execution providers compiled into each installed ONNX Runtime: sherpa-onnx's
(CoreML in the sherpa-onnx 1.13.8 darwin builds; the win and linux builds are CPU
only) and onnxruntime-node's (its `listSupportedBackends`, for Supertonic).
Any probe may fail; its field is left out and the choice stays on CPU. Each
engine gets a thread share of that device's fast cores (`threadsFor`) and a
performance tier (low, mid, high) for recommending engines. Every engine starts
on CPU. After its first use, once the voice path has been idle for 30 s, a
benchmark times it on each usable provider in a child process of its own
(`native-worker.ts` forked with `ELECTRON_RUN_AS_NODE`, so Electron's binary
runs it as Node in the packed app and tsx's loader carries over in dev): load,
first run, then the median first-output time and real-time factor of a fixed
input. A native crash, any other exit or a 2 minute timeout fails only that
provider. An accelerator is used only if it cuts CPU's real-time factor by 20% or
more. Load time, which holds CoreML's compile, never counts toward that. Any
voice job aborts a running benchmark and kills its process, as does the agent
exiting; an engine whose benchmark took the agent down twice anyway stays on CPU. Results live in `data/voice-accel.json`,
keyed by the device fingerprint, the variant and its files, so a new device,
runtime or download measures again. A provider that fails in a real call is
retired for that engine and the next load runs on CPU. Settings → Voice shows the
device, and per engine where it runs, the numbers behind it, an Auto / CPU /
accelerator override and "Re-run benchmark" (`GET /voice/perf`,
`PUT /voice/perf/engines/:id`, `POST /voice/perf/engines/:id/bench`).
`pnpm --filter @openlive/agent bench:voice` prints the same benchmark for every
installed engine, for developers; the app never reads it.

The **latency budget** (`lib/live/perf.ts`) records each turn's speech-to-text
plus end of turn, model to first token, and voice to first sound, measured on the
device. The call's top bar shows the session's median voice-to-voice time, and
its popover the median and p95 of each stage.

A session runs in **one language** (`language` in `pipelineConfig.ts`: en, es, fr,
de, it, pt, hi, zh, ja, ko) and every stage follows it: STT gets `lang` (Whisper
switches from its `.en` build to the multilingual build of the same size and
pins the language), TTS gets it (Supertonic as its language tag), the chunker
splits on Chinese, Japanese and Devanagari sentence marks, and the English
turn-taking word list applies to English only. Each `user_text` / `flow_text`
carries it, and the reply follows: one "Always reply in …" line in the built-in
model's system prompt, or at the head of the turn for a coding agent over ACP.
English adds nothing. The `/live` connect URL carries it too (`?lang=`), so the
connect-time warm-up primes the prompt cache in it. `pickCompatible` swaps an
engine that cannot speak a newly chosen language for one that can. In Settings →
Voice the Language picker sits above the stages; each family is one card with a
Model menu of its variants, and a family or variant that cannot speak the
language is greyed out with the languages it can.

## Voice cloning (`services/agent/src/voice/`)

Voice Studio does zero-shot cloning with **ZipVoice** (k2-fsa, Apache-2.0, 123M
distilled int8) through the **sherpa-onnx Node addon**, running in the agent
service on CPU, on the device's thread share (above), the one place in OpenLive with a native module, loaded lazily
via `createRequire` so nothing changes for people who never use it. The reference
recording rides every `generate()` call, so one engine instance serves every
saved profile; `generateAsync` synthesizes on sherpa's native thread pool
(measured ~0.22x realtime on an M-series CPU) and the engine unloads after five
idle minutes. The model is a user-managed ~208 MB install under
`data/models/zipvoice`, profiles are a wav + transcript under `data/voices`, and
the renderer reaches it all through a same-origin `/api/voice` proxy — the
cloned audio streams back as raw Float32 PCM into the same `AudioPlayer` /
barge-in path as the on-device engines, with Kokoro as automatic fallback.

## The built-in provider brain (`services/agent/src/live/turn-runner.ts`)

Conversations with no agent bound run on a provider turn loop: three wire adapters
in `packages/harness` (Anthropic `/messages`, OpenAI `/responses`, OpenAI
`/chat/completions`) cover every provider; a provider is a registry row. The main
voice agent does all the talking and delegates web work to a **worker subagent**
(Exa search, `fetch_url`) whose grind stays out of the main context; other tools:
`look`, `remember`, `update_todos`, clipboard/open-url via the desktop bridge.

## Flow (`services/agent/src/flow/`, `apps/desktop/flow-*.cjs`)

Flow is the voice assistant for the whole machine, summoned with a double tap of
`Control`. A hidden owner renderer (`/flow-owner`) runs the same voice loop and a
second `/live` connection (`live/flow-ws.ts`); an always-on-top orb window (`/flow`)
only draws what the owner publishes. On the server, `runFlow` loops turns and tool
calls on a `LocalBrain` (provider) or an `AcpBrain` (coding agent, which gets the
same tools over a local MCP server). Device tools reach the `native/ol-input` Rust
addon through the owner renderer and `flow-runtime.cjs` in the main process. Config
and history live in `~/.openlive/flow` via `packages/flow-store`.

Full user and developer guide: [FLOW.md](FLOW.md).

## Packages

```
packages/shared    agent registry + node helpers, /live wire protocol, shared types, speech text normalization
packages/harness   model adapters (Anthropic / OpenAI Responses / OpenAI Chat), model listing, effort
packages/db        JSON-file store: AES-256-GCM-encrypted keys, settings, conversations
```

`packages/db` is deliberately JSON files, not SQLite — no native modules, so
electron-builder packages the desktop app with no rebuild step.

## Quality gates

`pnpm typecheck` (all packages) and `pnpm test` (vitest, colocated `*.test.ts`) run
in CI on ubuntu + windows; the windows job also produces an unsigned installer to
prove cross-platform builds stay green.
