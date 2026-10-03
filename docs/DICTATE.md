# Dictate

Voice typing into any text box. Double-tap a key to open it, talk, and your
words are typed at the cursor. It runs on this machine. No AI, nothing spoken back, unless you
turn on AI polish: the speech engine writes down what you said, rules on this
machine tidy it, and ol-input types it. It works the same on macOS, Windows and
Linux.

Dictate is not [Flow](FLOW.md). Flow is for asking your computer: your AI
answers out loud and can act for you. Dictate only types what you say. A call
with your AI in the window is [Chat](CHAT.md).

- [Dictate's home](#dictates-home)
- [Starting and stopping](#starting-and-stopping)
- [The orb](#the-orb)
- [Cleanup](#cleanup)
- [AI polish](#ai-polish)
- [Edit by voice](#edit-by-voice)
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
 Ready, or the fix that is missing        Basics: trigger, who answers, shared
 how to start, with your keys                     settings, cleanup, AI polish + tone,
 History: search, copy, insert again,             history: how long, Clear all
          delete, Show more               Words: dictionary, snippets
 Settings ›                               Commands: edit by voice, spoken commands
```

![Dictate's home](../assets/dictate-home.png)

- **The switch**: **Dictate is on** or **Dictate is off**. The tray (menu bar)
  menu has the same switch: **Turn Dictate on** or **Turn Dictate off**, under
  a line that says how it stands (**Dictate is on · Double-tap ⌥**, **Dictate
  needs permission**, **Dictate stopped listening**).
- **Status**, while it is on: **Ready**, or buttons for what is missing
  (**Allow microphone**, **Allow Accessibility**, or **Allow input access** on
  Windows and Linux), or why the key listener stopped.
- **How to start**, in your own keys: double-tap to open and close, how you
  talk inside, and editing a selection by voice.
- **History**: every dictation kept, newest first by day, with a search, as
  Chat's and Flow's have, **Copy**, **Insert again** (back into the window it
  came from while that window is open and a text box there has the cursor,
  else on the clipboard) and **Delete**, which hides the row at once and
  offers **Undo** on a toast for a few seconds before it really deletes, as
  Chat and Flow do. **Clear all** in Settings > Dictate asks to confirm instead.
  The first 100 show, and **Show more** adds 100 at a time, so a long history
  opens and searches quickly.

The first time, the home walks you through it in two cards, skippable:
**Voice typing, no AI** (what it is, the switch, and anything the system still
has to allow, unless Welcome already asked) and **Try it here**, a text box on
the page to dictate into. Dictation into OpenLive's own window is typed by
Electron itself, so the box works the same on every platform. **Done** or
**Skip** ends it for good.

After that, once History has a dictation in it, a short tour points at four
things: changing a selection by voice, a row's **Copy** and **Insert again**,
History, and the Settings link. Like every tour it shows once, its **Skip**
asks first, and Settings > About > **Show me around again** plays it again.

## Starting and stopping

```
 double-tap Option ──▶ Dictate is open ──▶ talk ──▶ cleaned up ──▶ typed at the cursor
 (Alt off macOS)              │                       (on device)
                              ├ Hands-free:   every pause types what came before it
                              └ Push to talk: hold the key, talk, let go; each hold types
 double-tap again, "stop dictating", or Close after silence ──▶ closed
```

Dictate is a session, opened and closed the same way Flow is. How you talk
inside it is one setting for Flow, Dictate and calls alike, in Settings >
General > **How you talk**:

- **Hands-free** (the default): just talk. Each finished sentence is typed
  as you go.
- **Push to talk**: hold the push to talk key (Fn on macOS, Right Ctrl on
  Windows and Linux), talk, let go. Letting go types what you said; a quick tap
  types nothing. The microphone is open only while the key is down.

| Way in or out | What it does |
|---|---|
| Double-tap Option ⌥ on macOS, Alt elsewhere (either side) | Opens Dictate; the same double tap closes it. |
| The mic button above Flow's orb | Opens Dictate. While it is open the button is a badge (**Listening**, or **Hold** and the key while push to talk waits for it); click it to close. |
| Ask Flow: "turn on dictation" | Flow's `set_dictation` tool. It opens once Flow's reply ends. |
| Say "stop dictating" | Types what came before it, then closes. |
| **Close after silence** | Nothing said for that long (30 sec by default; 90 sec, 5 min or Never) closes it. In push to talk, a stretch with no hold counts as silence. |

Esc never closes Dictate: it always goes to the app in front. Every key is
yours to change in Settings > General, each with **Reset**; see
[Keys](#keys). Dictate is off until you turn it on, on its home or from the
tray. A modifier key is watched, never swallowed: it still reaches the app in
front. An F13 to F24 key is OpenLive's alone and never reaches it (on Linux,
only where OpenLive can write to `/dev/uinput`). A key pressed on top of the
push to talk key (Right Alt as AltGr typing a character) cancels the hold. On Windows, holding Alt or Win sends an
inert key with it, so letting go does not open the app's menu bar or the
Start menu.

### Keys

- **Open Flow**, **Open Dictate** and **Push to talk** each have a picker in
  Settings > General: **Change** takes the next key pressed alone, **Esc** or
  Tab gives up, **Reset** goes back to the default. A change applies at once,
  no restart.
- A double-tap key is one modifier (Control, Option or Alt, Shift, Command or
  Win), on either side or one side, or F13 to F24. Push to talk is one key
  that types nothing: one side of a modifier, Fn on macOS, or F13 to F24.
- No two of them share a physical key. Where push to talk holds one side of a
  double-tap key (Right Ctrl beside Flow's Ctrl, say), that double tap uses the
  other side only while you talk in push to talk, and its picker says so. A key
  that would leave another with none is refused, with the reason.
- **Fn on macOS**: holding Fn also runs whatever the system does on a press of
  🌐 (switch the input source, Emoji & Symbols, macOS dictation). Settings
  says so and links to Keyboard settings, where **Press 🌐 key to** can be set
  to Do Nothing. A keyboard without Fn needs another key.
- **AltGr**: on Windows and Linux, Right Alt types characters on many layouts
  (German, French, Polish and more). Dictate's default double tap then uses
  Left Alt only, and Right Alt as the push to talk key carries a warning.

## The orb

Dictate uses Flow's orb, with Flow's own motion, in chartreuse, a hue no Flow
state uses.

| State | Colour | Moves like |
|---|---|---|
| Open and waiting | `#93A65A` | Flow idle |
| Listening | `#C6F135` | Flow listening, riding your voice |
| Cleaning up, rewriting and typing | `#E2F04A` | Flow thinking |

Right above the orb, in the mic button's place, a badge says how it is
listening: **Listening** hands-free, as Flow's says, **Hold** and the key while push to talk waits for
it, **Getting ready** from the press until the microphone gives its first
sound (150 to 300 ms while the device wakes), **Listening** from then on, so
you know when to start, and **Editing selection** while what you
say will rewrite a selection. Each has a stop square that closes Dictate. The mic, the badges and the line
above them fade into one another rather than popping. Above the badge, one line:

```
 listening    hey can you send the report
 processing   ◌ Hey, can you send the report?   (spinner, the words shimmer)
 polishing    ◌ Polishing                       (with AI polish on)
 done         ✓ 6 words              [Undo]
```

Opening Dictate starts the speech engine, which takes a moment the first
time: the line says **Getting ready**. Hands-free, the microphone opens with
the session and closes with it (on macOS the orange dot goes). In push to
talk it opens on each press and every track is stopped on the release, so the
dot is on only while the key is down. A hold is recorded from the first sound
the microphone gives, shown on the line once the engine has words, and
written down on release. Words it heard but could
not write down are said so on the orb (**Couldn't write your words
down.**), never dropped quietly. A hold with no words in it, only the room,
types nothing and leaves the clipboard alone: the orb says **No words heard.**
for a moment and goes. Flow's own cards (nothing set to answer, say) never
show on Dictate's orb with Flow closed.

A long sentence drops its oldest words so the newest stay in view. When the
words land the line says **N words** with an **Undo** button, then the orb
goes. Closing Dictate gives the orb back at once. Undo does what "undo that" does, once, and is offered for five seconds or
until the next words start: OpenLive cannot tell when you type somewhere else,
so it times out instead.

Where nothing takes the text, it is put on the clipboard instead and the line
says **No text box in focus. Copied instead.** Before typing, Dictate asks the
system what has the keyboard (macOS Accessibility, Windows UI Automation, Linux
AT-SPI). Only a plain no copies: a list, a button, Finder's files. Where the
system cannot tell, as in an Electron app that shows no accessibility tree, a
web page's body, or a Linux desktop with no accessibility bus, it types as it
always did. OpenLive's own window is the exception: its text boxes take the
words from Electron directly, with no system events in between, and with no
text box in focus there (or a disabled or read-only one) the words are copied
instead, as anywhere else.

Closing Dictate puts things back as they were before it opened. With Flow
closed, the microphone closes at once and the orb goes after the Undo offer,
so talk after the close never opens Flow. With Flow open, Flow listens again.
Either way, a sentence still being said or transcribed at the close is
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

## Edit by voice

Select text in any app, and with Dictate open, say what to change.

```
 select ──▶ talk: "make this formal" ──▶ still selected? ──yes──▶ your AI ──▶ typed over it
                                             │no
                                             ▼
                                   typed at the cursor, as dictation
```

- The selection is read through the system's accessibility API only (macOS
  AX, Windows UI Automation, AT-SPI on Linux), never by copying it, so your
  clipboard is never touched to read it. It is read when you start talking
  and again at the end: still selected, what you said is the instruction;
  gone, it is typed as ordinary dictation. Apps that do not share their
  selection that way, and Wayland, get your words typed.
- While it applies, the orb's badge says **Editing selection**.
- It needs Dictate's AI: whoever answers for AI polish (Settings > Dictate >
  Basics > Who answers). Until one is set, what you say is typed over the
  selection, and Settings > Dictate > Commands says **Needs Dictate's AI**.
- A failure, or 45 seconds without an answer, changes nothing and says why.
- A selection over 20,000 characters (or 64 KB once sent) is not sent: the orb
  says "Selection too long for a command."

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
| "stop dictating" | Types what came before it, then closes Dictate |

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

Settings > Dictate has the same shape as Chat's and Flow's tabs: status,
Trigger, Who answers, Shared settings, what only Dictate has, then History.
It opens with one line saying whether Dictate is on, with a link to its home,
where the switch is. Then three subtabs:

```
 Dictate is on. Turn it off in Dictate.
 [ Basics | Words | Commands ]
 Basics:  Trigger · Who answers · Shared settings · Cleanup · AI polish · History
```

- **Basics**
  - **Trigger**: the double tap that opens and closes Dictate, How you talk
    and Close after silence, each linking to Settings > General, where they
    are set for Flow and Dictate alike ([Keys](#keys)).
  - **Who answers**: **Same as Flow**, or **Its own**, for AI polish and
    edit by voice alike. Plain dictation never uses it.
  - **Shared settings**: links to Typing at cursor (General), Language and
    Speech engine.
  - **Cleanup**: the five rules, with a live example of what they do.
  - **AI polish**: on or off, and its tone.
  - **History**: how long to keep dictations, **Clear all**, and a link to the
    list on Dictate's home.
- **Words**: the dictionary (a filter past 12 words, the first 40 shown until
  **Show all**) and snippets.
- **Commands**: edit by voice (ready, or what it needs) and the spoken commands.

Typing at cursor is shared with Flow, in Settings > General: paste or type it
out, the Advanced timing, and **Put my clipboard back**. On (the default), what
you had copied comes back right after a paste; off, the typed text stays on the
clipboard.

## Dictate and Flow

One microphone, one engine, one orb, so the two take turns:

- Only one is open at a time. Opening Dictate closes Flow, stopping a turn
  under way; Flow's own double tap closes Dictate and Flow listens.
- Asked by Flow's `set_dictation` mid-turn, Dictate opens once that turn is over.
- The push to talk key goes to whichever is open, and does nothing with both
  closed (a call takes it then).
- Dictate works with Flow closed. The orb comes up for it and goes again, and it
  does not count as a Flow session.

## Platform notes

- **macOS**: the key needs Accessibility, as Flow's does.
- **macOS**: push to talk defaults to Fn; see [Keys](#keys) for the 🌐
  setting it wants.
- **Windows**: Right Alt is AltGr on many layouts (German, French, Polish and
  more): see [Keys](#keys). Push to talk defaults to Right Ctrl.
- **Linux**: the key listener reads `/dev/input` on X11 and Wayland alike, which
  takes the `input` group (`sudo usermod -aG input $USER`, then sign out and
  back in); until then Settings says so, and a call's **Hold to talk** button
  works without it. Right Alt is often AltGr (ISO Level 3). Edit by voice reads
  the selection over AT-SPI, which Wayland apps rarely share, so there your
  words are typed. Key presses (spoken commands) go through `xdotool` on X11
  and `ydotool`, with its daemon, on Wayland; new line in a terminal runs the
  line.

## Architecture (for developers)

```
 ol-input hook ──double_tap / hold_start/hold_end/hold_cancel──▶ owner renderer
   (coordinator.rs: toggle and hold                              │
    roles, per binding)                      createTalk (lib/flow/talk.ts) ──▶ createDictate (lib/dictate/run.ts)
                                                                 │
 VoiceEngine (beginPtt / endPtt(now)) ──onUserText──▶ heard ──▶ cleanup (lib/dictate/cleanup.ts)
                                                                 │
                       dictionary, snippet, spoken command (lib/dictate/words.ts)
                                                                 │
              AI polish / edit by voice ──▶ /api/dictate/rewrite ──▶ agent /dictate (services/agent/src/dictate)
                                                                 │
                                         insertBegin/Push/End ──▶ ol-input (paste or type)
          keys / accessibleSelection ──▶ ol-input (spoken commands, edit by voice)
                                                                 │
                                           /api/dictate/history ──▶ flow-store dictations.jsonl
```

- **Keys**: `native/ol-input/src/coordinator.rs`. Three bindings: Flow's and
  Dictate's with the `toggle` role report `double_tap`, direction-free, and
  the push to talk key with the `hold` role reports `hold_start` on the press,
  `hold_end` on a release past `TAP_MAX`, and `hold_cancel` for a tap or a
  key on top. A toggle binding never shares a physical key with the hold one:
  in push to talk main registers it narrowed to the other side (`narrowToggle` in
  `packages/flow-store`). `createTalk` keeps which session is open, latches a
  hold to whoever had it at its start, and runs Close after silence. Flow's
  off switch mutes Flow's binding alone (`suspendHook("flow")`).
- **Routing**: `useFlowOwner` hands every finished utterance to Dictate first.
  While Dictate is active it takes it, so the sentence never reaches
  `flowText`, whoever answers, or the voice.
- **Microphone**: `VoiceEngine.start(open)` takes a function that opens the
  microphone, not a stream: the VAD's `getStream`/`resumeStream` call it and
  its `pauseStream` stops every track, so a paused VAD holds no device. In
  push to talk the gate keeps the VAD paused between holds; `beginPtt` starts
  it, which opens the device, and the hold is taped (16 kHz) from the stream
  that start leaves open. vad-web's start and pause race across the device's
  open, so the engine runs them one after another (`micOps`). Measured on an
  M-series Mac (Electron, AEC on or off alike): `getUserMedia` resolves in
  about 105 ms, the first frame lands at about 115 ms and the first non-zero
  sample at 150 to 300 ms (median 280 ms) after the press; a warm
  AudioContext does not shorten it. Sound before that is not there to keep,
  so a word begun on the very press can lose its first consonant; one begun a
  beat later, as most are, is whole.
- **Release**: `VoiceEngine.endPtt(true, lateMs)` cuts the tape where the key
  went up and, with the gate on, pauses the VAD at once (its segment in
  progress dropped: the tape has all of it) and stops every track once the
  tape has its last frames, at most 300 ms later and usually one 64 ms
  buffer. It says how the hold ended: `heard`, `silent` (no speech, or only
  what speech-to-text drops as noise) or `lost` (heard, not written down).
- **Tape**: while the hold lasts the line is captioned from the tape; a
  streaming engine whose socket is not live falls back to these batch
  captions. On release the tape, cut where the key went up, is checked for
  speech first (`lib/live/tapeSpeech.ts`): the VAD's own Silero weights, in a
  session of their own, at the pipeline's speech threshold. With no run of 3
  speech frames (96 ms) in it and no VAD segment, nothing is transcribed, so
  room sound never comes out as "Thanks!". Otherwise the tape is transcribed
  from 300 ms before its first speech, instead of the VAD's segments, which
  miss its start. A single "yes", "ok" or "thanks" runs 6 frames or more and
  noise none (measured with the fixtures in `lib/live/fixtures`). Where that
  model cannot load, the old rule decides: the tape is transcribed when it is
  louder than the room.
- **Tool**: `set_dictation` (`services/agent/src/capabilities/text.ts`) is
  offered wherever a session has `dictate`, which Flow's does through the
  `flow_dictate` bridge op. The registry serves the same tool to API models and,
  over OpenLive's MCP server, to coding agents.
- **Rewrite**: `services/agent/src/dictate/rewrite.ts`. With your API key it streams the
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
  A session begun with no field there that takes input fails, so the caller
  copies instead.
- **Tray**: main reads and writes Dictate's switch through `/api/flow/config`,
  the windows' own route, then tells the owner renderer and the main window
  (`openlive:flow-settings-changed`) so the key and the screens follow.
- **Focus**: ol-input's `focusEditable()` reads the focused element (AX role
  and settable AXValue or AXSelectedTextRange; UIA control type, ValuePattern
  and TextPattern; AT-SPI role and EDITABLE through python3's GObject bindings,
  given up on after 800 ms). The verdicts are pure functions in
  `native/ol-input/src/focus.rs`; `null` means it could not tell, and types.
- **Close**: Dictate's `release` port drops what the engine is still hearing
  or transcribing (`VoiceEngine.discard()`) and, with Flow closed, stops the
  engine, which stops every microphone track.
- **Selection and keys**: ol-input's `accessibleSelection()` reads the
  selection through the accessibility API alone (`""` for none, null where it
  cannot be read that way), and `keypress(keys, times)` repeats the last key
  with the modifiers held (one call for "undo that").
- **Settings**: `dictate` and `insertion.restoreClipboard` in Flow's config
  (`packages/flow-store`); the history in `packages/flow-store/src/dictations.ts`.
