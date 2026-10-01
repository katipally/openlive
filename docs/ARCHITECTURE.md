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
  mid-session (`set_model` / `set_mode` / `set_option`).
- **Supervision.** Every agent runs inside `AgentSupervisor`: per-turn watchdogs
  (start / first-output / stall), restart-once-then-fail, and every failure ends as
  a *spoken* one-liner + structured error — never a session stuck listening.
- **Cleanup.** Adapters spawn in their own process group so dispose kills the whole
  `npx → node → binary` tree.

History also surfaces each agent's **own** on-disk sessions
(`apps/web/src/app/api/history/agentSessions.ts` — Claude JSONL, Codex rollouts,
Cursor meta, OpenCode/Hermes read-only sqlite), deduped against OpenLive's chats,
so everything you did in the CLI shows up too.

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
`data/models/supertonic-3` file by file from the Hugging Face revision the
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
sherpa-onnx models that the agent service downloads into `data/models/<id>` from
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
exiting; an engine whose benchmark took the agent down twice anyway stays on CPU. Results live in `data/voice-accel.json`,
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
agent, in `DATA_DIR/addressee-log.jsonl`, for `pnpm addressee:train`: its words
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
`DATA_DIR/addressee-head.json`, never the shipped head. The agent judges with it
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
`data/models/zipvoice`, profiles are a wav + transcript under `data/voices`, and
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

## Tools (`services/agent/src/capabilities/`)

Chat and Flow keep their own loops (`LiveTurnRunner`, `runFlow`) but draw on one
tool registry, and both run every call through one `dispatch` (repair, validate,
approve, run, tally).

- **One `Tool` type** (`types.ts`): name, description, JSON Schema, optional
  prompt guidelines, `readOnly` (sent over MCP as `readOnlyHint`), `confirm`
  (it changes something, and this is the question to ask first), and
  `available(session)`, which reads what the session can reach: the app in front
  and insertion (Flow), the clipboard, the device addon, a live share (`look`, a
  call), a workspace (the file tools, a call).
- **The registry** (`registry.ts`). `registry.tools(profile, session)` returns a
  `ToolSet`, ordered for the mode and looked up by name in O(1). Sources of tools
  are `ToolProvider`s; the built-ins are one, and a provider registered later
  never shadows a name already taken.
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
  pointing) stay distinct.
- **MCP** (`mcp.ts`). One server, named `openlive`, serves a session's `ToolSet`
  to a coding agent on a random loopback path, through the same dispatch and
  approval. It is stateless (MCP SDK v2 `createMcpHandler`): each request gets
  a fresh low-level `Server` over the same tools, so a 2025-era agent and a
  2026-07-28 client both connect, and no agent's session can end another's.
  The low-level `Server` rather than `McpServer`, because `McpServer` validates
  names and arguments before a handler runs and would refuse the calls dispatch
  repairs.

## Connectors (`services/agent/src/connectors/`)

An MCP server the user adds once, offered to every brain in both modes.

- **Store** (`packages/db/src/connectors.ts`, `data/connectors.json`). Each
  connector: name, a stable `slug`, a stdio (command, args, env, cwd) or http
  (url, headers) transport, `enabled`, `disabledTools`, its `source` (added by
  hand or imported from which tool), `spawnConsent`, an optional CIMD
  `clientMetadataUrl`, and the tool list last seen (with the server's `ttlMs`).
  Env values marked secret, every header value, OAuth tokens and OAuth client
  credentials are `encryptSecret` ciphertext, the same AES-256-GCM as provider
  keys; OAuth credentials are filed per issuer. The wire types are in
  `packages/shared/src/connectors.ts` and carry secret names, never values.
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
- **Settings** (`apps/web/src/components/settings/ConnectorsSettings.tsx`, pure
  logic in `lib/connectors.ts`). The agent pushes nothing, so the page refetches
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

- **Where** (`packages/db/src/paths.ts`, `skillsDir()`). `~/.openlive/skills`,
  beside `~/.claude/skills` and `~/.agents/skills`, rather than under
  `DATA_DIR`: that is the app's private store, hidden in packaged builds and
  split between dev and packaged, and skills are files a person opens, edits and
  shares. `OPENLIVE_SKILLS_DIR` moves it (tests). Which skills are switched off
  is the only state OpenLive keeps, by name, in `data/skills.json`.
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
  advertises goes to the agent untouched. Spoken words never trigger it, and
  Flow, which has no text box, does not.
- **Import** (`import.ts`). Claude Code (`$CLAUDE_CONFIG_DIR` or `~/.claude`,
  then `skills`), `~/.agents/skills`, Codex (`$CODEX_HOME` or `~/.codex`, then
  `skills`) and Gemini CLI (`~/.gemini/skills`), the same relative path on every
  OS under `os.homedir()`. Preview marks a name OpenLive already has, or an
  earlier source offers. Commit finds each folder on disk again and copies it
  (symlinks as their targets, without `.git` or `node_modules`) into a hidden
  staging folder renamed into place, under the skill's name.
- **API** (`routes.ts`, proxied by the web app at `/api/skills`): list (with
  problems and warnings; `?workspace=` adds a folder's skills), get one with its
  `SKILL.md`, create, replace `SKILL.md`, enable or disable, delete (the folder;
  a linked folder loses only the link), rescan, reveal (the desktop opens the
  folder; `main.cjs` allows it), import preview and commit. One skill's routes
  sit under `/skills/skill/:name`, since a skill may be named `import`.
- **Settings** (`apps/web/src/components/settings/SkillsSettings.tsx`, pure
  logic in `lib/skills.ts`). The list includes the current call's folder's
  skills, read-only.

## Flow (`services/agent/src/flow/`, `apps/desktop/flow-*.cjs`)

Flow is the voice assistant for the whole machine, summoned with a double tap of
`Control`. A hidden owner renderer (`/flow-owner`) runs the same voice loop and a
second `/live` connection (`live/flow-ws.ts`); an always-on-top orb window (`/flow`)
only draws what the owner publishes. On the server, `runFlow` loops turns and tool
calls on a `LocalBrain` (provider) or an `AcpBrain` (coding agent, which gets the
same tools over a local MCP server, and shows on the orb as it calls them and as it
uses its own tools, labelled by what they do: "Reading src/app.ts"). Device tools reach the `native/ol-input` Rust
addon through the owner renderer and `flow-runtime.cjs` in the main process. Config
and history live in `~/.openlive/flow` via `packages/flow-store`.

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
