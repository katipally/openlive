# Dictate

Voice typing into any text box. Hold a key, talk, let go: your words are typed
at the cursor. It runs on this machine. No AI, nothing spoken back, unless you
turn on AI polish: the speech engine writes down what you said, rules on this
machine tidy it, and ol-input types it. It works the same on macOS, Windows and
Linux.

Dictate is not [Flow](FLOW.md). Flow is for asking your computer: your AI
answers out loud and can act for you. Dictate only types what you say.

- [Dictate's home](#dictates-home)
- [Starting and stopping](#starting-and-stopping)
- [The orb](#the-orb)
- [Cleanup](#cleanup)
- [AI polish](#ai-polish)
- [Command mode](#command-mode)
- [Words: dictionary and snippets](#words-dictionary-and-snippets)
- [Spoken commands](#spoken-commands)
- [History](#history)
- [Settings](#settings)
- [Dictate and Flow](#dictate-and-flow)
- [Platform notes](#platform-notes)
- [Architecture (for developers)](#architecture-for-developers)

## Dictate's home

Pick **Dictate** at the top of the window. The home is for using it; how it
behaves is in Settings > Dictate, and nothing is in both places.

```
 Dictate's home (use)                     Settings > Dictate (configure)
 ─────────────────────                    ──────────────────────────────
 Dictate is on / off   (the switch)       "Dictate is on. Turn it off in Dictate."
 Ready, or the fix that is missing        Basics: keys, cleanup, AI polish + tone,
 how to start, with your keys                     who answers, shared settings,
 History: search, copy, insert again,             history: how long, Clear all
          delete, Show more               Words: dictionary, snippets
 Settings ›                               Commands: command key, spoken commands
```

- **The switch**: **Dictate is on** or **Dictate is off**. The tray (menu bar)
  menu has the same switch: **Turn Dictate on** or **Turn Dictate off**, under
  a line that says how it stands (**Dictate is on · Hold Right ⌥**, **Dictate
  needs permission**, **Dictate stopped listening**).
- **Status**, while it is on: **Ready**, or buttons for what is missing
  (**Allow microphone**, **Allow Accessibility**, or **Allow input access** on
  Windows and Linux), or why the key listener stopped.
- **How to start**, in your own keys: hold the key, double-tap for hands-free,
  and the command key with text selected.
- **History**: every dictation kept, newest first by day, with a search once
  there are more than 8, **Copy**, **Insert again** (back into the window it
  came from while that window is open, else on the clipboard) and **Delete**.
  The first 100 show, and **Show more** adds 100 at a time, so a long history
  opens and searches quickly.

The first time, the home walks you through it in two cards, skippable:
**Voice typing, no AI** (what it is, the switch, and anything the system still
has to allow, unless Welcome already asked) and **Try it here**, a text box on
the page to hold the key over. Dictation into OpenLive's own window is typed by
Electron itself, so the box works the same on every platform. **Done** or
**Skip** ends it for good.

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
| The mic button above Flow's orb | Hands-free on. While it is on, the button is a **Hands-free** badge; click it to stop. |
| Ask Flow: "turn on dictation" | Flow's `set_dictation` tool. It starts once Flow's reply ends. |

Dictate is off until you turn it on, on its home or from the tray. The key is watched,
never swallowed: it still reaches the app in front. A key pressed on top of it
(Right Alt as AltGr typing a character) cancels the hold. On Windows, holding
Alt or Win for Dictate sends an inert key with it, so letting go does not open
the app's menu bar or the Start menu. Shift with the key is kept for command
mode (below).

## The orb

Dictate uses Flow's orb, with Flow's own motion, in chartreuse, a hue no Flow
state uses.

| State | Colour | Moves like |
|---|---|---|
| Armed, hands-free and waiting | `#93A65A` | Flow idle |
| Listening | `#C6F135` | Flow listening, riding your voice |
| Cleaning up, rewriting and typing | `#E2F04A` | Flow thinking |

Right above the orb, in the mic button's place, a badge says how it is
listening: the key and **Hold** while you hold it, **Hands-free**
with a stop square while hands-free is on. The mic, the badges and the line
above them fade into one another rather than popping. Above the badge, one line:

```
 listening    hey can you send the report
 processing   ◌ Hey, can you send the report?   (spinner, the words shimmer)
 polishing    ◌ Polishing                       (with AI polish on)
 done         ✓ 6 words              [Undo]
```

The first press after a while, or after launch, opens the microphone and
starts the speech engine, which takes a moment: the line says **Getting
ready**, and you can talk straight away. Everything said from the key going
down is kept, shown on the line as soon as the engine is up, and written down
on release. After each dictation the microphone stays open, muted, for 30
seconds, so the next hold is up at once; then it closes (on macOS the orange
dot goes). Turning Dictate off, or Flow taking over, ends that wait at once. Words it heard but could
not write down are said so on the orb (**Your words could not be written
down.**), never dropped quietly. Flow's own cards (nothing set to answer, say) never
show on Dictate's orb with Flow closed.

A long sentence drops its oldest words so the newest stay in view. When the
words land the line says **N words** with an **Undo** button, then the orb
goes. Stopping hands-free gives the orb back at once. Undo does what "undo that" does, once, and is offered for five seconds or
until the next words start: OpenLive cannot tell when you type somewhere else,
so it times out instead.

Where nothing takes the text, it is put on the clipboard instead and the line
says **No text box in focus. Copied instead.** Before typing, Dictate asks the
system what has the keyboard (macOS Accessibility, Windows UI Automation, Linux
AT-SPI). Only a plain no copies: a list, a button, Finder's files. Where the
system cannot tell, as in an Electron app that shows no accessibility tree, a
web page's body, or a Linux desktop with no accessibility bus, it types as it
always did. OpenLive's own window is the exception: its text boxes take the
words from Electron directly, with no system events in between.

Stopping hands-free puts things back as they were before it started. With Flow
closed, the microphone goes quiet at once and the orb goes after the Undo
offer, so talk after the stop never opens Flow. The same holds for talk right
after a hold is let go: until the words are typed, Dictate keeps the
microphone and drops it. With Flow open, Flow listens
again. Either way, a sentence still being said or transcribed at the stop is
dropped, not typed and not sent to Flow.

## Cleanup

Each rule has its own switch, and each one leans conservative: a sentence it is
unsure of is typed as heard. The rules are English. In every other language
(Settings > Voice > Language) Dictate hears and types the words as the speech
engine wrote them, and Punctuation alone applies: a capital to start, where the
script has them, and a closing full stop in the script's own mark (`.`, `。` in
Chinese and Japanese, `।` in Hindi). Settings > Dictate marks the other rules
English only. Word counts and the dictionary work in every language, Chinese and
Japanese included, where a name sits against the text with no spaces.

| Rule | Example |
|---|---|
| Punctuation | `send it by friday` becomes `Send it by Friday.` (capitals, I, days and months, and a closing period on three words or more) |
| Remove fillers | um, uh, er go; `you know` and `like` only when set off by pauses (`it was, like, huge`) |
| Backtrack | `to Priya, actually Maya` becomes `to Maya`; `no wait` too; `scratch that` takes back the sentence |
| Lists | `One, milk. Two, eggs.` becomes numbered lines |
| Numbers | `twenty five` becomes `25`; one to nine stay words |

The whole cleanup is one pass per rule over the words, O(n) in the length of
what was said, with no network.

## AI polish

Off by default. On, the cleaned-up words go to whoever answers for Dictate, which rewrites
them in the tone picked (Natural, Casual or Formal) and gives back text only.

```
 said ──▶ cleanup ──▶ dictionary ──▶ snippet? ──yes──▶ typed as the snippet
                                        │no
                                        ▼
                               polish on? ──no──▶ typed
                                        │yes
                                        ▼
                     first words in, within 25 s? ──no / error──▶ cleaned-up words typed
                                        │yes
                                        ▼
                     typed as they stream ──error / 25 s──▶ kept as typed, all of it copied
                                        │done
                                        ▼
                                 rewrite in full
```

- Who answers is the same as Flow unless **Who answers for AI polish and
  commands** is set to **Its own**: your API key or a coding agent. An API model is offered no tools; a
  coding agent is started with none of OpenLive's, none of its own where its
  launch can turn them off (Claude Code, Codex, Gemini CLI, OpenCode; Copilot
  loses shell, writes and the web), and every permission it asks for is
  refused. A coding agent is kept warm between dictations (let go after
  5 quiet minutes or 20 rewrites) and is started on the key press, so the
  first rewrite does not wait on a cold start where it can help it.
- The rewrite is typed as it streams in. The orb stays on **Cleaning up** and
  counts the words in.
- Nothing said is lost. A failure, an empty answer or 25 seconds with no words
  types the cleaned-up words instead, and the strip says so. A rewrite that
  stops partway (an error, or the 25 seconds run out) keeps what it typed,
  since taking it back could hit whatever the app made of it, puts all of the
  text on the clipboard (the full rewrite where it came, else the cleaned-up
  words) and says **AI polish stopped partway.**
- What is typed is the reply as text: space at either end waits until more
  follows, and a reply that opens with a code fence is held until it ends, so
  the fence is never typed.

## Command mode

Select text, hold **Shift + Right Alt** (Shift + Right Option on macOS), say
what to do, let go.

```
 hold ⇧ + key ──▶ "make this formal" ──▶ read the selection ──▶ brain ──▶ typed over it
```

- The selection is read through the accessibility APIs (macOS AX, Windows UI
  Automation, the X11 or Wayland primary selection). Where they cannot say, it
  is copied with Cmd+C or Ctrl+C and your clipboard put back, as **Put my
  clipboard back** says.
- With nothing selected, what you ask for is written at the cursor.
- A failure, or 45 seconds without an answer, changes nothing and says why.
- A selection over 20,000 characters (or 64 KB once sent) is not sent: the orb
  says "Selection too long for a command."
- The key is changeable in Settings > Dictate > Commands, and may not be
  Dictate's own key. A double tap of it does nothing.

## Words: dictionary and snippets

- **Dictionary**: names and jargon spelled your way. After cleanup, a run of up
  to five words whose letters and digits match an entry is written as the entry:
  `open live` and `Openlive` become `OpenLive`, `a c p` becomes `ACP`. A run
  never crosses a comma, a period or a line, and a lone common word (will, may,
  mark) only changes case when the entry has a capital inside it or is all
  capitals, so an entry `Will` leaves "I will" alone. One map lookup per word
  and run length: O(n) in the words said, whatever the size of the list.
- **Snippets**: a phrase said on its own, case and punctuation aside, types its
  text instead. One map lookup. A snippet is never polished.
- Speech engine hints are not used yet: the streaming engines here take no
  hotwords without a model change, and the Whisper pipeline has no prompt
  input, so the dictionary works on the text instead.

![Settings > Dictate > Words](../assets/dictate.png)

## Spoken commands

Each has its own switch in Settings > Dictate > Commands. A command counts when
it is the whole of what was said, or comes after a sentence end or a pause
(or a capital where the speech engine began a sentence without a period):
"Sounds good. Press enter." types "Sounds good." then presses Enter, while "I
will press enter later" is typed as said. English only: in another language the
words are typed, and Settings > Dictate says so.

| Say | Does |
|---|---|
| "press enter" | Presses Enter |
| "new line" | Shift+Enter: a line break that does not send in a chat box |
| "new paragraph" | Shift+Enter twice |
| "undo that" | Said alone: one Backspace per character Dictate typed last |
| "stop dictating" | Hands-free only: types what came before it, then stops |

"Undo that" only works while the cursor is still at the end of what Dictate
typed, and an app that reformatted it (autocorrect, auto-indent) may be off by a
character or two. It never presses Ctrl+Z, which suspends a program in a
terminal. It reaches back up to 2000 characters. The orb's **Undo** button
does the same.

## History

Each dictation is kept after it lands: what was said, the cleaned-up text, what
was typed, the app and the time. [Dictate's home](#dictates-home) lists it.
Settings > Dictate > Basics > **History** sets how long it is kept and has
**Clear all**.

- Kept for 1 day, 7 days, 30 days (the default) or forever, or not at all.
  Pruned on every read and after every dictation, at most 1000 kept.
- A JSONL file under the OpenLive home (`flow/dictations.jsonl`, so
  `OPENLIVE_HOME` moves it), readable by this user only, and never sent
  anywhere.

## Settings

Settings > Dictate opens with one line saying whether Dictate is on, with a
link to its home, where the switch is. Then three subtabs:

- **Basics**
  - **Hold to talk**: the key. **Change** takes the next key or combination you
    press: a modifier on either side, Caps Lock, or F13 to F24, since any other
    key would also type. On Windows and Linux a Right Alt key warns that some
    layouts use it as AltGr and offers Right Ctrl, Caps Lock and F13.
  - **Cleanup**: the five rules, with a live example of what they do.
  - **AI polish**: on or off, and its tone.
  - **Who answers**: **Same as Flow**, or **Its own**, for AI polish and
    command mode alike. Plain dictation never uses it.
  - **Shared settings**: links to Typing at cursor (General), Voice and Speech
    engine.
  - **History**: how long to keep dictations, **Clear all**, and a link to the
    list on Dictate's home.
- **Words**: the dictionary (a filter past 12 words, the first 40 shown until
  **Show all**) and snippets.
- **Commands**: command mode's key and the spoken commands.

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
  more). Pick another key there. In a console, a Ctrl+C sent to copy a
  selection the system could not read interrupts the program instead, so
  select text there before command mode.
- **Linux**: the key listener reads `/dev/input` on X11 and Wayland alike, which
  takes the `input` group. Right Alt is often AltGr (ISO Level 3). The
  selection is the primary selection, which some apps keep after the
  highlight is gone. Key presses (spoken commands, the copy) go through
  `xdotool` on X11 and `ydotool`, with its daemon, on Wayland; new line in a
  terminal runs the line.

## Architecture (for developers)

```
 ol-input hook ──hold_start/hold_end/hold_cancel/start/stop──▶ owner renderer
   (coordinator.rs: hold + double-tap,                           │
    per binding)                                    createDictate (lib/dictate/run.ts)
                                                                 │
 VoiceEngine (beginPtt / endPtt(now)) ──onUserText──▶ heard ──▶ cleanup (lib/dictate/cleanup.ts)
                                                                 │
                       dictionary, snippet, spoken command (lib/dictate/words.ts)
                                                                 │
              AI polish / command mode ──▶ /api/dictate/rewrite ──▶ agent /dictate (services/agent/src/dictate)
                                                                 │
                                         insertBegin/Push/End ──▶ ol-input (paste or type)
                                         keys / copySelection ──▶ ol-input (spoken commands, command mode)
                                                                 │
                                           /api/dictate/history ──▶ flow-store dictations.jsonl
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
- **Release**: `VoiceEngine.endPtt(true, lateMs)` ends the segment on the next
  quiet frame instead of after the trailing silence, and says whether what was
  heard could be written down.
- **Cold start**: a hold that opens the microphone starts the engine with
  `start(stream, true)`, which records the stream at 16 kHz from that moment
  while the VAD loads. A hold on an engine that is already up starts one too
  (`tapeHold`), so a word too short for the VAD is kept. While the hold lasts
  the line is captioned from the tape, the first time as soon as the VAD is
  up; a streaming engine whose socket is not live falls back to these batch
  captions. On release the tape, cut where the key went up, is transcribed
  whole instead of the VAD's segments, which miss its start.
- **Warm microphone**: `createDictate` asks the owner to close the microphone
  (`micIdle`) `MIC_WARM_MS` (30 s) after it last let go of it, unless a press
  or Flow took it back first.
- **Tool**: `set_dictation` (`services/agent/src/capabilities/text.ts`) is
  offered wherever a session has `dictate`, which Flow's does through the
  `flow_dictate` bridge op. The registry serves the same tool to API brains and,
  over OpenLive's MCP server, to coding agents.
- **Command key**: a second binding, `dictate_command`, registered with
  `hold` like Dictate's. Both keys down at once is command mode.
- **Rewrite**: `services/agent/src/dictate/rewrite.ts`. API mode streams the
  provider with `tools: []`; a coding agent is an `AcpAgent` with Dictate's own
  preamble, no MCP servers, the registry's `acp.toolless` launch and a
  permission handler that always refuses. `/dictate/rewrite` answers in
  NDJSON: `{ delta }` lines as the words come (`typedStream` holds back edge
  space and a code fence), then `{ text }` or `{ error }`. The renderer
  (`readRewrite`) pushes each delta into one insertion session, holds the
  deadline and aborts the request, which ends the turn.
- **Own window**: while OpenLive's main window has the keyboard,
  `flow-input.cjs` answers `focusEditable` from the page's focused element and
  types each insertion session with `webContents.insertText`, never the addon.
- **Tray**: main reads and writes Dictate's switch through `/api/flow/config`,
  the windows' own route, then tells the owner renderer and the main window
  (`openlive:flow-settings-changed`) so the key and the screens follow.
- **Focus**: ol-input's `focusEditable()` reads the focused element (AX role
  and settable AXValue or AXSelectedTextRange; UIA control type, ValuePattern
  and TextPattern; AT-SPI role and EDITABLE through python3's GObject bindings,
  given up on after 800 ms). The verdicts are pure functions in
  `native/ol-input/src/focus.rs`; `null` means it could not tell, and types.
- **Stop**: Dictate's `release` port drops what the engine is still hearing
  or transcribing (`VoiceEngine.discard()`) and, with Flow closed, mutes it
  until the next press.
- **Keys**: ol-input's `keypress(keys, times)` repeats the last key with the
  modifiers held (one call for "undo that"), and `copySelection(timing)` sends
  the copy chord with a marker on the clipboard, so an app that copies nothing
  is told apart from one that copied what was there.
- **Settings**: `dictate` and `insertion.restoreClipboard` in Flow's config
  (`packages/flow-store`); the history in `packages/flow-store/src/dictations.ts`.
