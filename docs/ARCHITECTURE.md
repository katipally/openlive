# Architecture

How OpenLive fits together, and the few decisions that shape everything else.

## The one big idea: thick client, thin server

The whole voice loop runs **on your machine, in the browser renderer**. The local
agent server is a thin driver in front of the brain you picked — an external coding
agent over ACP, or a chat-model provider. No audio ever crosses the wire.

```
┌──────────────────────────────── your machine ────────────────────────────────┐
│  renderer (apps/web)                        agent server (services/agent)    │
│                                                                              │
│  mic → VAD → STT → end-of-turn ─┐  /live WS  ┌─ LiveSession                  │
│  (Silero)(Whisper)(Smart-Turn)  ├─ text ───▶ │   ├─ AcpAgent ── stdio ──▶ your coding agent
│                                 │  +frames   │   │  (supervised)   (Claude Code / Codex / …)
│  speaker ← TTS ← sentences ─────┘◀─ reply ───┘   └─ or: provider turn loop   │
│           (Kokoro)                 (SSE text)         (BYO model key)        │
│    ▲ camera / screen frames ────────┘                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

The `/live` WebSocket carries text turns + JPEG frames up and streamed reply text
down (plus permission asks, agent metadata, and control messages — see
`packages/shared/src/live-events.ts`). The browser speaks the reply sentence by
sentence as it arrives.

## The agent registry (`packages/shared/src/agent-registry.ts`)

The **single source of agent identity**. Every agent's id, label, brand mark, ACP
adapter command, install/uninstall recipes, login/logout commands, session-store
location + parser, and credential probe lives in one table. The server driver, the
API routes, the History sidebar, and every selector read it — adding an agent is one
entry, and the whole UI (including History discovery) picks it up automatically.
Node-only helpers (credential probing, PATH widening, terminal launch) live in
`@openlive/shared/node`.

The npx adapter versions are **pinned** on purpose (guarded by unit tests):
`claude-agent-acp@0.81.2` (OpenLive relies on its `_meta.claudeCode.options`
passthrough) and `codex-acp@1.13.1`.

## Driving a coding agent over ACP (`services/agent/src/agents/`)

`AcpAgent` spawns the agent's ACP adapter as a child process and speaks JSON-RPC
over stdio ("LSP for agents"). Design points:

- **No faked capabilities.** OpenLive advertises no fs/terminal capabilities — a
  voice app isn't an editor. The agent uses its own file access and asks permission
  (via `session/request_permission`) before anything risky; the ask is spoken and
  shown as chips, answerable by voice. A "yes" or "no" to it ends the turn at
  once, with no mid-thought hold, and once the question is voiced the orb shows
  the reply waiting on you (listening), not speaking. A sentence that crossed an ask on the wire
  was said before it showed, so the ask is refused and the sentence runs as a turn.
  Outside a turn only a request-scoped elicitation (sign-in or setup before any
  session) is shown; a session-scoped one is a finished turn's and is refused.
- **Sessions belong to the agent.** For Claude, `_meta.claudeCode.options` rides
  `session/new`/`session/load` with `persistSession: true` (sessions land in
  `~/.claude/projects/<cwd-slug>/` where `claude --resume` finds them) and a
  system-prompt append carrying the voice-call context. `CLAUDE_CODE_ENTRYPOINT=
  claude-vscode` keeps them visible in the CLI's `/resume` picker. Other agents get
  a first-turn preamble instead.
- **Resume.** Reopening a conversation whose transcript OpenLive already holds
  calls `session/resume` when the agent advertises it (no replay). An empty chat
  (an agent's own session opened from History) calls `session/load`, whose
  replayed updates rebuild the transcript. Each failure falls through to the
  next, then to a fresh session, silently (the original stays on disk and in
  History).
- **The agent's own sessions.** History scans each agent's session store on
  disk and, for agents advertising `sessionCapabilities.list`, lays the agent's
  own `session/list` over it (`GET /agents/sessions`: initialize only, cached a
  minute, never spawned when the CLI is not on PATH).
- **Slash commands.** `available_commands_update` rides `agent_meta` as
  `commands` for the composer's slash menu. A typed "/name args" that names an
  advertised command is sent alone as the prompt's first text block, per ACP;
  anything else is ordinary speech. API mode has none, so the menu hides.
- **OpenLive's tools.** A call serves a coding agent the same tools its
  built-in brain runs (see *Tools* below) over a loopback MCP server named
  `openlive`, the one `serveMcp` Flow uses too. They take the same bridge, turn
  number, chips and per-action asks; the agent's own report of those calls is
  dropped so they show once, as the built-in brain's do. What `remember` kept
  rides the agent's preamble. Claude Code is handed `allowedTools:
  ["mcp__openlive"]`, so it never asks before one: OpenLive's own policy does.
  Codex-acp builds its MCP config itself and offers no such switch; it runs
  a tool marked `readOnly` (sent as the MCP `readOnlyHint`) without asking and
  asks for the rest, which the ask names as "OpenLive's <tool>" since the card
  it points at is hidden. Replay drops those calls as live does.
- **Models / modes / options.** The agent reports its models, modes, and other
  config options over ACP (a boolean option arrives as an On/Off pair, so it
  renders as a switch); the UI renders pickers generically and switches them
  mid-session (`set_model` / `set_mode` / `set_option`). Gemini CLI and Kiro still
  list models as session state, so their picker is filled from that and switches
  with `session/set_model`.
- **Agents that cannot take OpenLive's tools.** The `openlive` server is http, and
  an agent that says outright it takes none (`mcpCapabilities.http: false`) is not
  sent it, and the preamble no longer lists its tools, so the agent is not told
  about tools it cannot call. One that stays silent keeps it, since Hermes accepts
  http without advertising it.
- **Pi.** Its adapter, `pi-acp`, says it takes no MCP and drops `mcpServers`, but it
  starts pi as `$PI_ACP_PI_COMMAND`. So each session gets a private temp folder
  (0700) with a launcher that runs `pi -e <extension>` and an extension that
  registers the `openlive` server through `pi.registerMcpServer` (pi 0.99+) with
  `direct` exposure. Nothing goes into `~/.pi` or the project, and the folder,
  with the URL and its token, is removed when the adapter exits or the session ends.
- **Sign-in.** OpenLive never calls `authenticate`: each agent signs in through its
  own CLI (Settings → Agents opens it in a terminal). A `session/new` answered
  with `auth_required` is reported as "not signed in" with that agent's hint.
- **Supervision.** Every agent runs inside `AgentSupervisor`: per-turn watchdogs
  (start / first-output / stall), restart-once-then-fail, and every failure ends as
  a *spoken* one-liner + structured error — never a session stuck listening.
- **Cleanup.** Adapters spawn in their own process group so dispose kills the whole
  `npx → node → binary` tree.

History also surfaces each agent's **own** on-disk sessions
(`apps/web/src/app/api/history/agentSessions.ts` — Claude JSONL, Codex rollouts,
Cursor meta, OpenCode/Hermes read-only sqlite), deduped against OpenLive's chats,
so everything you did in the CLI shows up too. Gemini CLI, GitHub Copilot, Kiro and
Pi have no on-disk parser: Copilot and Pi are listed through their own `session/list`,
and Gemini's and Kiro's sessions from outside OpenLive do not appear.

## The voice loop (`apps/web/src/lib/live`)

One turn, end to end:

1. **VAD** (Silero v6.2, v5 selectable) gates the mic: is anyone talking?
2. **STT** (Whisper in the renderer, or a native engine) transcribes speech to
   text as it streams.
3. **End-of-turn** (Smart-Turn v3) decides you actually *finished*, not just paused.
   What you say over the agent's reply is a barge-in and goes out as soon as you
   stop, with no mid-thought hold.
4. The final text (plus the freshest camera/screen frame) goes out over `/live`
   (a model or agent that takes no images sees it through the vision model),
   with each word's onset in ms into the turn's audio (`wordsAt`, the turn's
   speech segments back to back). Parakeet and Nemotron time their own tokens
   (`tokenOnsets` in `timing.ts`, from sherpa-onnx's `timestamps`); Whisper,
   Moonshine and Canary report none, so the words are placed on the mic audio
   the way the agent's are on its voice (`heardOnsets`). The server saves them
   on the user message and in Flow's transcript, for later speaker labelling;
   the user's caption does not use them, since a word is only known once it is
   transcribed, already after it was said.
5. The reply streams back as text; **TTS** (Kokoro or Supertonic in the renderer,
   Supertonic on the agent, a native engine, or a cloned voice, see below) voices it sentence by sentence so speaking starts
   before the full answer exists. A chunk only ever ends at a sentence end (or
   at the 200-character cap): every engine voices the end of its text as the
   end of an utterance, so a cut at a comma would pause and restart the voice.
   Every engine's pitch and pace also move with how much text one call gets,
   so after the reply's first sentence the chunker holds finished sentences
   back: they go once they fill a chunk, once the audio queued ahead falls to
   about twice what synthesizing them is measured to take on this machine
   (`feed` in `voiceEngine.ts`), or before a tool runs and at the reply's end.
   A short last line joins the chunk before it while that one has not begun
   synthesizing. Where synthesis barely keeps up, every sentence goes as it ends.
   The player stops each chunk exactly at its end (Chromium otherwise sometimes
   repeats a resampled buffer's last 128 frames as a buzz) and runs the whole
   stream through one 30 Hz highpass, which removes the DC offset Kokoro and
   Kitten output carries.
   The worker trims each Kokoro or Supertonic render to its speech, keeping the
   pause that engine makes between sentences inside one render, so chunks
   played back to back join like one render (`KEEP_S` in
   `packages/shared/src/speech/trim.ts`, the agent's worker trims Supertonic the same way). Native
   Piper and Matcha sentences end with next to no silence, or with a quiet hiss
   that plays as a long pause, depending on the voice; the agent's worker fits
   each one to 10 ms before its speech and 50 ms after (`SENTENCE_EDGE_S` in
   `native-worker.ts`), the pause they make between sentences inside one render.
   `pnpm voice:regress` guards this: it renders a corpus of replies through the
   real chunker, synthesis and trimming, and fails when the joins drift from
   one render of the same reply (`tools/voice-regress`, see CONTRIBUTING.md).
   Each chunk is shown as the model wrote it and spoken as a person would say
   it: `toSpeech` (`packages/shared/src/speech/normalize.ts`, once per chunk,
   before any engine's own cleanup) spells out numbers, dates, times, money,
   units, percentages, ranges, phone numbers, versions, emails, URLs, file
   names, code identifiers, initialisms and symbols in the session language.
   Table and list furniture (column bars, `|---|` rules, box drawing, bullets)
   is a pause between words and nothing at an edge.
   Number words come from n2words, structure (decimal marks, unit and currency
   names and plurals, date order) from `Intl`. A number takes the session
   language's marks (1.500.000 in German, 1 500 000 in French, 1'500'000 in
   Swiss writing, 1,50,000 in Hindi); a dotted run reads as a version only
   where "." is the decimal mark, and as an address when its parts are octets.
   The chunker never cuts inside
   such a token ("3.5", "e.g.", "No. 5", "am 3. Oktober"), so a chunk reads as
   the whole reply would. A chunk that grows past what one engine call takes
   (spelled-out prices) is split at a word (`speechPieces`). The user's
   pronunciation dictionary (`pronunciations` in the pipeline config,
   `lexicon.ts`) matches the text as written, one trie-shaped regex per case
   mode, and its respellings are spoken exactly as typed.
   The caption and the transcript reveal each word when it is voiced. No engine
   reports word timing, so `packages/shared/src/speech/timing.ts` places the
   words on each piece's synthesized audio: `normalizeAligned` maps every spoken
   character back to the word it was written as, so a word weighs what it takes
   to say ("$1,200" as "one thousand two hundred dollars"); the voice's pauses
   of 90 ms or more are matched to word boundaries in order, punctuation first;
   between two of them the words share the voiced frames by weight. Chinese and
   Japanese characters are words of their own. Until a streamed piece is all in,
   its words are paced by the engine's estimated rate, and the caption on screen
   is retimed once it is (`onAgentTiming`).
6. **Barge-in**: start talking and it stops mid-word — the client aborts the turn
   (ACP `session/cancel` for agents) and the transcript keeps only what was spoken:
   the sentences voiced, then the words of the playing one begun by the cut, as
   its caption revealed them (`cutReply`, `heardText`). The server saves the same
   text. Hanging up mid-reply is the same cut, sent before the socket closes.
   The built-in brain's history is cut to match; a coding agent keeps its own,
   so its next turn opens with what was heard (`Agent.cut`), in chat and Flow,
   and in chat after a reconnect too (the `agentCut:<chat>` setting).
   The reply's own voice leaking from the speakers into the mic is dropped, never
   sent as a turn.
   A sound over a reply, or over a turn still at work, first only pauses it
   (`AudioPlayer.hold`: the audio clock stops, caption with it). Interim captions
   decide nothing here (Whisper reads half a laugh as "have a"): the final with
   any word that is not a backchannel or filler (`isBackchannel`, a
   list per language, plus laughs and throat sounds spelled out: a repeated
   syllable, "ugh", "ahem") cuts it as above, and so does more than 1.5 s of voiced
   talk before any words are in. The reply is silent meanwhile, so waiting on
   the final costs nothing audible. A cough, a laugh or a bare "mm-hmm" resumes it
   from the same sample, the segment dropped. A cut over a paused reply runs
   the audio clock again (`AudioPlayer.flush`). Outside a reply "yeah" is an
   answer and is sent; push-to-talk and a pending ask work as before.

The renderer models run on **WebGPU via transformers.js**. They download once
(roughly 200 MB with Kokoro, more with Supertonic or a bigger Whisper; cached)
and the worker stays warm for the tab's life.

**Model licenses.** Settings → Speech engine shows each engine's on its card, and Piper's
per voice in its Model menu. Silero VAD and Moonshine: MIT. Smart-Turn:
BSD-2-Clause. Whisper, Kokoro (browser and CPU), Kitten TTS and Matcha: Apache 2.0
(Matcha's LJSpeech data is public domain). Supertonic, the default voice:
[OpenRAIL-M](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE),
which allows commercial use but forbids some uses. Parakeet and Canary: CC BY 4.0.
Nemotron: NVIDIA Open Model License; Nemotron 3.5: OpenMDW-1.1. Pocket TTS: CC BY
4.0, its ONNX export non-commercial. Piper: per voice, its own dataset's
license, with the voice it was fine-tuned from named for information (`PIPER`
in `native-models.ts`); lessac's Blizzard 2013 data is research-only. Cloned voices
(ZipVoice): Apache 2.0 code, no license stated for the weights, trained on
Emilia (CC BY-NC 4.0).

**Restricted licenses are opt-in.** A model is open when its license is MIT,
Apache, BSD, CC BY or looser, or OpenMDW, with no restricting qualifier; the
exceptions, by choice, are Supertonic's OpenRAIL-M (the default voice) and the
NVIDIA Open Model License (Nemotron English). A Piper voice is judged by its own
data's license, not the voice it was fine-tuned from, so the CC0, CC BY and
BSD-style ones are open (`PIPER_OPEN`). Every other model (Pocket TTS, cloned
voices and the Piper voices whose data is research-only, non-commercial,
share-alike, AGPL or unknown) is marked
`restricted` in `pipelineConfig.ts`, and `web-catalog.test.ts` checks that
against the agent's license strings through `licenseTag` (`engineMenu.ts`).
Settings shows those locked; picking one asks first, inline, with what the
license limits and a link, and the OK is saved as `allowRestricted` in the
pipeline config. Without it `chooseVariant` refuses a restricted variant, and
the family defaults, `LANGUAGE_DEFAULTS`, the language-switch picks
(`pickCompatible`) and the browser fallbacks never land on one, so neither does
a warm-up, which only loads the selected engines. A config that already had one
keeps it, and Settings says what its license limits.

**Supertonic on this computer.** On the desktop the agent can run Supertonic
itself, on onnxruntime-node, with the synthesis the browser runs
(`packages/shared/src/speech/supertonic.ts`: the same text preprocessing, the
same seeded noise, the same trim), so both render the same voice. It is a
native engine of its own family (`supertonic-3`, marked `browser: "supertonic"`
in `native-models.ts`), downloaded from Settings → Speech engine into
`<home>/data/models/supertonic-3` file by file from the Hugging Face revision the
regression check pins. It is not a choice of its own: with Supertonic picked,
each call asks the agent once whether its copy is downloaded and can run here
(`GET /voice/engines`, `runnable`: onnxruntime-node ships no binary for Intel
Macs), and if so streams every sentence from it through `/api/voice/tts` and
loads nothing in the browser. A lasting failure (not downloaded, not runnable,
no agent) gives way to the browser's Supertonic, the same voice, quietly and for
the rest of the call; a one-off is tried again on the agent, as for any native
engine. Where it runs follows the native engines' rules below, over
onnxruntime-node's own providers (cpu, webgpu and coreml on Apple Silicon;
DirectML and WebGPU on Windows; CPU, and CUDA once its libraries are installed,
on Linux). Kokoro has no such copy: the sherpa-onnx Kokoro family already runs
the same Kokoro-82M v1.0 weights and voices on the agent, benchmarked the same
way, and kokoro-js cannot be given a thread count.

The **native engines** (`services/agent/src/voice/native*.ts`) are optional
sherpa-onnx models that the agent service downloads into `<home>/data/models/<id>` from
Settings → Speech engine. The catalog groups them in families of variants (size,
precision, chunk latency, voice): Nemotron and Nemotron 3.5 (streaming),
Parakeet, Moonshine and Canary for speech to text, Pocket TTS, Kitten TTS, Piper,
Kokoro and Matcha for speech. Each variant lists the languages it speaks; a call
may name one (`lang`, ISO 639-1) and an engine that does not speak it refuses
with `language-not-supported`. They run on the agent's CPU in worker threads,
at most two loaded models per worker. Batch transcription and synthesis go through `/api/voice`, and speech
streams back as raw Float32 PCM while it is generated. Nemotron takes mic frames
over the `/voice/stream` socket and sends partials while you talk. A missing
engine, an unreachable agent, or a voice engine that never starts on two
sentences in a row switches the call to Whisper or the browser voice
that speaks the session language (Kokoro for English, Supertonic otherwise), once
and for the rest of the call. A missing engine is expected, not an error: its
Settings card reads "Not downloaded, using ..." and the call lobby offers the
download (`missingEngines`, `engineMenu.ts`). A one-off failure (a timeout, a 500) falls back to
Whisper for that utterance; for speech the same voice tries the sentence once
more and, failing again, leaves it unspoken, so a reply never changes voice
mid-way. The stall clock for a sentence starts when the agent starts
synthesizing it, not while it waits on a cold load or another sentence.

**Where native engines run** is decided on each user's own device
(`voice/device.ts`, `voice/accel.ts`). At agent start a local probe records the
OS and version, CPU, logical, physical and (Apple Silicon) performance cores,
RAM, GPUs and driver, and the power source (sysctl, system_profiler and pmset on
macOS; one CIM query on Windows; nvidia-smi, lspci, /proc and /sys on Linux),
plus the execution providers compiled into each installed ONNX Runtime: sherpa-onnx's
(CoreML in the sherpa-onnx 1.13.8 darwin builds; the win and linux builds are CPU
only) and onnxruntime-node's (its `listSupportedBackends`, for Supertonic).
Any probe may fail; its field is left out and the choice stays on CPU. Each
engine gets a thread share of that device's fast cores (`threadsFor`) and a
performance tier (low, mid, high) for recommending engines. Every engine starts
on CPU. After its first use, once the voice path has been idle for 30 s, a
benchmark times it on each usable provider in a child process of its own
(`native-worker.ts` forked with `ELECTRON_RUN_AS_NODE`, so Electron's binary
runs it as Node in the packed app and tsx's loader carries over in dev): load,
first run, then the median first-output time and real-time factor of a fixed
input. A native crash, any other exit or a 2 minute timeout fails only that
provider. An accelerator is used only if it cuts CPU's real-time factor by 20% or
more. Load time, which holds CoreML's compile, never counts toward that. Any
voice job aborts a running benchmark and kills its process, as does the agent
exiting; an engine whose benchmark took the agent down twice anyway stays on CPU. Results live in `<home>/data/voice-accel.json`,
keyed by the device fingerprint, the variant and its files, so a new device,
runtime or download measures again. A provider that fails in a real call is
retired for that engine and the next load runs on CPU. Settings → Voice shows the
device, and per engine where it runs, the numbers behind it, an Auto / CPU /
accelerator override and "Re-run benchmark" (`GET /voice/perf`,
`PUT /voice/perf/engines/:id`, `POST /voice/perf/engines/:id/bench`).
`pnpm --filter @openlive/agent bench:voice` prints the same benchmark for every
installed engine, for developers; the app never reads it.

The **voiceprint** (opt-in under Settings → Voice → VAD: Off by default,
Label voices, Only me) lets only the enrolled user start turns and barge in,
and labels each turn "you" or "other N". The agent holds the model and the
print (`voice/voiceprint.ts`): 3D-Speaker's CAM++ zh-en "advanced" (Apache-2.0,
192-dim, 28 MB, the `voiceprint` family, kind `speaker`) through sherpa's
`SpeakerEmbeddingExtractor` on a worker thread of its own, benchmarked by P0
like the other engines. Enrollment is explicit: the user reads a paragraph in
Settings for about 15 s, each VAD segment folded into the mean of unit
embeddings for that mic (`POST /voice/voiceprint/enroll`); the gate turns on at
10 s. Passive enrollment was ruled out because in a shared room the first
voice need not be the user's, and a print seeded by someone else shuts the
user out. After that, a segment scoring 0.6 or more with 2 s of speech is
folded into its mic's print (the user's median over 2 s is 0.67 to 0.79 in
the eval, other voices' 99th percentile under 0.36), so the print follows the
user, and a new mic gets a print of its own; a segment scores against the
best of up to six. Prints live in the settings store under `voiceprint`
(never exposed by `/api/settings`, never sent anywhere) and go with
`DELETE /voice/voiceprint` or a model change. `POST /voice/voiceprint/verify`
takes the PCM and `voiced` (ms of speech the VAD heard) and picks the
threshold for that much speech. In `VoiceEngine`, with "Only me" on and the
user enrolled (`GET /voice/voiceprint` at each start, so a mic change
re-reads it): a segment is checked at 1 s and 2 s of speech. Failing either,
it is ignored like echo, and a reply it paused goes on; the P3 pause already
silenced the agent at onset. Talk over the reply cuts it past 1.5 s only once
both checks passed (never later than 3 s), and soft speech the echo check took
for the agent's own voice barges in once both pass. At the end the whole
segment is checked again, alongside transcription: another voice never
becomes a turn, and a segment ignored early that turns out to be the user's
becomes their turn after all, cutting the reply. Push-to-talk is never turned
away, only labelled, by the verdict on its longest segment. Without the agent,
the model or an enrollment, or on a failed verdict or one 1.5 s late, speech
goes through as on flow. An embedding with nothing in it (zero or non-finite)
is no verdict either: verify answers 422 rather than score it 0, which would
pass the under-a-second threshold, and enroll folds nothing in. The 1.5 s count from when the request leaves: the
browser sends a fetch only once the page's current task ends, and on a busy
page a request the agent answered in 130 ms left 1.43 s after the call (QA,
2026-09-26). "Label voices" checks only the whole segment, for the
label; other voices are grouped per call at cosine 0.35, and a held mid-thought
pause is sent on its own rather than joined to the next segment when that one
is another voice's. The room's noise floor is learned only from idle frames the
VAD calls silence, never from a voice the gate is ignoring, and a segment's
start takes it back to where it stood 800 ms earlier, before its first words.
Labels travel as `speaker` on `user_text`/`flow_text` into the saved text block
and show over another voice's bubble in the transcript.
Measured 2026-09-26 (`pnpm voiceprint:eval`, 40 LibriSpeech speakers enrolled
on 15 s, 480 of their utterances and 126 in the agent's own voices, each clean,
through a narrow quiet mic, an overdriven mic, an echoey room, 4-talker babble
at 5 dB, pink noise at 5 dB, and room, babble and mic at once), thresholds
blocking at most 1% of the user's trials of each length, pooled:

| speech | EER | threshold | FAR other people | FAR agent's voices | worst condition FRR |
| --- | --- | --- | --- | --- | --- |
| 0.5 s | 25.5% | -0.085 | 94.7% | 92.7% | 3.3% (babble) |
| 1 s | 6.0% | 0.087 | 43.3% | 37.7% | 3.3% (babble) |
| 2 s | 1.5% | 0.286 | 3.8% | 3.4% | 2.7% (room+babble+mic) |
| 4 s | 0.8% | 0.400 | 0.6% | 0.5% | 2.3% (room+babble+mic) |
| whole | 0.8% | 0.416 | 0.5% | 0.4% | 2.1% (room+babble+mic) |

At 2% false rejects the 1 s threshold (0.136) still lets 26% of other voices
through: no model reached 2% false rejects with 5% false accepts on one second.
Hence the second check at 2 s and the whole-segment verdict. The other
candidates did worse on every window (EER at 1 s / 2 s / whole): ERes2Net en
8.3 / 3.9 / 2.2%, TitaNet large 9.5 / 5.3 / 3.3%, TitaNet small 11.4 / 5.9 /
3.8%; the 512-dim CAM++ exports and WeSpeaker ResNet34 did not work through
sherpa-onnx-node 1.13.8. Extraction on this M4's CPU (2 threads, P0's choice:
CoreML was under 20% faster) through the worker, p50 / p95: 6.5 / 11 ms for
1 s, 9.9 / 16 ms for 2 s, 16 / 27 ms for 4 s, 23 / 82 ms for whole utterances
of up to 35 s, which run alongside transcription. Not measured: real
microphones and rooms (the conditions are simulated), languages other than
English for the user, and children's voices.

The **side talk check** (addressee detection), opt-in under Settings → Voice →
Turn-taking → Side talk (Off by default; Ignore side talk), drops a finished
sentence said to someone else in the room, or to no one ("did you feed the
dog?", "hang on, John, I'm on a call"). `VoiceEngine` asks the agent
(`POST /voice/addressee`, `voice/addressee.ts`) with the sentence, the reply as
voiced so far and the voiceprint's label, in parallel with the turn model, so
it adds at most the check's own few ms after the transcript. The agent embeds
the sentence with Paraphrase Multilingual MPNet (sentence-transformers,
Apache-2.0, int8 ONNX export by Xenova, 296 MB; 50+ languages, all ten of the
app's) on onnxruntime-node in the native worker (`addressee` kind, P0's
benchmark and accelerator choice like any engine: CPU on this M4, 8 ms per
sentence against 30 ms on CoreML), and scores it with a logistic head
(`@openlive/shared/speech/addressee-head`, written by the eval). Rules come
first, and only ever toward answering: a sentence after a reply that ended on a
question is its answer unless another voice says it, a sentence naming
OpenLive is for it, an open ask takes every sentence as its answer, and
push-to-talk is never judged. Another voice (voiceprint on "Label voices")
is taken for side talk one log-odds sooner. Asymmetric by design: an agent that
is down, slow (800 ms), not downloaded or failing lets the sentence through.
Judged side talk said into silence is dropped (a held mid-thought is dropped when
its hold ends; tapping "send now" sends it anyway); over a paused reply it
resumes the reply like a backchannel. With the check on, talk over the reply
no longer cuts it at 1.5 s voiced: the reply stays paused until the words
decide. Each dropped sentence shows in the transcript, dashed and faint, with
"Send it", which sends it as a turn. Flow's orb shows the last one, dashed,
with "Send it", until the next turn. Neither mark survives a reload: a dropped
sentence never reaches the agent, so it is not in the saved conversation, and
keeping it there would mean a message kind the agent's history does not have.
"Judge only" (`shadow`) judges every sentence the same way and drops none: the
turn never waits on the verdict, and a reply is cut as with the check off.

Measured 2026-09-26 (`pnpm addressee:eval`). No openly licensed corpus of
people talking to a voice assistant and to each other in one room was found,
so the set is synthetic, written for the eval: a training split of 283 English
sentences in context (the agent's last reply, the speaker), and held-out
splits of 156 English and 162 in the nine other languages. Its hard cases:
thinking aloud, questions to the app that sound like ones to a person ("did
you save the file?"), requests to a person that sound like ones to the app
("can you grab the milk?"), short commands, vocatives, calls, pets and kids.
The head and its threshold (ignoring at most 1% of the training split's
addressed sentences, scored out of fold) come from the training split alone:

| split | AUC | addressed ignored | side talk caught | precision | caught, by you | caught, other voices |
| --- | --- | --- | --- | --- | --- | --- |
| English, voiceprint off | 0.895 | 1.1% (1 of 90) | 22.7% | 93.8% | 16.7% | 38.9% |
| English, voiceprint labels | 0.895 | 1.1% (1 of 90) | 27.3% | 94.7% | 16.7% | 55.6% |
| nine languages, voiceprint off | 0.979 | 0% | 68.1% | 100% | 63.0% | 83.3% |
| nine languages, voiceprint labels | 0.979 | 0% | 72.2% | 100% | 63.0% | 100% |

The one addressed sentence ignored is another voice's "Can you tell us a
joke?"; none of the user's own (87) was. The 60% of side talk aimed for is
missed on English; the nine-language split scores higher only because its
sentences are close to the training split's, translated, so it overstates.
"Only me" drops other voices before this check, leaving the user's own side
talk: 16.7% caught. The context rules changed no result here (the scores were
already low after a question); they stand as a floor. Embedding p50 / p95
through the worker: 3.5 / 5.1 ms; the route answered in about 10 ms warm, 650
ms on the first sentence, which the call's warm-up takes. Also tried, through
transformers.js on the same splits: Paraphrase Multilingual MiniLM-L12
(Apache-2.0, AUC 0.854 on English) and multilingual E5 small (MIT, 0.887),
both below MPNet; Qwen3 Embedding 0.6B with an instruction (Apache-2.0, 0.889,
43 ms); Qwen2.5 0.5B Instruct asked zero-shot (Apache-2.0, 0.587, 131 ms);
adding the reply's similarity or the speaker to the head did not help. Not
measured: real speech through speech-to-text, the user's tone and loudness (the
check reads words only), and real rooms.

**Listening sounds** (`turn.backchannels`, off by default; Flow passes
`backchannels: false`). At a held pause (Smart-Turn or the words say the thought
goes on) of a turn with 3 s of speech, at most once per 8 s, never after a
question (a question mark, or an English question word first), over a reply,
an ask or push-to-talk, the engine plays one of `LISTENING[lang]` (words the
backchannel check itself counts as one, in all ten languages) at gain 0.4,
rendered once per voice at call start in the voice the reply will use. It plays
on its own AudioPlayer, so the reply's echo gate, barge-in and pause (P3) and
the voiceprint's timing (P2) never see it, and the first voiced frame stops it.
It never reaches onAgentText, the transcript or the agent. In the eval: 8 sounds
in 30 turns, p50 820 ms after the pause began, 0 overlapping the user's speech.
Not measured: the sound leaking into the mic over speakers (the eval has no
room); the page's echo canceller hears it like the reply, at -8 dB.

The **judgment log** (Settings → Side talk → "Keep a judgment log to train on",
off by default, shown once the check is on) keeps each judged sentence on the
agent, in `<home>/data/addressee-log.jsonl`, for `pnpm addressee:train`: its words
(up to 1000 characters), the last 300 characters of the reply before it, the
time, the score, verdict and head that judged it, the mode, the voiceprint's
label, and how it sounded (below). Never the audio, and it is never sent
anywhere. Corrections label an entry: "Send it" on a dropped sentence (or "send
now" on a held one judged side talk) marks it said to the app; "Not for you",
under a spoken turn that was logged, marks it side talk and cuts the reply to
it when that reply is the one under way (the turn stays in the agent's history:
taking it out would rewrite a saved conversation). The file is append-only, a
judgment or a label a line, folded into a map on first read (O(lines)); the
newest 5,000 entries are kept (about 1 KB each, oldest evicted first), and once
the file holds twice that in lines it is rewritten with the kept ones, so an
append is O(1) amortized and the file stays under about 10 MB. Settings shows the
count and how many the user marked, and deletes the log together with the head
trained on it.

How a sentence sounded (`Feats`, `@openlive/shared/speech/addressee`), from
audio the engine already holds, in the page: loudness against the user's
running speech level (an average moving a fifth of the way to each of the
user's sentences), the spread of frame loudness, median and spread of pitch
(autocorrelation over 50-400 Hz on 8 kHz frames of 40 ms), words per second of
speech (words counted by `Intl.Segmenter`, so unspaced scripts count), the
segment's length, seconds since the agent's voice stopped (0 over it), whether
it cut or paused the reply, and whether the voiceprint's label changed from the
sentence before. O(n x 140 lags) over the segment's last 8 s at most: about 18M
multiply-adds, a few ms, once per finished sentence.

`pnpm addressee:train` fits the user's own head on the synthetic training split
plus the log (a correction weighs 4 synthetic rows; an unmarked entry 1, labelled
by what happened to it), with and without the sound features, scores the log
out of fold (a sentence's repeats in one fold), and sets the threshold that
ignores at most 1% of the user's own addressed sentences there. It writes
`<home>/data/addressee-head.json`, never the shipped head. The agent judges with it
(reread when the file changes) only when it is for the same model, has the
right shape and passed: at least 100 addressed and 20 side talk sentences
logged, at most 1% of the user's addressed ones ignored, more side talk caught
than the shipped head at that rate, and no more of either synthetic held-out
split's addressed sentences ignored than 1% or the shipped head's share.
Otherwise the shipped head judges.

Checked end to end 2026-09-26 on a simulated log (`pnpm addressee:simulate`, no
real room): the 156 held-out English sentences in two macOS voices (Samantha,
Daniel) at levels 6 dB apart, give or take 3 dB, through the agent's Nemotron
speech-to-text (84% word for word) and the page's `speechStats`, judged in
"Judge only" and labelled with their truth (310 kept, 2 heard as nothing).
Scored out of fold on that log, at most 1% of the 154 addressed ones ignored:

| log | head | AUC | addressed ignored | side talk caught |
| --- | --- | --- | --- | --- |
| sound unrelated to the label | shipped | 0.870 | 0% | 12.1% |
| | yours, words only | 0.866 | 0% | 18.9% |
| | yours, words + sound | 0.847 | 0.6% | 10.6% |
| side talk 6 dB quieter | shipped | 0.875 | 0% | 12.1% |
| | yours, words only | 0.870 | 0% | 18.9% |
| | yours, words + sound | 0.946 | 0.6% | 50.8% |

So the pipeline works (features are computed, logged, standardized, weighted,
and a passing head is taken by a running agent), and the sound features find a
cue that is there (loudness got -3.0 log-odds per standard deviation) and cost
a little when there is none. Whether real side talk is quieter, or differs in
any way a mic hears, this cannot say: two synthetic voices in a silent room are
weak evidence. With no cue the head trained on words failed its eval, ignoring
10% of the nine-language split's addressed sentences against the shipped
head's 0% (an English log pulls the head away from the other languages); the
English split's numbers are not held out here, the log being made from it.

The **latency budget** (`lib/live/perf.ts`) records each turn's speech-to-text
plus end of turn, model to first token, and voice to first sound, measured on the
device. The call's top bar shows the session's median voice-to-voice time, and
its popover the median and p95 of each stage.

A session runs in **one language** (`language` in `pipelineConfig.ts`: en, es, fr,
de, it, pt, hi, zh, ja, ko) and every stage follows it: STT gets `lang` (Whisper
switches from its `.en` build to the multilingual build of the same size and
pins the language), TTS gets it (Supertonic as its language tag), the chunker
splits on Chinese, Japanese and Devanagari sentence marks, and the English
turn-taking word list applies to English only. Each `user_text` / `flow_text`
carries it, and the reply follows: one "Always reply in …" line in the built-in
model's system prompt, or at the head of the turn for a coding agent over ACP.
English adds nothing. The `/live` connect URL carries it too (`?lang=`), so the
connect-time warm-up primes the prompt cache in it. `pickCompatible` swaps an
engine that cannot speak a newly chosen language for one that can. In Settings →
Voice the Language picker sits above the stages; each family is one card with a
Model menu of its variants, and a family or variant that cannot speak the
language is greyed out with the languages it can.

## Voice cloning (`services/agent/src/voice/`)

Voice Studio does zero-shot cloning with **ZipVoice** (k2-fsa, Apache-2.0, 123M
distilled int8) through the **sherpa-onnx Node addon**, running in the agent
service on CPU, on the device's thread share (above), the one place in OpenLive with a native module, loaded lazily
via `createRequire` so nothing changes for people who never use it. The reference
recording rides every `generate()` call, so one engine instance serves every
saved profile; `generateAsync` synthesizes on sherpa's native thread pool
(measured ~0.22x realtime on an M-series CPU) and the engine unloads after five
idle minutes. The model is a user-managed ~208 MB install under
`<home>/data/models/zipvoice`, profiles are a wav + transcript under `<home>/data/voices`, and
the renderer reaches it all through a same-origin `/api/voice` proxy — the
cloned audio streams back as raw Float32 PCM into the same `AudioPlayer` /
barge-in path as the on-device engines, with Kokoro as automatic fallback.

## The built-in provider brain (`services/agent/src/live/turn-runner.ts`)

Conversations with no agent bound run on a provider turn loop: three wire adapters
in `packages/harness` (Anthropic `/messages`, OpenAI `/responses`, OpenAI
`/chat/completions`) cover every provider; a provider is a registry row. The main
voice agent does all the talking and delegates web work to a **worker subagent**
(Exa search, `fetch_url`) whose grind stays out of the main context. Its other
tools come from the shared registry below.

A turn takes at most six tool steps, then one more with `tool_choice: "none"`,
so it ends in words. If that call errors, it is tried once with no tools where
that is a valid request (not over Anthropic with tool calls in the history), and
if it still says nothing, a short line (`OUT_OF_STEPS`) is spoken instead.

## Tools (`services/agent/src/capabilities/`)

Chat and Flow keep their own loops (`LiveTurnRunner`, `runFlow`) but draw on one
tool registry, and both run every call through one `dispatch` (repair, validate,
precheck, approve, run, tally).

- **One `Tool` type** (`types.ts`): name, description, JSON Schema, optional
  prompt guidelines, `readOnly` (sent over MCP as `readOnlyHint`), `confirm`
  (it changes something, and this is the question to ask first), `precheck`
  (cheap checks run before the approval prompt, so nobody approves a call that
  would fail: the file tools check the workspace and the edit snippet), and
  `available(session)`, which reads what the session can reach: the app in front
  and insertion (Flow), the clipboard, the device addon, a live share (`look`, a
  call), a workspace (the file tools, a call).
- **The registry** (`registry.ts`). `registry.tools(profile, session)` returns a
  `ToolSet`, ordered for the mode and looked up by name in O(1). Sources of tools
  are `ToolProvider`s; the built-ins are one, and a provider registered later
  never shadows a name already taken.
- **Groups** (`groups.ts`). Each built-in tool names its `group` (Computer use,
  Files, Find and undo, Web research, Text, Assistant, Reminders, Shell, Skills, Connectors); `GROUPS`
  says how each reads in
  Settings. A group switched off is listed in `disabledToolGroups` in
  settings.json (comma-separated ids) and `registry.tools` leaves its tools out of
  every new session, every brain and the MCP server alike. `/capabilities`
  (`routes.ts`, proxied at `/api/capabilities`) lists the groups from
  `builtinCatalog()`, switches one, and saves or clears the Exa key, which it
  never sends back.
- **Profiles** (`profiles.ts`). `CHAT` and `FLOW` set the order the model sees,
  the system prompt (each builder renders the guidelines of the tools the
  session has), and the approval policy: a call asks before each action that
  changes something (`askEach`), Flow takes consent once (`consentApprove`).
  No profile removes a tool.
- **The device.** `ol-input` lives in Electron main. Either session reaches it
  through its client's tool bridge (`flow_device`), which calls
  `window.openlive.flow.device` and main's `openlive:flow-device` handler. Flow
  always has it; a call has it when the desktop app connects with `device=1`.
  `look` (the frame a call shares) and `screenshot` (the display, sized for
  pointing) stay distinct. Where the computer-use helper runs, its tools replace
  ol-input's pointer, keyboard and screenshot tools (next section).
- **MCP** (`mcp.ts`). One server, named `openlive`, serves a session's `ToolSet`
  to a coding agent on a random loopback path, through the same dispatch and
  approval. It is stateless (MCP SDK v2 `createMcpHandler`): each request gets
  a fresh low-level `Server` over the same tools, so a 2025-era agent and a
  2026-07-28 client both connect, and no agent's session can end another's.
  The low-level `Server` rather than `McpServer`, because `McpServer` validates
  names and arguments before a handler runs and would refuse the calls dispatch
  repairs.

## Computer use (`native/openlive-cu/`, `services/agent/src/computer/`)

A separate Rust helper process, `openlive-cu`, that reads app windows through
the accessibility tree, captures them, and acts on them. One helper per server,
shared by every session; the server wraps it and serves it through the registry,
so an API brain gets native tools and a coding agent gets them over the
`openlive` MCP server. OpenLive stays in the middle for approval, one input lock
and telemetry.

```
 Chat / Flow loop ─┐                     ┌─ ComputerHelper (computer/helper.ts)
 ACP agent ── MCP ─┴─ registry ─ tools ──┤     spawn, token, restart, reap
                      (dispatch,          │
                       approval,          └── NDJSON over a private socket ──▶ openlive-cu
                       input lock)                                              core + this OS's backend
