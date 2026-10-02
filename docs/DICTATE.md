# Dictate

Dictate is talking instead of typing, in any app. Hold a key, say it, let go,
and the cleaned-up words are typed where your cursor is. No brain hears plain
dictation and nothing is spoken back: the speech engine writes down what you
said, rules on this machine tidy it, and ol-input types it. It works the same on
macOS, Windows and Linux.

- [Starting and stopping](#starting-and-stopping)
- [The orb](#the-orb)
- [Cleanup](#cleanup)
- [Settings](#settings)
- [Dictate and Flow](#dictate-and-flow)
- [Platform notes](#platform-notes)
- [Architecture (for developers)](#architecture-for-developers)

## Starting and stopping

```
 hold Right Alt ──▶ talk ──▶ let go ──▶ cleaned up ──▶ typed at the cursor
                                         (on device)
 tap, tap Right Alt ──▶ hands-free: every pause types ──▶ tap once to stop
```

| Way in | What it does |
|---|---|
| Hold the key (Right Option ⌥ on macOS, Right Alt elsewhere) | Push to talk. Letting go types what you said. A quick tap types nothing. |
| Double-tap the key | Hands-free: each finished sentence is typed as you go. One more tap stops it. |
| The mic button beside Flow's orb | Hands-free on or off. |
| Ask Flow: "turn on dictation" | Flow's `set_dictation` tool. It starts once Flow's reply ends. |

Dictate is off until you turn it on in Settings > Dictate. The key is watched,
never swallowed: it still reaches the app in front. A key pressed on top of it
(Right Alt as AltGr typing a character) cancels the hold. On Windows, holding
Alt or Win for Dictate sends an inert key with it, so letting go does not open
the app's menu bar or the Start menu. Shift with the key is kept for command
mode, which comes next.

## The orb

Dictate uses Flow's orb, with Flow's own motion, in chartreuse, a hue no Flow
state uses.

| State | Colour | Moves like |
|---|---|---|
| Armed, hands-free and waiting | `#93A65A` | Flow idle |
| Listening | `#C6F135` | Flow listening, riding your voice |
| Cleaning up and typing | `#E2F04A` | Flow thinking |

Hands-free draws a dashed ring round the orb. Under it, one line shows how
Dictate is held (the key, or **Hands-free** with **Stop**) and what it heard so
far; a long sentence drops its oldest words so the newest stay in view. When the
words land it says **Inserted N words**, then the orb goes. Where nothing takes
the text (no text box in focus), it is put on the clipboard instead and the line
says so.

## Cleanup

Each rule has its own switch, and each one leans conservative: a sentence it is
unsure of is typed as heard. The rules are English; another language is typed as
the speech engine wrote it.

| Rule | Example |
|---|---|
| Punctuation | `send it by friday` becomes `Send it by Friday.` (capitals, I, days and months, and a closing period on three words or more) |
| Remove fillers | um, uh, er go; `you know` and `like` only when set off by pauses (`it was, like, huge`) |
| Backtrack | `to Priya, actually Maya` becomes `to Maya`; `no wait` too; `scratch that` takes back the sentence |
| Lists | `One, milk. Two, eggs.` becomes numbered lines |
| Numbers | `twenty five` becomes `25`; one to nine stay words |

The whole cleanup is one pass per rule over the words, O(n) in the length of
what was said, with no network.

## Settings

Settings > Dictate:

- **Dictate**: on or off.
- **Hold to talk**: the key. **Change** takes the next key or combination you
  press: a modifier on either side, Caps Lock, or F13 to F24, since any other
  key would also type. On Windows and Linux a Right Alt key warns that some
  layouts use it as AltGr and offers Right Ctrl, Caps Lock and F13.
- **Cleanup**: the five rules, with a live example of what they do.
- **Brain**: off, AI polish and commands think as Flow does. Plain dictation
  never uses it.
- **Shared settings**: links to Typing at cursor (General), Voice and Speech
  engine.

Typing at cursor is shared with Flow, in Settings > General: paste or type it
out, the Advanced timing, and **Put my clipboard back**. On (the default), what
you had copied comes back right after a paste; off, the typed text stays on the
clipboard.

## Dictate and Flow

One microphone, one engine, one orb, so the two take turns:

- Pressing Dictate's key while Flow is working or speaking stops that turn, then
  dictates.
- Flow's own double tap wins: hands-free Dictate stops and Flow listens.
- Closing Flow closes Dictate with it.
- Dictate works with Flow closed. The orb comes up for it and goes again, and it
  does not count as a Flow session.

## Platform notes

- **macOS**: the key needs Accessibility, as Flow's does.
- **Windows**: Right Alt is AltGr on many layouts (German, French, Polish and
  more). Pick another key there.
- **Linux**: the key listener reads `/dev/input` on X11 and Wayland alike, which
  takes the `input` group. Right Alt is often AltGr (ISO Level 3).

## Architecture (for developers)

```
 ol-input hook ──hold_start/hold_end/hold_cancel/start/stop──▶ owner renderer
   (coordinator.rs: hold + double-tap,                           │
    per binding)                                    createDictate (lib/dictate/run.ts)
                                                                 │
 VoiceEngine (beginPtt / endPtt(now)) ──onUserText──▶ heard ──▶ cleanup (lib/dictate/cleanup.ts)
                                                                 │
                                         insertBegin/Push/End ──▶ ol-input (paste or type)
```

- **Key**: `native/ol-input/src/coordinator.rs`. A binding registered with
  `hold` reports `hold_start` on the press, `hold_end` on a release past
  `TAP_MAX`, and `hold_cancel` for a tap or a key on top; its double-tap is
  `start`, and while that is open a single tap is `stop`. `notifyOpen` keeps
  the toggle honest when the mic button or the tool opened it. Flow's off switch
  mutes Flow's binding alone (`suspendHook("flow")`).
- **Routing**: `useFlowOwner` hands every finished utterance to Dictate first.
  While Dictate is active it takes it, so the sentence never reaches
  `flowText`, the brain or the voice.
- **Release**: `VoiceEngine.endPtt(true)` ends the segment on the next quiet
  frame instead of after the trailing silence.
- **Tool**: `set_dictation` (`services/agent/src/capabilities/text.ts`) is
  offered wherever a session has `dictate`, which Flow's does through the
  `flow_dictate` bridge op. The registry serves the same tool to API brains and,
  over OpenLive's MCP server, to coding agents.
- **Settings**: `dictate` and `insertion.restoreClipboard` in Flow's config
  (`packages/flow-store`).
