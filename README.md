<div align="center">

<img src="assets/logo.svg" alt="OpenLive" width="88" height="88" />

# OpenLive

### The open voice and vision layer for AI agents.

Bring your own model. Get real-time speech and sight, running on your own machine.
An open alternative to ElevenLabs, Gemini Live, and OpenAI Realtime.

[![Release](https://img.shields.io/github/v/release/katipally/openlive?color=2f6fed)](https://github.com/katipally/openlive/releases/latest)
[![CI](https://github.com/katipally/openlive/actions/workflows/ci.yml/badge.svg)](https://github.com/katipally/openlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/katipally/openlive?color=2f6fed)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-2f6fed.svg)](CONTRIBUTING.md)

[![Download for macOS](https://img.shields.io/badge/Download-macOS-0b0b0c?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/katipally/openlive/releases/latest)
&nbsp;
[![Download for Windows](https://img.shields.io/badge/Download-Windows-0b0b0c?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0zIDVsNy0xdjdIM3ptMCAxNGw3IDF2LTdIM3ptOC0xNXY4aDEwVjNsLTEwIDF6bTAgMTZsMTAgMVYxM0gxMXoiLz48L3N2Zz4=&logoColor=white)](https://github.com/katipally/openlive/releases/latest)

</div>

## Demo

https://github.com/user-attachments/assets/6ebe0e47-44cb-4d4f-bc33-7f15651e6342

---

## What this is

Wiring an AI agent to a real conversation is harder than it looks. You need voice
activity detection, a way to know when the person actually stopped talking,
streaming speech-to-text, a model turn, streaming text-to-speech, and barge-in so
the user can interrupt. Then you want it to see, so add camera and screen frames on
top. Most people give up and rent a closed platform that meters every minute and
sends the audio to someone else's cloud.

OpenLive is that plumbing, built and open. It connects any chat model to real-time
voice and vision, and the whole voice loop runs on-device. The desktop app is the
reference build: download it, paste a key for the model you want, and talk.

You bring the brain — Anthropic, OpenAI, Google, xAI, DeepSeek, Groq, Ollama, and a
dozen more. OpenLive gives it ears, a mouth, and eyes.

## Features

- **On-device voice loop.** Voice activity detection (Silero), speech-to-text
  (Whisper), end-of-turn detection (Smart-Turn), and text-to-speech (Kokoro) all
  run in the app on WebGPU. Nothing you say leaves the machine.
- **It can see.** Turn on your camera or share your screen and the model watches it
  live, like a video call. The `look` tool grabs a crisp hi-res frame when it needs
  to read a label or a line of code. Running a text-only model? Point OpenLive at a
  separate vision model and it does the seeing while your main model does the talking.
- **Bring your own model.** Over a dozen providers out of the box — Anthropic,
  OpenAI, Google Gemini, xAI Grok, DeepSeek, Mistral, MiniMax, the fast-inference
  hosts (Groq, Cerebras, Together, Fireworks), OpenRouter, Perplexity, and Ollama
  (local or cloud). Models are fetched live from each provider with vision / reasoning
  / context / price surfaced in the picker, and reasoning effort is a dial from Auto
  to Max. It's a layer, not a walled app — fork it to wire up your own agent backend
  or a self-hosted endpoint.
- **Agent tools.** Web search, fetch a URL, remember a fact across calls, and a live
  checklist — plus, in the desktop app, read/write your clipboard and open a URL.
- **Barge-in.** Interrupt any time and it stops mid-word, like a real conversation.
- **Floating mini mode.** Shrink to an always-on-top pill that keeps listening while
  you work; camera and screen previews stack right above it.
- **Resume conversations.** Sessions are saved locally — pick one and carry on.
- **Private by design.** Audio never uploads. API keys are encrypted at rest
  (AES-256-GCM) and only the last four digits are ever shown.

## Screenshots

| Home | In a live call |
|---|---|
| ![Home](assets/home.png) | ![In a live call](assets/hero.png) |
| **Pre-call setup** | **Settings — bring your own model** |
| ![Pre-call setup](assets/lobby.png) | ![Settings](assets/settings.png) |

## Why on-device voice matters

The listening and speaking never leave your computer. The only thing that goes out
is the text turn to the model provider you picked — the same call you would make
from any app. No audio uploads, no per-minute meter, no lock-in.

That also skips the separate speech-to-text, text-to-speech, and real-time-audio
fees hosted platforms charge on top. You still pay your normal model and vision API
costs — nothing more.

## How it works

```
mic ─▶ VAD ─▶ streaming STT ─▶ end-of-turn ─▶ your model ─▶ streaming TTS ─▶ speaker
              (Whisper)         (Smart-Turn)   (BYO key)     (Kokoro)
                                                   ▲
                            camera / screen frames ┘   (vision)
```

Everything above the model runs locally in the renderer. The model turn goes out
over a warm WebSocket to a small local agent, which streams the reply back so the
app can start speaking sentence by sentence. Interrupt any time and it stops mid-word.

## Get started

**Just use it:** grab the installer from the
[latest release](https://github.com/katipally/openlive/releases/latest), open the
app, go to Settings, pick a provider, paste your API key, and start a call. Keys are
encrypted on disk and the voice models download the first time you talk (about
200 MB, cached after that).

**Build it from source:**

```bash
pnpm install
pnpm desktop:dev      # runs the web + agent servers and opens the app window
```

You can also run it in a browser during development with `pnpm dev`, then open
`localhost:3000`.

## Repo layout

```
apps/desktop     Electron shell: spawns the local servers, media perms, window, auto-update
apps/web         Next.js UI + the on-device voice engine (src/lib/live/*) + /api settings
services/agent   Hono + ws: the /live WebSocket, the delegate → worker tool loop
                 (web search via Exa, fetch_url), remember, update_todos, look, clipboard
packages/harness provider-neutral model adapters, live model listing, cost/effort
packages/shared  wire protocol + shared types
packages/db      JSON-file store: encrypted keys, settings, conversations
```

For how the pieces fit together — the thin-server design, the voice loop, and the
delegate/worker tool flow — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Other ways to run it

`main` is the desktop app, which has the lowest latency because the servers run
locally with a warm socket. Two other branches trade some latency for reach:

| Branch | What it is | Where it runs |
|---|---|---|
| `main` | Desktop app (Electron), WebSocket agent | your machine |
| `docker-websocket` | The same WebSocket app as one Docker image | self-host |
| `serverless-sse` | A serverless rewrite, one streaming turn per request | Vercel |

## Contributing

OpenLive is open to contributions. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for
how to set up, where things live, and how to send a change. Good first issues are
labeled in the tracker.

## License

[MIT](LICENSE). Use it, change it, ship it.
</content>
</invoke>
