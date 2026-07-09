# OpenLive

A live voice + vision AI assistant. Talk to it, show it your camera, and it talks
back in real time.

The trick: the whole voice pipeline runs **in your browser** — voice activity
detection (Silero), speech-to-text (Whisper), end-of-turn detection (Smart-Turn),
and text-to-speech (Kokoro), all on-device via `transformers.js` + WebGPU. No
audio ever leaves your machine. Each completed turn is a single streaming request
to a serverless route that runs an ordinary chat-completion against the LLM you
pick and streams the reply text back — which the browser speaks sentence-by-
sentence as it arrives. Barge-in just aborts the request.

This is the **serverless / BYOK** build (deploys to Vercel). For the self-hosted
version with a persistent WebSocket agent + encrypted server-side key store, see
the [`docker-websocket`](../../tree/docker-websocket) branch.

## Using it

1. **⚙ Settings** → pick a provider (Anthropic / OpenAI / MiniMax) → paste your
   API key → **Save**. The key is stored in your browser (localStorage) and sent
   per request to your own serverless function, which calls the provider — so
   every provider works (no browser-CORS limits) and the key never goes to any
   third party.
2. Pick a model. The list is fetched live from the provider, annotated with
   vision / reasoning / cost. Effort defaults to the lowest the model supports
   (smoothest voice); raise it for depth over latency.
3. **Start a live call** → download the on-device voice models once (~200 MB,
   cached after) → **Start** → talk. Turn the camera on to show it things.

> Your key lives in this browser profile. Use a spend-limited key.

## Running locally

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

Everything is configured in the UI — no `.env` required.

## Layout

```
apps/web
  src/lib/live/*        on-device voice engine (VAD, STT, turn-detect, TTS) + camera
  src/lib/turn/run.ts   server-side turn logic (tool loop, prompt) — used by the route
  src/app/api/turn      streaming SSE route: one live turn, all providers, server-side
  src/app/api/models    live model list for a provider (key via header)
  src/components/live/*  orb-center in-call UI + always-on transcript + lobby
  src/components/settings ONE provider → key → model → effort flow
packages/shared         SSE event schema + shared types
packages/harness        provider-neutral LLM adapters, live model listing, cost/effort
```

## Deploy to Vercel

1. Push this repo to GitHub (done: `katipally/openlive`).
2. In Vercel: **New Project** → import the repo.
3. Set **Root Directory** to `apps/web` (Vercel then installs the pnpm workspace
   from the repo root and builds the Next.js app).
4. Deploy. No environment variables required — keys are entered in the UI.

The `/api/turn` route runs on the Node runtime and streams responses, which
Vercel's Hobby (free) plan supports. Reasoning turns are short, well within the
function duration limit.
