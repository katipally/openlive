<div align="center">

# OpenLive

### The open voice and vision layer for AI agents.

Bring your own model. Get real-time speech and sight, running on your own machine.
An open alternative to ElevenLabs conversational agents and Gemini Live.

[![Release](https://img.shields.io/github/v/release/katipally/openlive?color=2f6fed)](https://github.com/katipally/openlive/releases/latest)
[![CI](https://github.com/katipally/openlive/actions/workflows/ci.yml/badge.svg)](https://github.com/katipally/openlive/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/katipally/openlive?color=2f6fed)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-2f6fed.svg)](CONTRIBUTING.md)

[![Download for macOS](https://img.shields.io/badge/Download-macOS-0b0b0c?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/katipally/openlive/releases/latest)
&nbsp;
[![Download for Windows](https://img.shields.io/badge/Download-Windows-0b0b0c?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0zIDVsNy0xdjdIM3ptMCAxNGw3IDF2LTdIM3ptOC0xNXY4aDEwVjNsLTEwIDF6bTAgMTZsMTAgMVYxM0gxMXoiLz48L3N2Zz4=&logoColor=white)](https://github.com/katipally/openlive/releases/latest)

</div>

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

You bring the brain (Anthropic, OpenAI, or MiniMax today, more to come). OpenLive
gives it ears, a mouth, and eyes.

<div align="center">
<img src="docs/hero.png" alt="OpenLive home screen" width="720" />
</div>

## Why on-device voice matters

The listening and speaking never leave your computer. Voice activity detection
(Silero), speech-to-text (Whisper), end-of-turn detection (Smart-Turn), and
text-to-speech (Kokoro) all run in the app through `transformers.js` on WebGPU.
The only thing that goes out is the text turn to the model provider you picked, the
same call you would make from any app. No audio uploads, no per-minute meter, no
lock-in.

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
encrypted on disk and the model runs the first time you talk (about 200 MB of voice
models download once and cache).

**Build it from source:**

```bash
pnpm install
pnpm desktop:dev      # runs the web + agent servers and opens the app window
```

You can also run it in a browser during development with `pnpm dev`, then open
`localhost:3000`.

## Benchmarks

Voice agents live or die on latency, so we measure the one number that matters:
voice-to-voice, the gap between you finishing a sentence and the app starting to
speak. The method and the numbers are in [BENCHMARKS.md](BENCHMARKS.md). They come
from real runs, not marketing.

## Repo layout

```
apps/desktop     Electron shell: spawns the local servers, media perms, window, auto-update
apps/web         Next.js UI + the on-device voice engine (src/lib/live/*) + /api settings
services/agent   Hono + ws: the /live WebSocket, tools (fetch_url, look, update_todos)
packages/harness provider-neutral model adapters, live model listing, cost/effort
packages/shared  wire protocol + shared types
packages/db      JSON-file store: encrypted keys, settings, conversations
```

The desktop app ships as a signed, notarized universal build for macOS and an
installer for Windows. Releases are cut from a git tag and built in CI. See the
[release workflow](.github/workflows/release.yml) and the maintainer notes below.

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

## Releasing (maintainers)

CI typechecks every push and PR. A release is one tag, no manual version bump:

```bash
git tag v0.1.5 && git push origin v0.1.5
```

The tag drives the version. CI builds the macOS (universal, signed and notarized)
and Windows installers, uploads them, and publishes the release with the two
downloads shown clearly. Mac signing runs when these repo secrets are set:
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`. Details in [`apps/desktop/README.md`](apps/desktop/README.md).

## License

[MIT](LICENSE). Use it, change it, ship it.
