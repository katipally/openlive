# Chat

Talk to your AI in a call, inside the OpenLive window. You speak, it answers out
loud, and it can see your camera or screen when you turn them on. Whoever
answers is your API key's model or a coding agent you already use, driven
locally under your own login. The listening and speaking run on this machine.

Chat is not [Flow](FLOW.md) or [Dictate](DICTATE.md). Flow is the same voice
from any app, over your dock. Dictate types what you say into the text box in
front of you.

- [Chat's home](#chats-home)
- [Setting up a call](#setting-up-a-call)
- [In a call](#in-a-call)
- [How you talk](#how-you-talk)
- [Who answers](#who-answers)
- [History](#history)
- [Settings](#settings)
- [First run and tours](#first-run-and-tours)
- [Troubleshooting](#troubleshooting)

## Chat's home

Pick **Chat** at the top of the window.

```
           OpenLive
   Ears, eyes, and a voice for your AI.
   tagline · how to start

   [ + New ]  [ History ]  [ ⚙ ]
   Who answers [Claude Code ▾]  [ Ready ]   ◀── readiness chip
```

![Chat's home](../assets/home.png)

- **New** opens the call setup for a fresh conversation.
- **History** opens every conversation, by project folder. See [History](#history).
- **⚙** opens Settings.
- **Who answers**: who the next new chat talks to, your API key or a coding
  agent. It starts on the default from Settings > Models.
- **The readiness chip** says whether a call would start: **Ready**, or the one
  thing missing, as a button that goes to the fix. It checks in the order the
  call setup asks:

| Chip | Goes to |
|---|---|
| **Install** *agent* | Settings > Agents |
| **Sign in to** *agent* | Settings > Agents |
| **Add an API key** | Settings > Models |
| **Download voice models, about** *size* | Settings > Speech engine. The chip only reads the size; nothing downloads until you agree. |
| **Allow microphone** | The system's microphone settings (the browser's site settings on the web) |

The tray (menu bar) has **New call**, and the command palette (`⌘K`, `Ctrl+K`
elsewhere) has **New call** and **Open Chat history**. Both bring the window
up on the same call setup.

## Setting up a call

**New** (or **Resume** on a past one) opens **Set up your call**:

```
 ┌─ main stage ──────────────────┐ ┌─ Set up your call ─────┐
 │  camera preview, mic level    │ │  Who answers           │
 │  mic and camera pickers       │ │  Model · Mode · Effort │
 │  Project folder  [ /path ]    │ │  (what the agent       │
 │         [ Start ]             │ │   reports it has)      │
 └───────────────────────────────┘ └────────────────────────┘
```

![Pre-call setup](../assets/lobby.png)

- **Project folder**: the one place whoever answers reads and writes files. A
  coding agent saves its session there too, so you can resume it from its own
  CLI. A coding agent needs one before **Start**.
- **Who answers**, and its model, mode (ask, accept edits, bypass) and effort,
  for this call. A coding agent reports its own options the moment it
  connects.
- **Start** is off until the gaps are fixed: no key, an agent not installed or
  signed in, a missing folder. Each gap says what to do above the button,
  before anything fails.

**Download consent.** The voice models (speech recognition, turn-taking and
the voice) download from Hugging Face the first time, once. Start asks first:

```
 Start ──▶ models on this machine? ──yes──▶ call starts
                     │
                     no
                     ▼
     "Download the voice models first?"  names each model and the size
     [ Download and start ]   [ Cancel ]
```

Nothing downloads before you press **Download and start**. Offline, it says
**You're offline**; a stopped download offers **Try again**. A voice or
language you switch to mid-call, a voice preview, and a clip to transcribe for
a cloned voice ask the same way, in place, before anything more downloads.

## In a call

```
        ( your AI's orb )
   caption: what it's saying / doing
 [✋] [ mic ] [ camera ] [ screen ] [ end ]      [ activity ]
  ▲ Hold to talk, in push to talk
```

![In a live call](../assets/hero.png)

- **Barge-in**: talk over it and it stops mid-word.
- **Camera and screen**: frames ride each turn. The `look` tool grabs a sharp
  frame on demand. A model that can't see gets a vision model's description.
- **Activity panel**: the transcript, tool calls, the agent's plan as a
  checklist, and a context and cost chip. Export the transcript to Markdown
  from its header.
- **Permission asks**: when a coding agent wants to run a command or edit a
  file, OpenLive says the question. Answer "yes" or "no", or tap.
- **Narrate agent progress** (Settings > Voice): while a coding agent works in
  silence, OpenLive says its plan steps out loud.
- Minimise the window and the call rides on the orb above the dock (mute,
  open, end).

| Key | Does |
|---|---|
| `M` | Mute or unmute |
| `C` | Camera on or off |
| `S` | Share screen |
| `T` | Activity panel |
| `H` | History |
| `⌘E` (`Ctrl+E`) | End call |
| `?` | Every shortcut |

## How you talk

One setting for Chat, Flow and Dictate, in Settings > General > **How you
talk**, the tray, and the palette:

- **Hands-free** (the default): just talk. A pause ends what you said.
- **Push to talk**: hold the push to talk key (Fn on macOS, Right Ctrl on
  Windows and Linux) while you talk, or hold the **Hold to talk** button at the
  left of the call controls. The microphone is on only while it's held. The
  button works everywhere, including Linux before the `input` group is set up.

## Who answers

```
 Settings > Models > Who answers you  ──▶  the default
        │
        ├──▶ Chat's home "Who answers"   (the next new chat)
        ├──▶ Set up your call            (this call; can switch)
        └──▶ Flow and Dictate follow it unless they have their own
```

- **Your API key**: Anthropic, OpenAI, Google, MiniMax, Ollama at any address,
  and the rest, with the model and vision model from Settings > Models.
- **A coding agent**: Claude Code, Codex, Cursor, OpenCode, Hermes, Gemini CLI,
  GitHub Copilot, Kiro or Pi, over ACP. Install and sign in from Settings >
  Agents. A call with an agent lands in the agent's own session store, where
  its CLI can resume it.

## History

**History** on the home, **H** in a call, or the palette's **Open Chat
history** opens the drawer.

- Every conversation, newest first, grouped by project folder, with a search
  over titles and folders.
- **All** or **OpenLive**: all sessions, including ones made in the agents' own
  CLIs, or only those started here.
- Each row: **Resume**, **Rename**, **Delete**, and **Delete all** for its
  folder. Delete hides the row at once and offers **Undo** on a toast for a
  few seconds before it's gone. **Delete all** asks first.

**Retention.** Settings > Chat > **History** sets how long OpenLive's own
conversations stay: **Keep nothing** (each goes once it ends), 1 day, 7 days,
30 days, or **Keep forever** (the default). It's applied when History is read
and as a call starts. **Clear all** asks to confirm, then deletes every kept
conversation, and is turned off when the open one is all that's left. Both only touch conversations started in OpenLive: the
conversation open now is never deleted, and the agents' own CLI sessions
(Claude Code's `~/.claude/projects/…` and the like) are never touched.

Conversations live in `~/.openlive/data/` (`%USERPROFILE%\.openlive\data\` on
Windows). See [PRIVACY.md](PRIVACY.md).

## Settings

Settings > Chat has the same shape as Flow's and Dictate's tabs:

| Section | What it has |
|---|---|
| Status | **Ready for a call.**, or what's missing with its fix, the same as the home chip |
| Trigger | How you talk, linking to Settings > General |
| Who answers | The default, linking to Settings > Models. A chat can switch in its setup. |
| Shared settings | Language, Voice, Narrate agent progress, Speech engine, each linking to where it's set |
| History | How long to keep conversations, **Clear all**, and a link to the list |

The project folder, camera, screen and who answers one call are picked in the
call setup, per call, so they have no setting here.

## First run and tours

```
 Welcome ──▶ Chat's home tour ──▶ call setup tour ──▶ in-call tour
 (once)      (first visit)        (first setup)       (first call)
```

- **Welcome**, once for someone new: the three modes, who answers you, what
  the computer has to allow, How you talk, and one thing to try in each mode.
  **Skip** asks first.
- **Tours**: each screen shows a short tour the first time, at most four
  steps: the home (the modes and who answers, unless Welcome just showed them,
  then **New** and **History**), the call setup, the call controls, the History
  drawer, and Settings. A tour never runs over Welcome, a first run or
  Settings. **Skip**, the close button and Esc ask before ending it for good;
  a click outside ends it until next time.
- Settings > About > Getting started > **Show me around again** (also in the
  palette) asks to confirm, then plays Welcome, Flow's setup, Dictate's first
  run and every tour again, as for someone new.

## Troubleshooting

| What you see | Try |
|---|---|
| The chip says **Add an API key** | Add one in Settings > Models, or pick a coding agent in **Who answers**. |
| **Install** or **Sign in to** an agent | Settings > Agents installs it and opens its sign-in. If the terminal can't open, it shows the exact command. |
| **Download voice models** | Press **Start**, or **Download models now** in Settings > Speech engine. Both name the size and ask first. |
| **Allow microphone** | Turn the microphone on for OpenLive in the system's privacy settings, then come back. On the web, allow it in the browser's site settings. |
| **The microphone went away. Switched to the default mic.** | The mic was unplugged or lost its access mid-call. Pick another in the call setup next time. |
| **Couldn't open the microphone** | Another app may hold it, or access is off. Check the system's privacy settings. |
| Start stays greyed out | Read the line above it: a missing folder, key or agent. |
| A banner says **Reconnecting...** or **You are offline** | Your chat is safe and on-device voice keeps working. It reconnects on its own; if it stays, quit from the tray and open the app again. |
| A conversation is missing from History | Check **All** vs **OpenLive**, and Settings > Chat > History: it may have been kept for less time. |
