# Changelog

All notable changes to OpenLive are recorded here. The newest version is on top.
Releases before 0.1.9 predate this file — see the
[GitHub releases](https://github.com/katipally/openlive/releases) for those.

## [0.2.0] - Unreleased

### Fixed
- **Cross-process data race.** Settings and conversations are written by both the
  web and agent processes; every read-modify-write now runs under a file lock, so
  a concurrent save can no longer silently drop the other side's update.
- **Agent plans and usage now actually show.** The server has always emitted the
  agent's working plan (ACP plan updates) and context/cost usage — the UI dropped
  both. Plans render as a live checklist above the transcript; a context/cost chip
  sits in the top bar.
- **Permission asks no longer time out silently.** An unanswered agent permission
  auto-denies after 2 minutes — the prompt now shows a visible countdown and the
  voice speaks a reminder 30 seconds before the deadline.
- **Hermes session history.** Discovery was querying columns that don't exist in
  hermes' database; rewritten against the real hermes-agent 0.18.2 schema.
- **History with huge session logs.** Reading titles from Codex rollout logs
  (hundreds of MB) no longer loads whole files into memory.
- **Workspace file confinement.** The built-in assistant's file tools now refuse
  symlinks that point outside the workspace, not just `../` escapes.
- Crash screen follows the OS theme and uses the brand accent.

### Added
- **Markdown transcript.** Agent replies render as real markdown — code blocks
  with copy buttons, lists, tables — plus per-message copy and a one-tap export
  of the whole conversation to a Markdown file.
- **In-call keyboard shortcuts.** M mute, C camera, S screen share, T activity
  panel, H history, Cmd/Ctrl-E end call — press `?` for the cheat sheet.
- **Lobby readiness check.** Picking an agent that isn't installed or signed in
  shows a one-tap jump to Settings → Agents instead of failing the call.

### Changed
- **Light mode rebuilt.** A stepped warm-paper ladder (no pure white): cards,
  panels, and popovers now separate cleanly instead of fusing into one white
  field, and borders are actually visible.
- **README and docs rewritten** around what OpenLive is: the open voice and
  vision layer for AI agents — bring your own model, with coding agents over ACP
  as the flagship integration. Includes an honest note that the pipeline is
  cascaded, not full-duplex speech-to-speech.
- **VAD assets are served from the app itself** (vendored at build time) instead
  of a CDN — the voice loop no longer touches jsdelivr at runtime.
- **Agents settings shows each CLI's version** and gains an **Update** button;
  a failed npm install from a root-owned prefix now gets actionable guidance
  instead of a raw error dump.
- Slash-command metadata (never surfaced in the UI) removed from the wire protocol.

## [0.1.9] - 2026-07-11

### Added
- **A dozen more model providers.** Alongside Anthropic, OpenAI, and MiniMax,
  OpenLive now speaks to Google Gemini, xAI Grok, DeepSeek, Mistral, Groq, Cerebras,
  Together, Fireworks, OpenRouter, Perplexity, and Ollama (local and cloud). Paste a
  key and the model list loads live from the provider — nothing hardcoded.
- **Separate vision model (optional).** If your live model can't see, point OpenLive
  at a dedicated vision model under Settings → Vision model. Camera and screen frames
  are described by that model and handed to your live model, so a fast text-only
  model can still watch your screen. Leave it off and the live model sees for itself.
- **Real vision capability in the picker.** The `vision` badge now comes from actual
  provider / models.dev metadata rather than a name guess, and the picker warns when
  the selected model can't accept images.

### Changed
- A third wire adapter (OpenAI Chat Completions) joins the Anthropic and OpenAI
  Responses adapters, so most hosted providers work through one code path.
- Snapshot model defaults refreshed to current IDs (e.g. DeepSeek V4, Grok 4.5),
  preferring fast vision-capable models for the voice + camera loop.

[0.1.9]: https://github.com/katipally/openlive/releases/tag/v0.1.9