```

- **Crates** (`native/openlive-cu/crates`). `core` (`openlive-cu-core`): the
  protocol types, NDJSON framing (4 MiB line cap), token auth, the indexed tree
  text (1200 elements, 64 levels; O(N·D) reads), coordinate scaling, the image
  policy, and the request loop every OS shares. `platform-macos` (AX via
  `objc2-application-services`, ScreenCaptureKit's `SCScreenshotManager` via
  `objc2-screen-capture-kit`, CGEvent via `objc2-core-graphics`).
  `platform-windows` (UI Automation, Windows.Graphics.Capture and SendInput,
  all through Microsoft's `windows` crate 0.62). `platform-linux` (AT-SPI
  over `zbus` 5 with `atspi-common` 0.14 for roles and states, X11 over
  `x11rb` 0.14, the xdg-desktop-portal over `zbus`, PipeWire through
  `libloading`). `helper` is the binary.
- **Transport.** A Unix socket on macOS and Linux, a named pipe on Windows
  (`interprocess`), in a 0700 directory: under `$XDG_RUNTIME_DIR` on Linux
  when it is set, the temp directory otherwise. A named pipe lives in a global
  namespace whose default descriptor lets Everyone read it, so the helper
  gives it a protected DACL naming the current user's SID alone, and refuses
  to listen without one. The client writes a random token
  to a 0600 file there; the helper reads and deletes it, and every request
  carries it. The helper serves one owner and exits when that connection
  closes, when told to `terminate`, or when nobody claims it within 30 s.
- **Methods** (protocol 1). Every action answers with the window's refreshed
  state, tree and picture, after a settle time the client picks.

  | Method | Does |
  |---|---|
  | `handshake` | protocol, platform, `ready` (false on a stub backend) |
  | `permissions` / `requestPermission` | grants and their System Settings links (on Linux a line of guidance instead); only the request may prompt |
  | `listApps`, `listWindows` | running apps; windows with native ids and desktop frames |
  | `getAppState` | the indexed tree text, a picture of the window, its frame |
  | `click` | element: AXPress, AXConfirm, AXOpen (AXShowMenu for right) on macOS; Invoke, Toggle, SelectionItem.Select, ExpandCollapse (ShowContextMenu for right) on Windows, the last three read back; on Linux a list, tree or tab item through its container's Selection, else the first of the element's `click`, `press`, `activate`, `jump`, `toggle` actions (`showMenu` for right), checked, pressed, expanded and selected states read back; else a posted click at its centre; point: a posted click. Reports the path and whether it was read back |
  | `performSecondaryAction`, `setValue` | an element's listed action; a typed value, read back |
  | `typeText`, `pasteText` | AX replace of the selection (AT-SPI EditableText insert at the caret on Linux), read back, else posted keys or a clipboard paste that restores the clipboard |
  | `pressKey`, `hotkey` | one key or a chord (`cmd+a`, `ctrl+a` on Linux, selects through the accessibility API when it can) |
  | `scroll`, `drag` | `AXScroll…ByPage` (ScrollPattern on Windows) on an element, else posted wheel or drag (always posted on Linux, where toolkits name no scroll action) |
  | `move`, `mouseDown`, `mouseUp` | the pointer alone for a hover, and half a click for a gesture `drag` cannot express; a move while a button is held drags |

- **Coordinates.** x and y are pixels in the last picture of that window. The
  core maps them onto the window's frame, refuses a point off the picture, and
  refuses a window that changed size since. Window ids are the platform's own
  (CGWindowID, the HWND's low 32 bits on Windows, the XID on X11), the same
  ids ol-input's window tools take; on Wayland, where windows have no global
  id, a hash of the window's AT-SPI object, which only the helper's tools
  take. Desktop coordinates are points on macOS, physical pixels on Windows,
  X screen pixels on X11 and the compositor's logical coordinates on Wayland.
- **The default target.** With no app named, the helper takes the window in
  front, or, when that is OpenLive's own, the frontmost window that is not.
  OpenLive's own is any app run from `OPENLIVE_CU_OWN_ROOT`: the install
  (set by Electron main) or, in dev, the repo, where the dev Electron lives.
- **Pictures.** 1280 on the long edge (ol-input's 1024x768 cap is for whole
  displays; one window at 1280 keeps a 2x window's text legible and stays under
  every vision model's resize limit), PNG while it fits 900 KB, then JPEG, then
  smaller by a fifth until it fits.
- **Who owns it.** The server: it already owns the registry and the MCP server,
  and nothing about TCC needs Electron main. The helper is its own app,
  `OpenLive Computer Use.app` (`com.openlive.computer-use`), in the app's
  Resources; at launch it re-spawns itself with TCC responsibility disclaimed,
  so Accessibility and Screen Recording are granted to it, whoever spawned it.
  Dev runs the build in `native/openlive-cu/dist` without disclaiming (a
  self-responsible process under `~/Desktop` stalls on a folder prompt), so dev
  grants are those of whatever launched OpenLive.
- **Packaging.** `pnpm native:build` builds it when stale (host arch).
  `pack:native` builds it (universal on macOS) and stages it in
  `dist/computer-use`; electron-builder copies the macOS app into Resources
  and signs it with the app, and ships `openlive-cu.exe` in the Windows
  resources and `openlive-cu` in the Linux ones (inside the AppImage it runs
  from the mounted image; `check-native` refuses any package without it). The Windows
  executable embeds its manifest (`crates/helper/build.rs`): `asInvoker` and
  per-monitor-v2 DPI awareness. `OPENLIVE_CU_SIGN_IDENTITY` (or
  `CSC_NAME`) signs a dev build with a real identity, so a grant survives
  rebuilds; otherwise it is ad hoc. Electron main passes the path as
  `OPENLIVE_CU_HELPER`; an empty value turns the helper off.
- **The client** (`computer/helper.ts`). Starts on first use, handshakes,
  times a request out at 30 s and restarts a hung helper, restarts after a
  crash, rests for a minute after three crashes, and kills it on exit.
- **The tool surface.** A desktop session (Flow, or a call from the desktop app)
  gets the helper's tools where it is available: `get_app_state`, `list_apps`,
  `list_windows`, `click`, `perform_action`, `set_value`, `type`, `keypress`,
  `scroll`, `drag`, `move`, `mouse_down`, `mouse_up`, `wait`, and
  `read_screen_text` (ol-input's OCR over the helper's picture). ol-input's `screenshot`, pointer and keyboard tools are
  left out, so there is one `click` and one coordinate space; its window tools,
  `get_window`, `open_app`, `open_url`, `shell` and `camera_frame` stay.
  Without the helper (no build) the session gets
  ol-input's tools as before. Reads are `readOnly`; actions have `confirm`, so a
  call asks before each and Flow's one consent covers them.
- **One input lock** (`capabilities/input-lock.ts`). Every action, through the
  helper or ol-input, waits its turn, so two sessions never interleave input.
- **Windows.** The tree is UI Automation's control view, read with one
  CacheRequest per element and one `FindAllBuildCache` per parent (one IPC
  round trip per expanded element; the cycle guard compares cached RuntimeIds
  in process). Control types map onto the AX role names and patterns onto the
  AX action names, so the tree text and `perform_action` read the same on both
  systems.
  - *DPI.* The helper is per-monitor-v2 aware (manifest, and at startup), so
    window frames (the DWM extended frame, without the invisible resize
    borders), UIA bounds and SendInput are all physical pixels.
  - *UIPI.* Windows drops input to an app running as administrator from one
    that is not, silently, and withholds its tree. The helper compares
    integrity levels and refuses every action on such a window with a
    sentence that says so; `get_app_state` appends it to the tree.
  - *Focus.* SetForegroundWindow, then UI Automation's SetFocus, and nothing
    else (no AttachThreadInput, no synthetic Alt). Keystrokes are refused when
    the app is still not in front; a click needs only to land on the app,
    which the helper checks by hit test first. Windows lets only the process
    in front raise a window, and with OpenLive in front that is Electron main,
    so before each helper request the agent asks main over its parent port and
    main calls `AllowSetForegroundWindow(helperPid)` through ol-input. The
    request waits for main's answer, 250 ms at most.
  - *The capture border.* WGC draws a yellow border while it captures.
    Turning it off officially needs a consent prompt and a packaged app's
    `graphicsCaptureWithoutBorder` capability; the helper is unpackaged, so it
    sets `IsBorderRequired = false` where that property exists (Windows 11)
    without asking, and otherwise the border shows for the one frame a
    picture takes. PrintWindow (`PW_RENDERFULLCONTENT`) is the fallback when
    WGC fails.
  - *No desktop.* In session 0 (a service) the handshake says not ready; while
    the screen is locked or a UAC prompt holds the secure desktop, actions are
    refused and the grants read as not allowed.
- **Linux.** AT-SPI is the tree on X11 and Wayland alike; the display server
  decides windows, pixels and input. The session type comes from
  `XDG_SESSION_TYPE` and `WAYLAND_DISPLAY` (under Wayland, `DISPLAY` is
  XWayland and never decides). Nothing links a system library: D-Bus and X11
  are spoken in Rust, and `libpipewire-0.3.so.0` is loaded with dlopen only
  to take a Wayland picture (missing, the picture says what to install). The
  release binary needs libc alone.
  - *The tree.* The helper reaches the accessibility bus through
    `org.a11y.Bus.GetAddress`. A parent's children come in one `GetChildren`;
    every child's role, states, interfaces, name, attributes, actions, value
    and text are then asked for all at once, so a level costs a few round
    trips in flight together: O(V) calls for V elements visited, O(D) round
    trips of wall time for depth D, each call capped at 1 s so a hung app
    cannot hold the walk. Rows of long lists, tables and trees are walked
    only while showing. `Cache.GetItems` is not used: its reply is a whole
    app, unbounded, and GTK 4 lacks it. Roles map onto the AX names, toolkit
    actions onto the AX action names, so the tree text and `perform_action`
    read as on the other systems; focus is found as the walk passes it.
  - *Accessibility switch.* `requestPermission` (and each observation) sets
    `org.a11y.Status.IsEnabled`, the documented switch GTK, Qt and the AT-SPI
    bridges read. Never `ScreenReaderEnabled`: on GNOME that launches Orca, and
    editors change behaviour for screen readers. On Cinnamon it touches
    nothing (its settings daemon can loop rewriting the two), and the grant's
    guidance says where to turn it on. Apps read the switch at start, so
    open ones need a restart. Chromium and Electron build their tree only
    with `--force-renderer-accessibility` or `ACCESSIBILITY_ENABLED=1`; a
    Chromium window (toolkit `Chromium`) with almost no elements gets a line
    in its tree text saying so. There is no allowlist to flip as on macOS.
  - *X11.* Windows from EWMH `_NET_CLIENT_LIST_STACKING` (front to back), with
    `_NET_WM_PID`, `WM_CLASS`, `_NET_WM_NAME`; the frame is the client area
    grown by `_NET_FRAME_EXTENTS` and shrunk by `_GTK_FRAME_EXTENTS` (a
    client-side-decorated window's shadow). With no window manager (Xvfb) the
    root's mapped children stand in. An X window is matched to its AT-SPI
    frame by process, place and title. Pictures are `GetImage` of the root,
    cropped to the frame (what is on screen there, occluders included; MIT-SHM
    is not used, one frame does not need it). Focus is the
    `_NET_ACTIVE_WINDOW` request a pager sends. Input is XTEST. Text goes in
    by keysym: each character's keysym is found in the live keymap with the
    Shift or AltGr level it needs, and one missing from the layout is bound
    to a spare keycode for the press and unbound after, as xdotool does; Caps
    Lock is turned off around typing. Paste owns the CLIPBOARD selection from
    a thread with its own connection, serves the text, then serves the
    user's previous text until someone copies again (a clipboard manager
    keeps it after the helper exits; an image is not put back).
  - *Wayland.* There is no global window list, so windows are AT-SPI frames.
    A native Wayland client cannot know its position, and toolkits report
    (0, 0); only XWayland clients report real ones. A window at (0, 0) is
    therefore shown as the whole shared desktop: its picture is every
    monitor, x and y are desktop positions, elements act through their own
    actions, and aiming at an element by position is refused with a pointer
    to the picture. The frame sizes are right; the origins are not, which the
    tree text says.
  - *The portal session.* One RemoteDesktop session carries the keyboard,
    the pointer and a screen cast of every monitor (`types` monitor,
    `multiple`, cursor hidden). The consent dialog shows only from
    `requestPermission` (Access > **Allow**), started in the background so
    the request returns while the user answers; `permissions` reads granted
    once a session runs or a restore token is kept. `persist_mode` 2 (until
    revoked, RemoteDesktop version 2 and later) makes every `Start` return a
    single-use restore token, written 0600 to `<home>/state/portal-token`
    (the agent names it in `OPENLIVE_CU_PORTAL_TOKEN`; a helper run on its own
    falls back to `$XDG_STATE_HOME/openlive/computer-use/portal-token`); the next session
    starts from it without a dialog, before the frame of a request is decided.
    A quiet restore that fails is retried after 30 s, not per request. A
    session idle for two minutes is closed so the compositor's indicator goes
    off, when the portal gave a token to restore it; one that gave none stays
    open, since closing it would mean another dialog. When the compositor closes it (the user pressed Stop), the token is
    forgotten, so it is not brought back unasked. Where RemoteDesktop is
    missing (xdg-desktop-portal-wlr) the session is ScreenCast only, with its
    own token, and posted input is refused with a sentence that says why.
  - *Wayland pictures and input.* A picture opens the session's PipeWire
    remote (`OpenPipeWireRemote`), connects one stream per monitor with an
    `EnumFormat` of 32-bit RGB and no modifier (so shared memory, never
    DMA-BUF), takes one frame, and composes the monitors at their logical
    positions, cropped to the frame. Input is the portal's `Notify*` calls in
    each stream's logical space. A key goes as a keysym, which the compositor
    turns into a key press on the layout in use, so text needs no keymap here;
    libei through `ConnectToEIS` would hand over keycodes and leave the
    layout to the helper, which would need libxkbcommon. Text first goes in
    through AT-SPI `EditableText`, read back. Paste uses `wl-copy` and
    `wl-paste` when wl-clipboard is installed (only the focused client may set
    the clipboard; it borrows focus for the moment), and otherwise types the
    text and says so. Keystrokes are refused unless the target's frame reads
    `Active`: no client may activate another's window on Wayland.
  - *Compositors.* GNOME (Mutter) and KDE (KWin) implement RemoteDesktop and
    ScreenCast; restore tokens need a portal that reports RemoteDesktop
    version 2, and older ones show the dialog for each new session. wlroots
    compositors (sway, Hyprland, river) share the screen through their
    portal but offer no remote control. Hit tests are X11 only; on Wayland the
    picture, which shows what is on top, is the check.
  - *Blocked apps.* The app id is the executable's name from /proc (the
    script's for an interpreter, so GNOME Secrets reads `secrets`); KeePassXC,
    Bitwarden, 1Password, Seahorse, Secrets, KWalletManager and the rest are
    refused like their macOS and Windows twins.

## Connectors (`services/agent/src/connectors/`)

An MCP server the user adds once, offered to every brain in both modes.

- **Store** (`packages/db/src/connectors.ts`, `<home>/mcp.json` plus
  `<home>/secrets/connectors.json`; the format is `packages/shared/src/home/mcp.mjs`).
  `mcp.json` is the standard `{"mcpServers": {...}}` shape, one server per key,
  the key being its name: a stdio (command, args, env, cwd) or http (type, url,
  headers) transport, and under `"openlive"` what only OpenLive uses: `id`, a
  stable `slug`, `enabled`, `disabledTools`, its `source` (added by hand or
  imported from which tool), `createdAt`, `spawnConsent`, an optional CIMD
  `clientMetadataUrl`, and the tool list last seen (with the server's `ttlMs`).
  Env values marked secret and every header value are written as
  `${secret:NAME}` references; their `encryptSecret` ciphertext (the same
  AES-256-GCM as provider keys), and OAuth tokens and client credentials, filed
  per issuer, are in the secrets file by connector id. The wire types are in
  `packages/shared/src/connectors.ts` and carry secret names, never values.
- **Edited by hand** (see [Where OpenLive keeps things](#where-openlive-keeps-things-packagessharedsrchome)).
  Every read is fresh, so an edit counts at once; the agent watches the file and
  closes a live connection whose server changed under it (`reconcile`), to reopen
  as written. A server written without an `"openlive"` block gets an id from its
  key and must be allowed to run before it starts; `spawnConsent` is a hash of the
  command and arguments agreed to, so changing either by hand asks again. A plain
  header value written by hand works at once and moves into the secrets file on
  the next write. A server that cannot be used is named on the Connectors screen,
  left out, and written back untouched; a file that is not JSON is never written
  over (`McpFileError`, a 409) until it is fixed.
- **Connections** (`manager.ts`). One client per connector, shared by every
  session, so a stdio server runs once. A connection opens on first use, reopens
  with backoff after it drops (1 s doubling to 60 s, six tries), and every child
  ends at shutdown. Status: `disabled`, `needs_consent`, `disconnected`,
  `connecting`, `connected`, `needs_auth`, `error`. HTTP negotiates the
  2026-07-28 era and falls back to the 2025 handshake, then to SSE; stdio uses
  the 2025 handshake, since the 2026 probe on stdio starts a second copy of the
  server.
- **Spawning** (`spawn.ts`). The SDK spawns through cross-spawn, which is what
  runs Windows `.cmd` shims (`npx`, `uvx`) without a shell. The PATH handed to it
  is `widenedPath()`, the login shell's, as the coding agents get. A stdio server
  never runs until the user consents (`POST /connectors/:id/consent`); a new
  command or new arguments ask again.
- **OAuth** (`oauth.ts`). Authorization code with PKCE; the redirect is
  `http://127.0.0.1:<agent port>/connectors/oauth/callback`, the one agent route
  exempt from the shared secret, guarded by its single-use state. The UI gets the
  authorization URL back and opens it. CIMD when a `clientMetadataUrl` is set and
  the server supports it, dynamic registration otherwise (and again when the
  agent's port moved). The SDK checks `iss` on the callback (RFC 9207) and
  refreshes tokens itself.
- **Tools** (`tools.ts`), registered in `server.ts`. Each enabled tool becomes
  `<slug>__<tool>`, cut to provider limits (64 chars, `[a-zA-Z0-9_-]`), with a
  hash of the original pair ending a name that is too long or taken. The JSON
  Schema passes through; `readOnlyHint` maps to `readOnly`, and every other tool
  has `confirm`, so a call asks each time and Flow's consent covers it. Results
  keep text and images (at most 4, each under 5 MB) and spell out resource
  links; text is capped at 20,000 characters. A coding agent reaches connectors
  only through the `openlive` MCP server: tokens never leave OpenLive.
- **On demand** (`capabilities/on-demand.ts`). With many connector tools on,
  `registry.tools` holds them back and offers three fixed tools in their place:
  `find_tools(query, limit?)`, read-only, whose description carries the catalog
  (each tool's first sentence under its connector, or past about 2k tokens its
  names only) and which returns matches with their JSON Schemas, ranked by word
  matches in name and connector (3) over description and argument names (1),
  exact name first, ties by name, each naming the tool that runs it;
  `read_tool(name, arguments)`, read-only, which runs only a tool marked
  read-only and points anything else at `use_tool`; and `use_tool(name,
  arguments)`, which runs any. Dispatch unwraps both into the real tool's call,
  so validation, repair, approval (asked in the real tool's words), the input
  lock and telemetry are the real tool's. Two runners because Codex asks before
  any MCP tool not marked `readOnlyHint`, and one wrapper for everything could
  never carry the mark. The events a call shows and records (Flow's orb and
  session file, a coding agent's MCP calls) name the real tool too, as Chat's
  chips do; the model's own transcript keeps the call it made. Both reach only
  what that session's set held back. The mode is
  `connectorToolLoading` in settings.json, `auto | on | off`, default `auto`:
  on past 40 connector tools or about 8k tokens of their schemas (Flow's own 38
  tools are about 5.2k). It is decided when a session's `ToolSet` is built and
  never changes under it, so the tools array heading the prompt cache stays
  byte-identical. Every brain gets the same three tools, the `openlive` MCP server
  included, Claude Code too: its own MCP tool search is off on a proxy host and
  on some models, and our tools work everywhere. Native tool search
  (Anthropic `defer_loading`, OpenAI `tool_search`) is not used: it needs
  provider blocks the adapters and session files do not carry, and Chat
  Completions and local models have none. Skills are not held back:
  `activate_skill` already loads them on demand. `/capabilities` reports
  `onDemand` and `POST /capabilities/on-demand` sets the mode, from a Segmented
  control on the Tools subtab.
- **Setup tools** (`setup.ts`), built-ins in the Connectors group, for the
  `connector-setup` skill: `list_connectors` (read-only: id, where it runs,
  status, tool counts), `add_connector(url | json, name?, headers?)`, which asks
  first and goes through the same `addConnectors` as `POST /connectors`,
  `connector_sign_in(id)`, which starts the same OAuth flow and opens the page
  through the device or the client's `open_url` (it does not ask: it only opens
  the server's own page, and finishing there is the consent), and
  `reconnect_connector(id)`. None can consent to a stdio server: the add result
  says so, and only `POST /connectors/:id/consent` sets it. Results never carry a
  secret: no header or env value, no arguments, no URL query, and any secret
  value a server echoes into an error is blanked.
- **Elicitation.** A question the server asks mid-call goes to the newest call
  running on that connector. In a call, URL and form modes reuse the ACP
  elicitation card; elsewhere a URL opens in the browser and a form is declined.
- **Import** (`import.ts`). Claude Desktop, Claude Code (user scope), Codex,
  Cursor, Gemini CLI and VS Code, at each tool's path for the OS. Preview marks
  duplicates of existing connectors; commit reads the files again and imports
  only definitions, never a sign-in. Imported stdio servers wait for consent.
- **API** (`routes.ts`, proxied by the web app at `/api/connectors`): list, add
  (URL or pasted `mcpServers` JSON), update, remove, toggle a connector or a
  tool, consent, reconnect, OAuth start/sign out and the callback, import
  preview and commit.
- **Settings** (`apps/web/src/components/settings/ConnectorsSettings.tsx`, the
  Connectors subtab of Capabilities, pure logic in `lib/connectors.ts`). Exa web
  search is pinned on top as a built-in row whose switch is the Web research
  group's. The agent pushes nothing, so the page refetches
  on focus, every 2 s while a connector is connecting, and on a backoff (2 s, then
  5 s, then 10 s, for at most five minutes) while a sign-in is open in the
  browser. Secret values are write-only: an edit shows a saved one as set and
  sends only what was typed.

Project `.mcp.json` passthrough for coding agents (`agents/mcp-config.ts`) is a
separate path and unchanged. Exa web search (`exa.ts`) stays a built-in client
rather than a connector: `web_search` is a fixed tool the research worker relies
on, and a connector would add a second search tool the user could remove.

## Skills (`services/agent/src/skills/`)

[Agent Skills](https://agentskills.io/specification) the user keeps once,
offered to every brain in both modes: a folder with a `SKILL.md` (YAML
frontmatter `name` and `description`, optional `license`, `compatibility`,
`metadata`, `allowed-tools`) and optional `scripts/`, `references/`, `assets/`.

- **Built in** (`services/agent/skills/<name>/SKILL.md`): `computer-use`,
  `research`, `skill-creator` and `connector-setup`, read in place and never
  copied into the user's folder. `bundledSkillsDir()` (`catalog.ts`) finds them
  at `services/agent/skills` in dev and at `skills/` beside `agent.mjs` in the
  bundled agent; `pack-agent.cjs` copies them to `dist/agent/skills`, which
  electron-builder's `dist/agent` extraResource carries to
  `resources/agent/skills`, and `smoke-servers.cjs` checks they arrived.
  `OPENLIVE_BUNDLED_SKILLS_DIR` moves them, for tests. They switch off by name
  like any skill, and cannot be edited or removed: `PUT` and `DELETE` answer 403
  saying so. `computer-use` holds the how-to that was `get_app_state`'s prompt
  guidance; the tool keeps only the safety line and a pointer to the skill.
- **Precedence.** Workspace over user over built in. A skill of yours (or the
  project's) with a built-in skill's name replaces it, without a warning; the
  built-in one is listed with `replacedBy` and never offered, and removing yours
  brings it back. `GET /skills/skill/:name?source=bundled` reads the built-in one
  either way.
- **Where** (`packages/db/src/paths.ts`, `skillsDir()`). `<home>/skills`, so
  `~/.openlive/skills` beside `~/.claude/skills` and `~/.agents/skills` for the
  installed app, and `<repo>/data/skills` in a dev checkout: skills are files a
  person opens, edits and shares. `OPENLIVE_SKILLS_DIR` moves it. Which skills are
  switched off is the only state OpenLive keeps, by name, in `<home>/state/skills.json`.
- **Workspace skills.** A call with a bound folder also reads
  `<folder>/.claude/skills` and `<folder>/.agents/skills`, in place and never
  copied. The folder is one the user picked, so it is trusted as they are; a
  cloned repository's skills therefore reach the model once that folder is
  bound. A workspace skill overrides the user's skill of the same name, and
  `.agents/skills` overrides `.claude/skills`; the winner carries a warning
  naming the one it shadows. Flow has no workspace, so it sees the user's.
- **Parse and scan** (`parse.ts`, `catalog.ts`). `yaml` for the frontmatter,
  retried with colon-bearing values quoted (`description: Use when: ...` is
  invalid YAML other clients accept). A missing or empty description, a name
  outside `[a-z0-9-]`, or unreadable YAML skips the skill and lists it as a
  problem; a name that does not match its folder, one over 64 characters or a
  description over 1024 (cut to 1024 for the model) loads with a warning.
  Creating or editing a skill in OpenLive holds the strict rule: the name is the
  folder's. A scan stats each `SKILL.md` and parses only the ones whose mtime or
  size changed: O(skill folders) stats per session start, plus a parse per
  changed file. `POST /skills/rescan` clears the cache.
- **Tools** (`tools.ts`), registered in `server.ts`, so an API brain gets them
  natively and a coding agent over the `openlive` MCP server; nothing is written
  into an agent's own folders. With no skill enabled neither tool is offered.
  `activate_skill(name)` carries the catalog (name and description, about 100
  tokens a skill) in its description and its `name` is an enum of the enabled
  skills, so the system prompt gains nothing: the description already says when
  to call it, and it reaches both kinds of brain the same way. It returns the
  body in `<skill_content name="...">` with the skill's absolute folder and its
  files listed, never read (at most 200, four levels deep), and is read again
  from disk so an edit since the session began is what loads. A second load in
  the same session is a one-line note. `read_skill_file(name, path)` reads one
  file, fenced to the skill's folder by `confine` (lexical and realpath, so a
  symlink out is refused), up to 2 MB read and 100,000 characters returned.
  Both are read-only. A script runs through the brain's own shell tool (the
  device `shell` for the built-in brain in the desktop app, the agent's own
  for a coding agent), so it follows that tool's approval; the content names
  the folder to run it from.
- **`save_skill(name, description, body, replace_built_in?)`**, a built-in in
  the Skills group (registered with the other built-ins, so it is offered with
  no skill enabled), for the `skill-creator` skill. It checks the name rule and
  the description before anyone is asked (`precheck`), asks first (`confirm`),
  and writes through the same `createSkill` as `POST /skills`. A built-in
  skill's name is refused unless `replace_built_in` is set, which the skill
  allows only when the user asked for their own version.
- **Sessions.** A session's tool set is built from a scan at its start: each
  call, a call's folder change (which rebuilds the call's tools, the MCP server
  reading them per request), and each new or resumed Flow session. A rebuilt
  set has nothing loaded yet, as the transcript it pairs with.
- **Compaction.** Flow's `compact` and Chat's history cap carry every
  `<skill_content>` block from what they drop into the note they leave
  (`content.ts`, `carriedSkills`), once per skill, so a long run keeps the
  instructions it is following.
- **Typed `/name`.** In a call's text box, a message starting with `/name`
  loads that skill before the turn, and the rest of the message is the turn.
  The bound coding agent's own slash commands come first: a name the agent
  advertises goes to the agent untouched. The text box's `/` menu lists the
  enabled skills after the agent's commands, marked as skills, and leaves out
  a skill named like one of them. Spoken words never trigger it, and Flow,
  which has no text box, does not.
- **Import** (`import.ts`). Claude Code (`$CLAUDE_CONFIG_DIR` or `~/.claude`,
  then `skills`), `~/.agents/skills`, Codex (`$CODEX_HOME` or `~/.codex`, then
  `skills`) and Gemini CLI (`~/.gemini/skills`), the same relative path on every
  OS under `os.homedir()`. Preview marks a name OpenLive already has (a
  built-in one included, since importing it would replace that), or an earlier
  source offers. Commit finds each folder on disk again and copies it
  (symlinks as their targets, without `.git` or `node_modules`) into a hidden
  staging folder renamed into place, under the skill's name.
- **API** (`routes.ts`, proxied by the web app at `/api/skills`): list (with
  problems and warnings; `?workspace=` adds a folder's skills), get one with its
  `SKILL.md`, create, replace `SKILL.md`, enable or disable, delete (the folder;
  a linked folder loses only the link), rescan, reveal (the desktop opens the
  folder; `main.cjs` allows it), import preview and commit. One skill's routes
  sit under `/skills/skill/:name`, since a skill may be named `import`.
- **Settings** (`apps/web/src/components/settings/SkillsSettings.tsx`, the Skills
  subtab of Capabilities, pure logic in `lib/skills.ts`). Built-in skills
  (`source: "bundled"`) and the current call's folder's skills are read-only;
  only your own folder's skills edit or remove. A replaced built-in skill shows
  "Replaced by yours" and no switch.

## Memory (`services/agent/src/memory/`)

The notes the `remember` tool keeps, shared by Chat and Flow and by API and coding
agents, since every brain's prompt reads them through one function
(`rememberedNotes` in `prompt.ts`, which the Chat and Flow prompts and the ACP
preambles all call).

- **Shape.** One JSON array in `<home>/memory.json`, oldest first, of
  `{ id, text, at }` (it was the `agent_notes` setting before the home; the move
  carries it over). The array used to hold bare strings; both shapes read
  (`parseNotes`), a string's id is a hash of its text so it holds still until the
  next write, and every write stores the current shape. Nothing is dropped on the
  way. Writes go through `updateMemory`, one cross-process lock for the whole
  read-modify-write, so a note the agent saves and one edited in Settings never
  undo each other.
- **Saving.** A note is tidied to one line of at most 240 characters. One that
  matches another in case or spacing is skipped, and at 300 notes `remember` says
  memory is full instead of dropping the oldest.
- **Budget** (`budgeted`). The prompt gets the newest notes that fit 2,000
  characters, each costing its text plus 3 for the `- ` and line break, and the
  first note that does not fit ends the run, so an older small note never slips
  past a newer big one. The live prompt is about 3,700 characters before its tool
  lines, so the notes add at most half again; the old worst case was 12,000. Notes
  past the budget stay stored and are marked not in use. The limits live in
  `packages/shared/src/memory.ts`.
- **API** (`routes.ts`, proxied at `/api/memory`): list, add, edit and delete one
  (`/memory/note/:id`), clear all. Each answers with the whole list, newest first
  with its `inUse` flags and the budget used, since one change moves the cutoff.
- **Settings** (`MemorySettings.tsx`, pure logic in `lib/memory.ts`): a budget
  bar with a segment per note, add, inline edit, delete and clear all, a filter,
  and the cards drawn 50 at a time.

## Timers and reminders (`services/agent/src/reminders/`)

Built-ins in the Reminders group, so every brain reaches them through the
registry and the `openlive` MCP server: `set_timer(duration, label?)`,
`remind(text, at? | in?, repeat?)`, `list_reminders(include_done?)` (read-only)
and `cancel_reminder(id | text_match)`. None asks first: each only schedules a
note to the user, says the time back for them to hear, and a cancel undoes it.

- **Times** (`time.ts`, Intl alone). A duration is ISO 8601, seconds, or `1h30m`.
  `at` without an offset is the user's local time; with one, as given; a bare
  `18:00` is its next occurrence. A time past is refused with the time now.
  Results say the time in words ("6:00 PM today (PDT)") for the reply to confirm.
  Each item keeps the IANA zone it was set in, and a repeat (daily, weekdays,
  weekly) comes round at the same wall-clock time there, so DST never moves it.
- **The time in the prompt.** The Chat prompt carries only the date. A session
  whose tools can schedule gets "It is now 3:04 PM on Thursday, ... (zone)" in the
  request's transient tail, Chat's and Flow's, after the cached prefix, so the
  system prompt stays byte-identical. A coding agent keeps its own history, so
  `AcpAgent.runTurn` opens each spoken turn's text with the same line when
  OpenLive's tools reach it and Reminders is on. A slash command gets none, so
  it stays first and is still read as a command.
- **Scheduler** (`scheduler.ts`). Items live in `state/reminders.json` under the
  store's lock: every pending one and the newest 50 finished. At most 500 are
  pending. One timer points at the soonest, recomputed on each add, cancel and
  fire, an O(n) scan at that size. It never waits past 30 seconds before
  reading the wall clock again: a Node timer stops while the machine sleeps and
  never sees the clock jump, and this catches both on every OS, without
  Electron, and keeps every delay under `setTimeout`'s 2^31-1 ms ceiling. On
  start it re-arms what was pending; an item that fires more than a minute late
  (OpenLive was closed, or asleep) says "Missed" and when it was due, and a
  one-off is marked `missed`.
- **Firing** (`fire.ts`). The agent posts `{ openlive: "notify" }` to Electron
  main over its parent port, the channel the computer-use helper uses, and main
  shows a native Notification titled Reminder or Timer that opens OpenLive when
  clicked. Every open call and Flow socket also gets a `reminder` message: a
  call shows a toast and says it, and Flow says it while the orb is open and
  speaking, both through `VoiceEngine.announce`, which waits for the reply under way to end and for the
  user to stop talking. With neither (web-only dev, nothing open) it is logged.
- **API** (`routes.ts`, proxied at `/api/reminders`): `GET /reminders` lists
  what is pending, `DELETE /reminders/:id` cancels one. The Reminders card on
  the Tools subtab shows the next few, each with Cancel.

## Find and undo (`services/agent/src/capabilities/find.ts`, `checkpoints.ts`)

Built-ins in the Find and undo group, for every brain through the registry and
the `openlive` MCP server.

- **`find_files(query, kind?, modified_within?, limit?)`** (read-only) finds
  files and folders under the user's home by name or content, newest first, with
  kind, size and modified time: 20 by default, 100 at most, within 3 seconds
  (past that it returns what it has and says so). It never reads a file;
  `read_file` stays fenced to the workspace, and the model asks the user to pick
  a found file's folder or open it. Backends, each spawned without a shell, the
  user's words one argument or an environment variable, tried in order until one
  answers (a missing command, or a non-zero exit with stderr, moves on):
  - macOS: `mdfind -0 -onlyin ~ '(kMDItemFSName == "*q*"cd || kMDItemTextContent == "q"cdw)'`, plus
    `&& kMDItemFSContentChangeDate >= $time.now(-N)`, with `\ " * ?` escaped.
  - Windows: Windows Search's SystemIndex through `ADODB.Connection` and
    `Search.CollatorDSO`, from a fixed script run as `powershell.exe -NoProfile
    -NonInteractive -EncodedCommand`; the words come in `OL_FIND_Q` and are
    escaped for the SQL literal, LIKE and CONTAINS. Then Everything's
    `es.exe -n 500 -path ~ -search "[dm:>=date ]q"`.
  - Linux: `plocate -i -e -b -0 -- q`, `locate` the same, then `fd` or `fdfind
    -i -F -a -0 --max-results 500 [--changed-within Ns] -- q ~`.
  - Everywhere last: a breadth-first walk of the home, names only, depth 8,
    200,000 entries, skipping hidden folders, `node_modules`, `Library`,
    `AppData` and caches.
  Every path passes a deny list first: anything outside the home, a `.ssh`,
  `.gnupg`, `.aws`, `.kube`, `.password-store`, `Keychains` or `secrets` folder
  at any depth (so `~/.openlive/secrets`), browser profiles and OS credential
  stores on each OS, and `.env*`, `id_rsa`-style keys, `*.pem`, `*.key`, `*.p12`,
  `.netrc`, `.npmrc` and the like.
- **Checkpoints.** `write_file` and `edit_file` write only through
  `checkpointed()`, which first keeps the file as it was (or that it did not
  exist) in `cache/checkpoints/<workspace hash>/`: `blobs/<sha256>` once per
  content, and `journal.json` (written atomically) with each edit's path, time,
  before and after hashes and lines added and removed. One edit at a time per
  workspace. Kept: the newest 200 edits, 200 MB of pre-images and 14 days,
  pruned on each edit and each Settings listing, with unreferenced blobs
  deleted. Paths compare without case on Windows and macOS, and with either
  slash on Windows. Only OpenLive's own file tools are covered, not a coding
  agent's own edits or shell commands.
- **`list_edits(limit?)`** (read-only) and **`undo_edit(id? | path?, force?)`**,
  which asks first, naming the file and when. It restores the pre-image, or
  deletes a file the edit created, and refuses when the file changed after that
  edit unless `force`. An undo is itself an edit, so undoing it redoes.
- **API** (`edit-routes.ts`, proxied at `/api/edits`): `GET /edits` lists the
  newest edits across workspaces, `POST /edits/:id/undo` undoes one (409 with
  the reason when refused). The Find and undo card on the Tools subtab shows the
  last few, each with Undo.

## Flow (`services/agent/src/flow/`, `apps/desktop/flow-*.cjs`)

Flow is the voice assistant for the whole machine, summoned with a double tap of
`Control`. A hidden owner renderer (`/flow-owner`) runs the same voice loop and a
second `/live` connection (`live/flow-ws.ts`); an always-on-top orb window (`/flow`)
only draws what the owner publishes. On the server, `runFlow` loops turns and tool
calls on a `LocalBrain` (provider) or an `AcpBrain` (coding agent, which gets the
same tools over a local MCP server, and shows on the orb as it calls them and as it
uses its own tools, labelled by what they do: "Reading src/app.ts"). Device tools reach the `native/ol-input` Rust
addon through the owner renderer and `flow-runtime.cjs` in the main process. Config
and history live in `<home>/flow` via `packages/flow-store`.

Full user and developer guide: [FLOW.md](FLOW.md).

## Telemetry (`apps/desktop/telemetry/`, `packages/shared/src/telemetry-schema.ts`)

Anonymous usage telemetry, opt-out, with one sender in Electron main. What it may
send is listed for users in [TELEMETRY.md](TELEMETRY.md).

```
 agent service ── P1: parentPort ──┐
                                   ▼
 main window, Flow owner ── P2: IPC ──▶ main: validate ─▶ consent + notice gate ─▶ disk queue ─▶ paced sender
```

- **One sender.** The pages and the agent never talk to the analytics server. They
  hand plain values to main, which checks each one against the schema and sends.
- **P1, agent to main.** The agent posts `{ openlive: "telemetry", ... }` with
  `process.parentPort` (a no-op in dev). Main takes it only from the agent child.
- **P2, renderer to main.** `window.openlive.telemetry` in `preload.cjs`, admitted
  from the main window and Flow's owner window, not the orb.
- **The schema is the single source.** `telemetry-schema.ts` holds every event,
  property, closed value list and cap. Main is plain CJS and cannot import it, so
  `node apps/desktop/scripts/gen-telemetry-schema.cjs` writes
  `apps/desktop/telemetry/schema.json`, and a test fails when the two differ. The
  web wrapper (`apps/web/src/lib/telemetry.ts`) and the agent emitter
  (`services/agent/src/telemetry`) are typed by it.
- **Summaries are folded in main.** `flow_session` and `call_session` collect small
  facts from the renderer, the agent and main (`aggregator.cjs`) and go out once,
  when the session closes.
- **Feedback prompts are asked by main.** `feedback.cjs` holds every cap (from
  `schema.feedback`) and the prompt memory in `telemetry.json`; the main window asks
  `feedbackNext()` and reports what the person did, and main adds the kind, surface and
  context itself. Nothing is offered while sharing is off or the notice is owed.
- **Off in dev.** It needs a packaged app and a stamped
  `apps/desktop/telemetry-config.json`, which `pack:telemetry` writes from the
  release environment ([RELEASING.md](../RELEASING.md)). No file, no telemetry.
- **Where the rest lives.** `telemetry-map.cjs` maps Electron and OS values onto the
  schema's closed lists, and `packages/shared/src/error-class.ts` maps a failure
  to its closed class.
- **The public list.** `docs/TELEMETRY.md`, kept in step by
  `packages/shared/src/telemetry-docs.test.ts`.

## Where OpenLive keeps things (`packages/shared/src/home/`)

One folder holds everything OpenLive owns, as `~/.claude` and `~/.codex` do:
`~/.openlive` on macOS and Linux (not the XDG folders, to match those tools) and
`%USERPROFILE%\.openlive` on Windows. Chromium's own files stay in Electron's
userData.

```
~/.openlive/
  settings.json      preferences and per-chat state, plain, no secrets
  mcp.json           connectors, {"mcpServers": {...}}, edited by hand too
  memory.json        what `remember` keeps: [{ id, text, at }]
  skills/            your Agent Skills, one folder each
  secrets/           0700, every file 0600, never plain text
    .enc-key         the AES-256-GCM key (unless OPENLIVE_ENC_KEY is set)
    providers.json   provider API keys, encrypted
    connectors.json  connector env/header secrets and OAuth credentials, encrypted
    settings.json    secret settings (exa_api_key, voiceprint), encrypted
    backup/          settings.json and connectors.json as they were before the move
  data/              openlive.db (+ -wal, -shm), voice-profiles.json, voice-accel.json,
                     models/, voices/, addressee-log.jsonl, addressee-head.json
  flow/              Flow's config.json, sessions/, assets/, lease.json
  state/             skills.json (switched-off skills), reminders.json, window-state.json, appearance.json,
                     preferences.json, once.json, server-pids.json, telemetry.json,
                     telemetry-queue.jsonl, telemetry-off, portal-token (Linux),
                     migration.json (the move's record)
  logs/              agent.log, rotated at 5 MB, two old files kept
  cache/             debug/ (TTS capture), scratch/, checkpoints/ (file edits' pre-images, for undo)
```

- **Which folder.** `OPENLIVE_HOME` names it; `OPENLIVE_DATA_DIR`, the old name,
  still works when `OPENLIVE_HOME` is not set. Otherwise the installed app uses
  `~/.openlive` and a dev checkout `<repo>/data`, with the same layout inside, so a
  worktree never touches the real home or another worktree's. Only Electron main
  knows it is packaged: it passes `OPENLIVE_HOME` to the servers it starts.
  `OPENLIVE_SKILLS_DIR` and `OPENLIVE_FLOW_HOME` (the folder that holds `flow/`)
  still move their one folder.
- **One paths module.** `index.mjs` is plain ESM on Node builtins, so the same file
  serves every process: the db, flow-store, agent and web packages import
  `@openlive/shared/home`, Electron main loads it from the packaged resources
  (`electron-builder.yml`, `extraResources`), and the Rust helper is handed its one
  path in `OPENLIVE_CU_PORTAL_TOKEN`. The agent copies everything it writes to
  stderr into `logs/agent.log` (`teeStderr` in `services/agent/src/log.ts`).
- **Secrets.** Settings named in `SECRET_SETTINGS` read and write through
  `getSetting`/`setSetting` as before but live encrypted in `secrets/settings.json`.
  A store whose file was broken by hand is never written over: the write fails and
  says which file to fix.
- **mcp.json**, as written:

  ```json
  {
    "mcpServers": {
      "GitHub": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "LOG_LEVEL": "info", "GITHUB_TOKEN": "${secret:GITHUB_TOKEN}" },
        "openlive": { "id": "0c5e…", "slug": "github", "enabled": true, "disabledTools": [],
                      "source": "manual", "createdAt": "2026-10-01T09:00:00.000Z", "spawnConsent": "9f2c41d0a7b3e815" }
      },
      "Linear": {
        "type": "http",
        "url": "https://mcp.linear.app/mcp",
        "headers": { "Authorization": "${secret:Authorization}" },
        "openlive": { "id": "4b1d…", "slug": "linear", "enabled": true, "disabledTools": [], "source": "claude-code", "createdAt": "…" }
      }
    }
  }
  ```

  Other tools ignore `"openlive"`; fields OpenLive does not own (another tool's
  `timeout`, a `$schema`) are kept on every write. See [Connectors](#connectors-servicesagentsrcconnectors).
- **The move** (`migrateHome`). Once, at the first start of a build with the home:
  Electron main moves the installed app's `<userData>/data` and its own files in
  userData into `~/.openlive` before it starts the servers; a dev checkout's servers
  reshape `<repo>/data` in place (as does any other `OPENLIVE_HOME` or
  `OPENLIVE_DATA_DIR`, never `~/.openlive` itself, whose top an old build left a
  stray `openlive.db` in). `agent_notes` leaves settings.json for memory.json,
  secret settings are encrypted into `secrets/`, and connectors.json becomes
  mcp.json plus the secrets file (its ciphertext moves as is, under the same key).
  Every step is a rename, or a copy verified byte for byte before its source goes;
  settings.json and connectors.json are copied to `secrets/backup/` before they are
  rewritten; a folder lock keeps two processes from moving at once; and
  `state/migration.json`, written last, records each move and ends it. A start that
  stops part way leaves every file in its old place or its new one, never neither,
  and the next start finishes. The old folders keep a `MIGRATED.txt` saying where
  things went.

## Packages

```
packages/shared    agent registry + node helpers, /live wire protocol, shared types, speech text normalization
packages/harness   model adapters (Anthropic / OpenAI Responses / OpenAI Chat), model listing, effort
packages/db        JSON-file store: AES-256-GCM-encrypted keys, settings, conversations, connectors
```

`packages/db` is deliberately JSON files, not SQLite — no native modules, so
electron-builder packages the desktop app with no rebuild step.

## Quality gates

`pnpm typecheck` (all packages) and `pnpm test` (vitest, colocated `*.test.ts`) run
in CI on ubuntu + windows; the windows job also produces an unsigned installer to
prove cross-platform builds stay green.
