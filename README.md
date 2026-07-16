<div align="center">

<img src="assets/logo.svg" alt="OpenLive" width="88" height="88" />

# OpenLive

### The open voice and vision layer for AI agents.

Your AI can think. OpenLive gives it ears, a mouth, and eyes.
Bring your own model, or talk to the coding agents you already use, with the whole
voice loop running on your own machine. An open alternative to ElevenLabs Agents,
Gemini Live, and OpenAI Realtime.

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

Wiring an AI into a real conversation is harder than it looks: voice activity
detection, knowing when someone actually stopped talking, streaming speech-to-text,
the model turn, streaming text-to-speech, and barge-in so you can interrupt. Then
camera and screen on top. Hosted platforms rent you that pipeline by the minute and
run it on their cloud.

OpenLive is that pipeline, open and local. The listening, the speaking, and the
watching all run on-device (WebGPU). You bring the brain, and any brain works:

- **A model you have a key for.** Anthropic, OpenAI, Google, xAI, DeepSeek, Groq,
  Ollama (fully local), and a dozen more. No per-minute audio fees; you pay only
  the model costs you'd pay anyway.
- **The coding agent you already use.** Claude Code, Codex, Cursor, OpenCode, or
  Hermes, driven locally over the
  [Agent Client Protocol](https://agentclientprotocol.com) (JSON-RPC over stdio),
  under your own login. Talk to your agent, watch it work, answer its permission
  asks by voice.

Whichever brain you pick, OpenLive is the same thing it has always been: the ears,
mouth, and eyes around it. Nothing you say leaves the machine. The only thing that
goes out is the final transcript (plus camera or screen frames if you turn them on),
to whatever brain you picked.

An honest note on architecture: OpenLive is a cascaded pipeline (speech to text to
model to speech), not a full-duplex speech-to-speech model like GPT-Live. That's a
real trade. A speech-native model can overlap talk and listen in ways a cascade
can't, but the cascade is exactly what makes "any brain, all local, no audio fees"
possible.

## Features

The core, the ears / mouth / eyes:

- **On-device voice loop.** Silero VAD, Whisper STT, Smart-Turn end-of-turn, and
  your pick of two TTS engines: Kokoro (28 voices, light) or Supertonic (10 voices,
  44.1 kHz). All of it runs in the app on WebGPU.
- **Speak as yourself.** Settings → Clone Voice records 5 to 30 seconds of you
  (with a seekable listen-back before anything is saved) and your assistant speaks
  in your voice from then on. Zero-shot cloning (ZipVoice, Apache-2.0) running
  locally, an optional ~208 MB install, deletable anytime. Profiles preview with any
  text, rename, and export/import between machines. Clone only your own voice or
  one you have clear permission to use; impersonation is on you, not the tool.
- **It can see.** Camera or screen frames ride each turn, and the `look` tool grabs
  a crisp hi-res frame on demand. A text-only model can borrow a separate vision
  model's eyes.
- **Barge-in.** Interrupt any time and it stops mid-word, like a real conversation.
- **Your assistant, your way.** Custom instructions in Settings → General apply to
  every brain, built-in or agent. Speaking speed and spoken progress narration live
  there too.

The integrations that serve it:

- **Voice-drive your coding agent.** Pick Claude Code / Codex / Cursor / OpenCode /
  Hermes per conversation, pick its project folder, and talk. Model, mode
  (ask / accept edits / bypass), and the agent's other options switch mid-call, all
  reported by the agent itself over ACP.
- **Sessions are the agent's own.** A call with Claude Code lands in
  `~/.claude/projects/…` where `claude --resume` finds it, and the agent's existing
  CLI sessions show up in OpenLive's History. Resume from either side.
- **Permission relay.** When the agent wants to run a command or edit files,
  OpenLive speaks the question; answer by voice ("yes" / "no") or tap.
- **Narrated progress.** Optional: while the agent works in silence, OpenLive speaks
  its plan steps out loud ("Step 2 of 4 — refactor the store").
- **Live plans and costs.** The agent's working plan renders as a checklist while it
  works, and a context/cost chip tracks the session.
- **Manage agents in Settings.** Install, sign in, update, and uninstall each
  agent's CLI from the app. Status updates itself while you finish a sign-in in the
  terminal, and if the terminal can't open you get the exact command to run instead.
- **Floating mini mode.** Shrink to an always-on-top pill that keeps listening while
  you work, with a menu-bar tray and notifications to close the loop.
- **A transcript you can use.** Agent replies render as markdown with copy buttons
  on code blocks, and the whole conversation exports to a Markdown file.
- **Private by design.** Audio never uploads. API keys are encrypted at rest
  (AES-256-GCM) and only the last four digits are ever shown.

## Screenshots

| Home | In a live call |
|---|---|
| ![Home](assets/home.png) | ![In a live call](assets/hero.png) |
| **Pre-call setup** | **Settings — agents** |
| ![Pre-call setup](assets/lobby.png) | ![Settings](assets/settings.png) |
| **Clone your voice** | **Mini mode** |
| ![Clone Voice](assets/clone-voice.png) | ![Mini mode](assets/mini-mode.png) |

## Why on-device voice matters

The listening and speaking never leave your computer. The only thing that goes out
is the text turn to the brain you picked, the same call you would make from any app.
No audio uploads, no per-minute meter, no lock-in.

That also skips the separate speech-to-text, text-to-speech, and real-time-audio
fees hosted platforms charge on top. You still pay your normal model and vision API
costs, nothing more. With a coding agent as the brain there's nothing extra to pay
at all; it runs under the login you already have.

## How it works

```
mic ─▶ VAD ─▶ streaming STT ─▶ end-of-turn ─▶ your AI ──────────▶ streaming TTS ─▶ speaker
     (Silero)  (Whisper)        (Smart-Turn)  (BYO model, or a     (Kokoro / Supertonic /
                                    ▲          coding agent over    your cloned voice)
                camera / screen ────┘          ACP on local stdio)
                frames (vision)
```

Everything outside "your AI" runs locally in the renderer. The turn goes over a warm
local WebSocket to a small agent server, which either streams a provider reply or
drives your coding agent's ACP adapter as a child process. The app starts speaking
sentence by sentence while the reply is still being written.

## Get started

**Just use it:** grab the installer from the
[latest release](https://github.com/katipally/openlive/releases/latest), open the app,
paste a model key (or pick the coding agent you already use — install/sign in from
Settings → Agents if needed), and start a call. The voice models download from
Hugging Face the first time you talk — roughly 200 MB with Kokoro, more with
Supertonic or a bigger Whisper — and are cached after that.

**Build it from source:**

```bash
pnpm install
pnpm desktop:dev      # runs the web + agent servers and opens the app window
```

You can also run it in a browser during development with `pnpm dev`, then open
`localhost:3000`. Run the tests with `pnpm test`.

## Repo layout

```
apps/desktop     Electron shell: spawns the local servers, media perms, window,
                 mini mode, tray + notifications
apps/web         Next.js UI + the on-device voice engine (src/lib/live/*) + /api routes
                 (agents install/auth, history discovery, settings)
services/agent   Hono + ws: the /live WebSocket, the ACP agent driver (acp-agent.ts,
                 supervisor.ts), voice cloning (voice/*), the built-in provider turn loop
packages/shared  the agent registry (single source of agent identity), wire protocol,
                 shared types
packages/harness provider-neutral model adapters, live model listing, cost/effort
packages/db      JSON-file store: encrypted keys, settings, conversations
```

For how the pieces fit together — the ACP driver, the voice loop, resume, and the
delegate/worker tool flow — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

OpenLive is open to contributions. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for
how to set up, where things live, and how to send a change. Good first issues are
labeled in the tracker.

## License

[MIT](LICENSE). Use it, change it, ship it.
