# Architecture

How OpenLive fits together, and the few decisions that shape everything else.

## The one big idea: thick client, thin server

The whole voice loop runs **on your machine, in the browser renderer**. The server
is a thin proxy in front of whatever chat model you picked. No audio ever crosses
the wire.

```
┌─────────────────────────── your machine ───────────────────────────┐
│  renderer (apps/web)                          agent (services/agent)│
│                                                                     │
│  mic → VAD → STT → end-of-turn ─┐   /live WS   ┌─ LiveTurnRunner     │
│  (Silero)(Whisper)(Smart-Turn)  ├── text ────▶ │   → model provider  │
│                                 │   +frames    │   (BYO key)         │
│  speaker ← TTS ← sentences ─────┘◀── reply ────┘   ↑ any provider    │
│           (Kokoro)                  (SSE text)      (BYO key)         │
│    ▲ camera / screen frames ────────┘                               │
└─────────────────────────────────────────────────────────────────────┘
```

The `/live` WebSocket carries only three things up: the **final user text** (already
transcribed on-device), **JPEG camera/screen frames**, and a **cancel** signal for
barge-in. It carries one thing down: the model's reply **text**, streamed as it
generates. The browser speaks that text sentence by sentence as it arrives.

Everything above the model — listening, transcribing, knowing when you stopped
talking, speaking — is local. The only thing that leaves is the text turn, the same
call any app would make to a model provider.

## The voice loop (`apps/web/src/lib/live`)

One turn, end to end:

1. **VAD** (Silero) gates the mic — is anyone talking?
2. **STT** (Whisper) transcribes speech to text as it streams.
3. **End-of-turn** (Smart-Turn v3) decides you actually *finished*, not just paused.
4. The final text (plus the freshest camera/screen frame) goes out over `/live`.
5. The model reply streams back as text; **TTS** (Kokoro) voices it sentence by
   sentence so speaking starts before the full answer exists.
6. **Barge-in**: start talking and it stops mid-word — the client aborts the turn
   and the transcript keeps only what was actually spoken.

All four models run on **WebGPU via transformers.js**. They download once (~200 MB,
cached) and the worker stays warm for the tab's life, so the second call skips the
download *and* the shader recompile (`models.worker.ts` warms shaders on load).

## The model turn (`services/agent`)

`LiveSession` owns one WebSocket. `LiveTurnRunner` holds the growing `Message[]`
and drives each turn through `streamProvider` in `packages/harness`, where three
wire adapters cover every provider: **Anthropic** (`/messages` — Claude + MiniMax),
**OpenAI Responses** (`/responses` — OpenAI + Ollama), and **OpenAI Chat**
(`/chat/completions` — Google, xAI, DeepSeek, Groq, Mistral, and the rest). A
provider is just a registry row (id, protocol, base URL, key), so adding one is a
few lines. Reasoning is off by default for the snappiest voice; frames ride only
the two most recent user turns for cost and latency. When a separate vision model
is configured, a text-only live model still sees — the vision model describes the
frames and its description rides the turn.

**Warm-up.** On session open the runner fires a tiny prefill (`warm()`) to heat the
prompt cache and the connection, then the agent sends `{status:"ready"}` so the UI
can drop its "Warming up…" spinner. Cached providers get a genuinely fast first
turn; MiniMax can't prompt-cache, so there it only warms the connection.

## Talk first, delegate the tools

The main voice agent **does all the talking** and never runs a web tool itself. When
an answer needs the real world, it hands the task to a **worker subagent** and keeps
the conversation flowing.

```
you ─▶ main agent ── "let me look that up." ─────────── spoken immediately
                    └ delegate(task)
                         worker subagent (own LLM loop, never spoken):
                           web_search (Exa) · fetch_url        ← activity streams
                           │  (>1.5s? a true progress line is    to the transcript
                           │   spoken: "still searching for …")   as live chips
                         findings ─┘
       main agent ── speaks the answer, short ───────── the worker's context
                                                         stays out of the main one
```

Why a subagent instead of tools on the main agent:

- The multi-step tool grind (search → read → search again) stays in the worker's
  context, so the **main conversation stays small and its non-tool turns stay fast**.
- The worker's tool activity streams to the transcript as live chips and to the
  subtitle ("Searching the web…"), so you *see* it work.
- The worker speaks nothing; only its tight findings come back for the main agent
  to relay in its own voice.

**Web search** uses Exa's hosted MCP server (`mcp.exa.ai`), keyless on the free
tier — same wiring opencode uses. Drop an Exa key in Settings (or `EXA_API_KEY`) to
lift the rate limit. Other tools: `fetch_url` (with an SSRF guard), `look` (a crisp
on-demand camera/screen frame), `remember` (a fact that persists across calls),
`update_todos` (a live checklist), plus `clipboard`/`open_url` in the desktop app.

## Packages

```
packages/harness   model adapters (Anthropic / OpenAI Responses / OpenAI Chat), live model listing, effort
packages/shared    the /live wire protocol + shared types
packages/db        JSON-file store: AES-256-GCM-encrypted keys, settings, conversations
```

`packages/db` is deliberately JSON files, not SQLite — no native modules, so
electron-builder packages the desktop app with no rebuild step.

## The three deployments

`main` is the desktop app (lowest latency: warm local servers, no cold start). Two
branches trade latency for reach: `docker-websocket` (the same WebSocket app as one
Docker image, self-host) and `serverless-sse` (one streaming turn per request, Vercel).
