# Changelog

All notable changes to OpenLive are recorded here. The newest version is on top.
Releases before 0.1.9 predate this file — see the
[GitHub releases](https://github.com/katipally/openlive/releases) for those.

## [Unreleased]

### Removed
- **Mini mode.** The floating always-on-top call bar, its tray item and its
  global talk hotkey (Settings → General → Mini mode) are gone. A call now shows
  on the orb above the dock whenever the OpenLive window is minimised or hidden,
  with mute, open and end. Closing the window ends the call.

### Changed
- **Settings opens on General and goes back where you came from.** The close
  button is now "Back to Chat / Flow / OpenLive / call" at the top of the
  sidebar; Esc and Back still work.
- **API mode answers only from the provider you chose.** When the chosen provider
  had no key, Chat and Flow used to answer from another provider that had one,
  while Flow said it was not set up. Now every screen and every turn resolve the
  choice the same way: no key means not ready, with the fix in Settings.

### Added
- **Ollama server address.** Settings → Models → Provider takes the address of
  the Ollama server (default `http://localhost:11434`), for Ollama on another
  machine or port. Chat, Flow and the model list use it, and an unreachable
  server is named by that address. An address on this computer saves at once;
  any other asks first in a native dialog in the desktop app, since it receives
  screen content, and cannot be set from a plain browser.
- **Screenshots reach models that see, on every provider.** Groq, Gemini,
  OpenRouter, xAI and the other Chat Completions providers now get the pictures
  a tool returns. A model that cannot see gets the vision model's description
  instead, when one is set in Settings → Models, and otherwise a plain note that
  a picture was not sent, so it never claims to see it.

### Fixed
- **Flow with a coding agent kept the wrong conversation.** After a new session
  the agent still remembered the old one, and "Carry on from here" left it
  knowing nothing of the session it resumed. Both now start the agent fresh,
  seeded with the conversation on screen.
- **Long Flow tasks ran out of context.** A single request that took many steps
  was never trimmed, so it grew until the model refused it. Older steps are now
  dropped and the request is kept.
- **Stop left Flow talking.** Speech already queued kept playing after Stop. It
  now goes quiet at once, and only what was heard is kept.
- **A coding agent that would not start said only "That turn failed."** The
  failure card now shows its real reason.
- **In development, any web page could open a live session.** With no agent
  secret set, `/live` now accepts only pages from this machine.
- **Flow in API mode failed with no explanation.** A turn the model refused
  turned the orb red and said nothing. It now shows why (no key, key refused,
  model not available, out of credit, busy, or unreachable, such as Ollama not
  running) and, where settings fix it, a button that opens them.
- **Flow in API mode could not see what it did on OpenAI or Ollama.** The
  screenshot each action returns was dropped before it reached the model.
- **Flow in API mode sent a reasoning setting to models without one**, which
  OpenAI and Ollama refuse, and lost the model's signed thinking between tool
  calls, which Anthropic refuses when thinking is on. It now picks effort the way
  Chat does and keeps the thinking.
- **Red buttons with white text are readable in dark mode**, and red text clears
  4.5:1 contrast on every surface in both themes.
- **Flow opened with no brain and listened anyway.** The "No brain is configured
  yet" card vanished a second after it appeared. It now stays with its fix, and
  Flow does not open the microphone until there is a brain to think with.
- **Flow reopened with the last session's card sinking out of it.** Opening Flow
  now starts clean and shows only a problem that is still true.
- **Flow's settings buttons opened the wrong page.** A missing, refused or
  unknown key or model now opens Settings → Models (Agents or Flow for a coding
  agent), and an unreachable Ollama offers the button to where its address is
  set, instead of only Close Flow.
- **The tray's "New Flow session" did nothing while Flow was open.** It now
  starts a fresh session there, and leaves a turn that is still running alone.
- **Chat's context meter stayed at "0 ctx" on MiniMax.** Its Anthropic-style
  stream reports the input only at the end, which is now read.
- **Saved Chat replies ran two steps together** ("On it.No workspace…"). The
  space between them is kept.
- **The home screen flashed through the call as it started.**
- **Settings → Models' model list ran off the bottom of a short window.** It
  opens upward when there is more room there, and its height follows the window.
- **A reply with file names lost words in the Activity panel and the voice.**
  "alpha.txt, beta.md, and gamma.json" showed as "json." The dot in a file
  name, version, web address, number or "Dr." no longer ends a sentence, the
  transcript shows names as written, and the voice says them ("alpha dot txt")
  instead of "that file". Chat and Flow both.
- **A sentence before a tool was cut in half by it.** Its end was held back
  until the tool finished; it is now spoken before the tool runs.
- **A web lookup's "Still searching for…" was saved as part of the answer.**
  It is spoken while the lookup runs and no longer lands in the reply.
- **Settings → Models showed a 1M context as "1.048576M".**

## [0.2.7] - 2026-08-27

### Fixed
- **Talking to a local model (Ollama) failed with "No API key for Anthropic".**
  Picking a local provider was silently discarded — the check asked whether the
  provider had an API key, and a local one never does — so every turn ran against
  a keyed default nobody chose. Local providers are now honoured. (#13)
- **Linux: Sign in / Sign out / setup wizards opened nothing.** They ran in a
  headless shell with no window and no terminal, so the flow that needs you to
  type and approve in a browser had nowhere to happen, and it failed quietly.
  OpenLive now opens whichever terminal you actually have installed, and tells
  you what to run yourself if you have none.
- **Linux: "Open at Login" did nothing.** The switch flipped back off every time
  because the underlying API is macOS/Windows only. Linux now uses a standard
  autostart entry.
- **Linux: leftover servers weren't cleaned up on minimal systems.** The check
  relied on `lsof`, which many distributions don't ship; a missing `lsof` looked
  identical to "nothing running", so a stale server survived and the next launch
  hit it. Systems without `lsof` now fall back to `ss`.

## [0.2.6] - 2026-08-27

### Fixed
- **Coding agents installed through a Node version manager showed as "Not
  installed".** OpenLive only looked for agent binaries in a short list of
  fixed directories, so a `claude` (or any agent) living under nvm, fnm, volta
  or asdf was invisible whenever the app was launched from Finder or the dock —
  the Agents settings row offered "Install" for something already installed,
  and `npx`-based agent adapters could fail to start for the same reason.
  OpenLive now reads your real login-shell PATH, so agents resolve no matter
  where they were installed or how the app was started.
- **The window buttons did nothing.** The close / minimize / fullscreen controls
  sat underneath the draggable title strip, so macOS and Windows handed every
  click to the window-drag handler instead of the button. macOS now uses its
  real native traffic lights (which also makes the green button enter true OS
  fullscreen instead of just growing the window), and on Windows and Linux the
  controls are no longer covered by the drag strip.

## [0.2.5] - 2026-07-18

### Added
- **Linux support.** OpenLive now ships a Linux build (unsigned `.AppImage`,
  64-bit) alongside macOS and Windows — download, `chmod +x`, run. The release
  and CI pipelines build and smoke-test all three platforms on their native
  runners.

## [0.2.4] - 2026-07-17

### Fixed
- **Windows: the 0.2.3 crash fix didn't fully take.** On the Windows build
  machine, some package links inside the build were broken and got silently
  skipped, so the installer still shipped without React. The packaging now
  reads package contents directly (no links involved) and refuses to build at
  all if any required package is missing. (#6)

## [0.2.3] - 2026-07-17

### Fixed
- **Windows: "The web service keeps crashing" on launch.** The bundled web
  server was assembled with symlinks that the Windows installer flattened
  one-by-one, tearing packages apart — the server died on a missing module the
  moment it started, on every install. The bundle is now assembled with no
  symlinks at all (a flat, npm-style layout), which behaves identically on
  every OS. (#6)

## [0.2.2] - 2026-07-17

### Fixed
- **Hermes works end to end.** OpenLive now detects Hermes installed via its
  official installer (which only puts the `hermes` launcher on PATH), drives it
  through `hermes acp`, and recognizes sign-in from any of its provider stores —
  API keys in `.env`, a selected provider in `config.yaml`, or OAuth in
  `auth.json`. Previously a fully configured Hermes showed as "not installed"
  or "Setup incomplete".
- **Install/Update/Uninstall for Hermes** use its official installer, and
  uninstall cleans up the launcher too.
- **Dev servers self-heal.** `pnpm dev` and `pnpm desktop:dev` now clear stale
  dev servers from either stack before starting, so a leftover Next process no
  longer blocks startup with "Another next dev server is already running".

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
