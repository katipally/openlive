# Changelog

All notable changes to OpenLive are recorded here. The newest version is on top.
Releases before 0.1.9 predate this file — see the
[GitHub releases](https://github.com/katipally/openlive/releases) for those.

## [0.2.1] - 2026-07-17

### Added
- **Chats and messages now persist in SQLite** (via `node:sqlite`), with a
  one-time migration that moves any existing JSON history over on first launch.
  Nothing to do; your past conversations carry across.

### Changed
- **Electron 33 to 43, with the renderer sandbox on.** The app runs on a current
  Electron with the renderer sandboxed, closing the gap between the web content
  and the OS.
- **Security hardening.** The agent WebSocket now requires an auth token, agent
  file operations are scoped to the selected workspace, and the pipeline pauses
  when the machine sleeps instead of talking to itself in the dark.
- **Typography on a strict scale.** An eight-step type scale on the bundled Geist
  font, so headings, body, and labels line up instead of drifting.
- **History is now Sessions.** The panel is renamed, filters by All or OpenLive,
  and collapses in one action.
- **Controls stop feeling like a web page.** Dropdowns are custom (no native OS
  select), navigable by arrow keys as a proper listbox, and window chrome is no
  longer text-selectable while content still is.
- **Launch and history motion.** A hero reveal on launch and a staggered cascade
  when the session list opens.
- **Lighter render load.** Store subscriptions are narrowed so fewer components
  re-render, and caption reveal is throttled to the word rate.

### Fixed
- **Screen share on recent macOS.** The system screen picker was cancelling the
  request, so sharing did nothing. OpenLive now shares the primary screen
  directly, which is reliable and skips the prompt.
- **Mini mode from the tray was dead.** Entering mini mode from the tray left the
  pill completely unresponsive; it works now.
- **Port cleanup and respawn.** Stale ports on relaunch are cleared more
  reliably.
- **Agent elicitation and permission modals.** Answering an agent's prompt (its
  elicitation and permission asks) now maps to the right option instead of
  getting lost.
- **Assorted ACP bugs** in the coding-agent bridge.

## [0.2.0] - 2026-07-16

### Fixed
- **"The web service keeps crashing" on launch (#6).** A crashed or force-killed
  run could leave the app's server processes alive (Windows especially), still
  holding OpenLive's ports — every later launch then died in an EADDRINUSE
  respawn loop that relaunching never fixed. The app now clears its own stale
  server processes from those ports at startup (other apps' processes are left
  alone), and the crash dialog says what to check if it ever still happens.
- **The workspace you picked is now the workspace the agent gets.** A bind race
  on new conversations could silently strand the session with no agent and no
  folder while the top bar showed both (the server's boot-time bind restore could
  supersede and reverse the client's bind). The server now yields to the client's
  bind, always receives the folder explicitly (empty means clear, not "keep
  stale"), and echoes back what it actually bound so the UI can't drift — with a
  one-shot self-heal re-bind if they ever disagree.
- **No more silent brain swap.** If a coding agent is selected but can't run
  (no folder, failed start), OpenLive says exactly that instead of quietly
  answering with the built-in assistant as if it were the agent.
- **Speaking to answer a permission no longer cancels it.** Starting to talk
  while an agent asked for permission counted as barge-in: the ask vanished
  mid-answer and your words became a new turn. Speech during a pending ask is
  now the answer ("yes"/"no", matched against the agent's real option ids).
- **Model/mode pickers stop blinking out.** Resumed sessions kept their model
  and mode lists (updates during session replay were dropped), the server
  re-sends them on a same-bind reconnect, and the in-call top bar falls back to
  the per-agent cache like the lobby always did.
- **Pre-call verification.** The lobby now checks the project folder actually
  exists on disk, the built-in brain's provider has an API key, and a microphone
  is present — gaps surface as chips (with a jump to the right Settings tab)
  before Start instead of failing mid-call. A missing folder also gets a clear
  error instead of a baffling "spawn npx ENOENT".
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
- **Clone Voice — clone your own voice.** A dedicated Settings tab: pick a script (or
  just talk), record 5–30 seconds with a live level meter, listen back before
  saving, fix the auto-transcript, and your assistant speaks as you — zero-shot
  cloning (ZipVoice, Apache-2.0, via sherpa-onnx) running locally in the agent
  service at ~4x realtime on CPU. Optional ~208 MB download, removable anytime.
  Profiles preview with any text you type, rename, export/import between
  machines, play back their original recording, and delete; automatic Kokoro
  fallback; consent required — clone only your own voice or one you have
  permission for. The Pipeline TTS stage just picks among your cloned voices.
- **Persona.** Settings → General gains "Your assistant's style": your own words
  on how it should behave and speak, applied to the built-in assistant AND every
  coding agent via its session preamble.
- **Spoken progress narration (opt-in).** While a coding agent works in silence,
  OpenLive voices its plan steps ("Step 2 of 4 — …"), throttled and barge-in aware.
- **Notifications + menu bar.** A tray icon (Open / Mini mode / Quit) and OS
  notifications when a turn finishes or an agent asks permission while you're in
  another app — clicking brings OpenLive forward.
- **Markdown transcript.** Agent replies render as real markdown — code blocks
  with copy buttons, lists, tables — plus per-message copy and a one-tap export
  of the whole conversation to a Markdown file.
- **In-call keyboard shortcuts.** M mute, C camera, S screen share, T activity
  panel, H history, Cmd/Ctrl-E end call — press `?` for the cheat sheet.
- **Lobby readiness check.** Picking an agent that isn't installed or signed in
  shows a one-tap jump to Settings → Agents instead of failing the call.
- **A real player for voice previews.** Everything Clone Voice plays back — the
  recorded take, a synthesized preview, the original recording — now goes through
  a compact seekable player (play/pause, drag to seek, elapsed/total time) instead
  of fire-and-forget playback. Only one plays at a time.
- **Agent sign-in that can't strand you.** Sign-in and setup flows open in your
  terminal; the row now polls while you finish there and flips to Ready by itself.
  If the terminal can't open (macOS Automation permission), the panel explains the
  fix and a Copy command button gives you the manual path. Hermes gets an honest
  "Setup incomplete" state (its wizard was started but no provider picked), a
  "Finish setup" button, and an Uninstall that removes `~/.hermes` after a warning.

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
- **Settings reorganized.** The Voices tab is now **Clone Voice**. Speaking speed
  and "Narrate agent progress" moved from Pipeline → Text-to-speech to General
  under a new **Voice & speech** group, next to voice input — everyday preferences
  in General, engine choices in Pipeline. Same settings underneath; nothing resets.

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

[0.2.1]: https://github.com/katipally/openlive/releases/tag/v0.2.1
[0.2.0]: https://github.com/katipally/openlive/releases/tag/v0.2.0
[0.1.9]: https://github.com/katipally/openlive/releases/tag/v0.1.9
