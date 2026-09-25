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
  shown as chips, answerable by voice. A sentence that crossed an ask on the wire
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
4. The final text (plus the freshest camera/screen frame) goes out over `/live`.
5. The reply streams back as text; **TTS** (Kokoro or Supertonic in the renderer,
   a native engine, or a cloned voice, see below) voices it sentence by sentence so speaking starts
   before the full answer exists.
6. **Barge-in**: start talking and it stops mid-word — the client aborts the turn
   (ACP `session/cancel` for agents) and the transcript keeps only what was spoken.
   The reply's own voice leaking from the speakers into the mic is dropped, never
   sent as a turn.

The renderer models run on **WebGPU via transformers.js**. They download once
(roughly 200 MB with Kokoro, more with Supertonic or a bigger Whisper; cached)
and the worker stays warm for the tab's life.

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
and for the rest of the call. A one-off failure (a timeout, a 500) falls back to
Whisper for that utterance; for speech the same voice tries the sentence once
more and, failing again, leaves it unspoken, so a reply never changes voice
mid-way. The stall clock for a sentence starts when the agent starts
synthesizing it, not while it waits on a cold load or another sentence.

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
service on CPU — the one place in OpenLive with a native module, loaded lazily
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
packages/shared    agent registry + node helpers, /live wire protocol, shared types
packages/harness   model adapters (Anthropic / OpenAI Responses / OpenAI Chat), model listing, effort
packages/db        JSON-file store: AES-256-GCM-encrypted keys, settings, conversations
```

`packages/db` is deliberately JSON files, not SQLite — no native modules, so
electron-builder packages the desktop app with no rebuild step.

## Quality gates

`pnpm typecheck` (all packages) and `pnpm test` (vitest, colocated `*.test.ts`) run
in CI on ubuntu + windows; the windows job also produces an unsigned installer to
prove cross-platform builds stay green.
