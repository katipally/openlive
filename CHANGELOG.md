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
- **Flow's "Let me talk over it" switch.** Speaking always stops Flow now.
  Saved settings that still carry it load as before.

### Changed
- **Released builds no longer let a page open Flow.** The page trigger that
  opens Flow as a double Ctrl would is registered only in dev builds, where
  tests use it, so no script in the app window can turn the mic on.
- **A cough or a "mm-hmm" no longer cuts the voice off.** In a call and in Flow,
  a sound over a reply pauses it at once, and it goes on from the same word
  when the sound was a cough, a laugh, a bump or a backchannel ("yeah", "okay",
  "right", "uh-huh", and their equivalents in every session language). Any
  other word, or talk that runs on, stops it as before. A cough while the
  agent is still working no longer cancels its work. A laugh of any length
  ("ha", "hahaha", "jajaja", "哈哈", "ㅋㅋㅋ") and a throat sound ("ugh",
  "ahem", "hmm") count as sounds too, in every session language. Only what you
  said in full decides, so a laugh half-heard as words no longer cuts it.
- **Answering an ask by voice is instant.** A spoken "yes" or "no" to a
  permission ask, in a call or in Flow, goes through the moment you stop
  instead of waiting out the pause for more. Once the question has been said,
  the orb shows it is waiting on you rather than still speaking, and Flow's
  question card has a Stop button.
- **A voice that is not downloaded says so.** When the picked speech or voice
  engine is not on this computer yet, its card in Settings → Voice reads "Not
  downloaded, using Kokoro" (or whatever stands in), and the call lobby offers
  the download next to Start. The fallback no longer logs an error.
- **Settings opens on General and goes back where you came from.** The close
  button is now "Back to Chat / Flow / OpenLive / call" at the top of the
  sidebar; Esc and Back still work.
- **API mode answers only from the provider you chose.** When the chosen provider
  had no key, Chat and Flow used to answer from another provider that had one,
  while Flow said it was not set up. Now every screen and every turn resolve the
  choice the same way: no key means not ready, with the fix in Settings.
- **Newer on-device voice runtimes.** Live voice now runs on ONNX Runtime Web
  1.30, Transformers.js 4.3 and voice activity detection 0.0.31, and voice
  cloning on sherpa-onnx 1.13.8. The files the voice detector loads now always
  match the runtime it was built against.
- **Voice detection runs Silero v6.2.** It makes fewer mistakes on noisy
  rooms, soft or unusual voices and phone-quality mics, at the same speed.
  Settings → Voice → VAD can switch back to v5.

### Added
- **Four more coding agents: Gemini CLI, GitHub Copilot, Kiro and Pi.** Install,
  sign in, pick them per conversation or for Flow, and talk, like the others.
  Copilot is in public preview; Pi runs through the `pi-acp` adapter and does not
  get OpenLive's tools (screen, connectors, skills), since the adapter has no way
  to pass them on. An agent that is not signed in now says so, with the command to
  run, instead of a protocol error.
- **Anonymous usage sharing, with one switch.** The desktop app shares which
  features get used, errors and speed, as numbers and fixed labels. Never what you
  say or type, your files, names, window titles, keys, model ids or error text. A
  card on first run says so, and nothing is sent before it has been shown. Turn it
  off in Settings → Privacy (which also shows the install ID and a random anonymous
  name made from it, and links the full event list), or start the app with `OPENLIVE_TELEMETRY=0` or
  `DO_NOT_TRACK=1`, which sends nothing at all. Turning it off in the app, in Settings
  or on the first-run card, sends one last anonymous event saying so (it asks for no
  named profile), then nothing, and the screen shows the install ID and name gone at
  once. If the choice cannot be saved to disk, a marker file keeps sharing off at the
  next launch. Development builds and builds from source send nothing. Every
  event and field is listed in [docs/TELEMETRY.md](docs/TELEMETRY.md), and a test
  keeps that list in step with the code.
- **A privacy policy.** [docs/PRIVACY.md](docs/PRIVACY.md) says in plain English what
  the anonymous usage data is, why it exists, where it is stored, what is never
  collected and how to turn it off. Settings → Privacy and the
  first-run card link to it.
- **Rare, quiet feedback prompts.** After a Flow session or a call with at least two
  answered turns, a small card in the main window asks "How was that?" with a thumbs
  up or down and, after a thumbs down, one row of fixed reasons to tap. Once the
  install has been used on seven days, it also asks how likely you are to recommend
  OpenLive, 0 to 10, at most every 90 days. Never in the first two days, at most one
  prompt a week, never two on one day, nothing for 30 days after two that were
  ignored, never during a session, never while sharing is off, and every card has a
  "Don't ask again" that sticks (Settings → Privacy → Ask for feedback changes it).
  Answers are fixed choices, never text, and every limit is listed in
  [docs/TELEMETRY.md](docs/TELEMETRY.md).
- **Request deletion.** Settings → Privacy → Your anonymous name has a Copy button, and
  **Request deletion** opens a draft email to privacy@openlive.dev with that name in it.
  Nothing is sent until you send the email. Turning sharing off deletes the name, so
  Settings and the privacy policy say to copy it first if you want past events
  deleted. The privacy policy now names the retention period (24 months, then
  deleted), the contact and your rights.
- **Report a problem.** Settings → Privacy opens a GitHub issue with your version,
  OS, provider and last Flow failure already filled in. Nothing is sent until you
  submit it.
- **A choice for the screen lock.** Locking the screen still closes Flow and ends a
  call by default. Settings → General → Screen lock has a switch to keep them going
  while the screen is locked (macOS and Windows). Sleep always ends them.
- **A coding agent in a call can look, use the clipboard, open links and
  remember.** It gets the call's own `look`, `clipboard_read`,
  `clipboard_write`, `open_url` and `remember` over a local MCP server: the same
  tools the built-in brain runs, shown the same way. Facts either brain
  remembered reach both. Looking, the clipboard and opening a link now show a
  chip with either brain. Claude Code calls OpenLive's tools, in a call and in
  Flow, without asking first; Codex skips the ask for the ones that only read,
  and when it does ask, the ask names the tool ("OpenLive's open url"). A
  resumed session shows those calls the way it did live, not as raw cards.
- **Flow shows a coding agent's own work.** When Claude Code reads, edits or
  runs something, the orb says so ("Reading src/app.ts"), and the session file
  keeps it next to Flow's own tools.
- **Listening sounds (experimental, opt-in, Settings → Voice → Turn-taking).** While you
  talk at length, a quiet "mm-hmm" or "yeah" (in the session language) in the
  reply's voice at a pause the agent is waiting through, with the built-in
  model or a coding agent. Never after a question, never over your voice, never
  in the transcript. Calls only, not Flow.
- **Replies read the way a person says them.** Every voice now reads numbers,
  ordinals, dates, times, prices, percentages, units, ranges, phone numbers,
  emails, web addresses, file names, version numbers, code names, initialisms
  and symbols as words in your session language: "$1,200.50" is "one thousand
  two hundred dollars and fifty cents", "2026-09-25" is "September
  twenty-fifth, twenty twenty-six", "v1.2.3" is "version one point two point
  three". The transcript still shows what the assistant wrote. English is
  covered in full; the other nine languages get numbers, decimals, ordinals,
  dates, times, money, percentages and units.
- **Captions keep time with the voice.** The live caption and the transcript
  now show each word as it is spoken, placed on the voice's own audio and its
  pauses, instead of at an even pace over the sentence. A spelled-out number
  or price takes as long on screen as it does to say, and Chinese and Japanese
  captions reveal character by character.
- **Your words keep their timing.** Each spoken turn, in a call and in Flow,
  is saved with when you said every word: Parakeet and Nemotron's own word
  times, or, from Whisper, Moonshine and Canary, times placed on your audio.
  Nothing on screen changes and no turn waits longer; they are there for
  telling speakers apart later.
- **Pronunciation dictionary.** Settings → Voice → Pronunciation lists names
  and words with how to say them ("Nginx" as "engine x"), for every language
  or one, matching case or not, whole words or inside words, with a button to
  hear each one. It applies from the next reply.
- **Voice regression check.** `pnpm voice:regress` renders 14 replies through
  the app's own sentence chunking, synthesis and trimming, and fails when the
  joins between sentences drift from one render of the whole reply: pitch step,
  pause, loudness step, the pitch a sentence starts on, lead and tail silence,
  length, and NaN, clipped or silent audio. Pull requests that touch the voice
  path run it on Kitten nano and in-browser Kokoro; every CI engine runs nightly.
  Kitten renders the corpus three times and gates on the pooled result, so its
  run-to-run noise never fails a pull request.
  Matcha runs nightly too, and the default Piper voice locally.
- **Voice engine bake-off.** `pnpm voice:bakeoff` weighs a candidate voice
  engine against the shipped ones on your own computer: first audio and
  real-time factor on the execution provider the agent's benchmark picks,
  the regression's join metrics, word error rate through Parakeet, a UTMOS
  quality score, whether tags like `[laugh]` are performed (an AudioSet
  tagger), languages, size and RAM. Its first run weighed Chatterbox-Turbo
  (MIT, the one open expressive engine with an ONNX build) on an M4: it laughs
  on cue and reads as clearly as Kokoro, but its first audio took 5.0 s against
  Supertonic's 0.36 s and it renders slower than real time, so no engine was
  added.
- **Model licenses in Settings → Voice.** Every speech engine's card now names
  its model's license, and Supertonic's links to its OpenRAIL-M terms, which
  forbid some uses. Piper shows each voice's license in its Model menu.
- **Models with a restricted license are opt-in.** Pocket TTS, your cloned
  voices and the Piper voices whose own data is research-only, non-commercial,
  share-alike, AGPL or of unknown license (lessac, amy, ryan, daniela, tom,
  upmc, paola, pratham, priyamvada, rohan, xiao_ya, huayan) are locked in
  Settings → Voice; picking one says what its license limits, links it, and
  asks you to allow them. A Piper voice is judged by its own data, so Thorsten,
  Kerstin, Ramona, Riccardo, Siwis, Davefx, Sharvard, Faber, Cadu, Tugão,
  LibriTTS-R and Chaowen stay open whatever voice they were fine-tuned from, as
  do Nemotron Streaming (NVIDIA Open Model License) and Nemotron 3.5. OpenLive
  never switches to a locked one on its own: not as a default, not on a
  language switch and not as a fallback. An engine you already use keeps
  working, with a note.
- **Native voices pick where they run on your machine.** OpenLive checks your
  device (CPU, cores, memory, GPU, OS) and, after a native speech engine's first
  use, benchmarks it on the CPU and on each accelerator your machine and the
  speech runtime support (CoreML on a Mac). An accelerator is used only when it
  is at least 20% faster there; until then, and on any failure, the engine runs
  on the CPU. Each benchmark runs in a separate process, so an accelerator that
  crashes during one never takes OpenLive down with it. Threads per engine follow your core count instead of a fixed
  number. Settings → Voice shows your device and, per engine, where it runs and
  why, with an Auto / CPU / accelerator choice and "Re-run benchmark". All of it
  stays on your machine.
- **Supertonic runs on your computer's GPU in the desktop app.** Download it
  once under Settings → Voice → Text-to-speech → On this computer, and the
  agent speaks Supertonic replies with the same voice the browser would, on
  whichever of your CPU and GPU it measures faster (WebGPU or CoreML on a Mac,
  DirectML or WebGPU on Windows, CUDA on Linux when installed). If it cannot
  run, the browser's Supertonic takes over for the call in the same voice.
  Every engine card now says where it runs: the browser (WebGPU or WASM) or
  this computer and on what.
- **Voiceprint (experimental, off by default).** Settings → Voice → VAD →
  Voiceprint can learn your voice from about 15 seconds of reading, on the
  desktop app's local agent (CAM++ by 3D-Speaker, Apache-2.0, 28 MB). "Only
  me" then lets only your voice start a turn or cut in while the agent talks:
  other people in the room and the agent's own voice through the speakers are
  ignored, and a reply they paused goes on. Soft speech over the agent that
  used to be taken for its echo now cuts in once it is recognized as you.
  "Label voices" instead marks each turn in the transcript as you or another
  voice. The voiceprint stays on this computer and can be deleted in
  Settings; push-to-talk always goes through (labelled too), and without the
  agent or an enrollment everyone is heard as before. A busy page no longer
  lets another voice through while the agent's answer is on its way, another
  voice no longer raises the level your own must clear, and the enrollment bar
  moves while you read.
- **Side talk (experimental, off by default).** Settings → Voice →
  Turn-taking → Side talk can have the agent skip what you say to someone else
  in the room ("did you feed the dog?"), on the desktop app's local agent
  (Paraphrase Multilingual MPNet, Apache-2.0, 296 MB, all ten languages). A
  sentence it takes for side talk gets no answer, a reply it paused goes on,
  and the transcript shows it with a button to send it anyway. When unsure, it
  answers; push-to-talk, answers to the agent's questions and a sentence naming
  OpenLive always go through, and if the agent can't be reached everything is
  answered as before. It stays off by default because in our tests it caught
  only about one in five English side talk sentences.
  "Judge only" judges every sentence and still answers all of them. Flow shows
  a dropped sentence on the orb with "Send it" too. An opt-in judgment log
  (off by default) keeps each judged sentence's words, the reply before it and
  how it sounded (loudness, pitch, pace and timing, never the audio) on this
  computer only, the newest 5,000; Settings shows its size and deletes it.
  "Send it" and a new "Not for you" under a spoken turn (which also stops the
  reply to it) mark what the check got wrong, and `pnpm addressee:train` turns
  the log into your own head, used only when it beats the shipped one on your
  own sentences without ignoring more of what you say to the app.
- **Experimental tags in Settings → Voice.** Voiceprint, Side talk and
  Listening sounds each carry an "Experimental" tag, read with the control's
  name, and a line on what it does and where it falls short. The transcript
  calls other voices "Other voice 1" and a dropped sentence "Taken as side
  talk", since both are the checks' best guess.
- **Latency in the call.** The top bar of a call shows the median time from the
  end of your speech to the reply's first sound, and its popover the median and
  p95 of each stage: transcription and end of turn, the model, and the voice.
- **Talk to OpenLive in ten languages.** Settings → Voice → Language picks
  English, Spanish, French, German, Italian, Portuguese, Hindi, Chinese,
  Japanese or Korean. Speech recognition, turn-taking and the voice follow it,
  and the assistant replies in it, in calls and in Flow. Engines that cannot
  speak it are greyed out; switching swaps them for ones that can and offers
  any download they need.
- **Every speech engine comes in sizes.** Each engine has a Model menu with its
  sizes, speeds, languages and license: Parakeet from 110M to 0.6B fp16 plus
  the multilingual v3, Moonshine tiny, Nemotron at 80 to 1120 ms, the
  multilingual Nemotron 3.5, Kitten micro and mini, and Pocket fp32. New
  engines: Canary, Piper voices in eight languages, Kokoro on the CPU and
  Matcha.
- **Native speech engines.** The voice service can download and run five
  optional sherpa-onnx models on this machine: Nemotron (streaming), Parakeet
  and Moonshine for speech to text, and Pocket TTS and Kitten TTS for speech,
  streamed as it is generated. Each is its own download and can be deleted
  again. They run off the main thread, so live calls stay responsive.
- **Calls and Flow can use the native speech engines.** Nemotron transcribes
  while you talk, so your words are ready about as soon as you stop; Pocket TTS
  and Kitten TTS start speaking before the sentence is fully synthesized. An
  engine that is missing or unreachable switches the call to Whisper or Kokoro,
  with one notice; a one-off hiccup falls back for that turn only.
- **Pick the native engines in Settings → Voice.** Speech-to-text and
  Text-to-speech list every engine with its size, license and whether it is
  downloaded, with download progress, cancel and remove in place. Pocket TTS
  and Kitten TTS get their own voices and a preview. Settings search finds them
  by name.
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
- **The voice no longer changes pitch and pace from line to line.** Every voice
  engine sounds a little different on a short piece of text than on a long one,
  and a reply was spoken in many short pieces, so a short line ("Anything
  else?", the line before a tool) could jump in pitch or speed up. After the
  first sentence, which still starts as fast as before, the reply is now spoken
  in fewer, longer pieces: sentences wait while there is audio ahead to play,
  as long as this computer's measured speed allows, and a short last line goes
  with the piece before it. In a call and in Flow, for every voice and brain.
- **A buzz under the voice is gone.** With Kokoro on the agent and Kitten, a
  low buzz could play for a few seconds under the next sentence, and their
  output played louder than other voices from a constant offset in it. Each
  piece now stops exactly at its end, and the offset is filtered out.
- **"You're up to date" no longer pops up on its own.** After Check for Updates
  found a version, a later automatic check that found nothing could still open that
  message. It now appears only for a check you asked for.
- **A model picked in Settings ran as the default one.** Choosing a model
  before ever choosing a provider saved the model alone, so Chat and Flow
  kept running the provider's default while the picker showed your choice.
  The model is now saved with the provider it was picked from.
- **A model already saved alone still ran as the default one.** Settings saved
  that way before the fix above now run the model you picked, on the one
  configured provider that offers it.
- **Flow had no shared memory.** Neither brain in Flow could use OpenLive's
  `remember`, so Claude Code in Flow wrote its own memory files. Flow now offers
  chat's own `remember` to both brains, tells each what it already holds, and
  tells a coding agent to save there and never in its own files.
- **Flow history called a stopped ask a failure.** A tool stopped while its
  permission ask was open read "It did not work"; it now reads "Stopped", for
  either brain.
- **A declined Flow action stayed refused in later turns.** The brain read an
  earlier "no" as a tool that cannot work and refused a new request without
  asking. The refusal now says the tool works and a new request is asked
  afresh, and a request made mid-turn after a no is asked again too.
- **A busy computer switched speech-to-text to a much slower Whisper.** A native
  engine slower than 12 s fell back to an in-browser Whisper that was not even
  loaded, and the turn took about a minute. Until Whisper is loaded, the native
  engine now gets as long as that fallback would take.
- **Nemotron streaming lost short answers and last words.** A lone word like
  "Sure" came back empty, and the 560 ms and 1120 ms variants dropped the last
  word of a sentence ("...ten minutes" for "...ten minutes, please"). The
  silence fed after speech is now sized from each variant's chunk, an empty
  result gets up to 2 s more before it stands, and a word's time never lands
  past the end of what was said. A lone "No" (and "Yeah" on the 80 ms one) the
  English models still never return; Nemotron 3.5 does.
- **Speed checks spent hours on accelerators that never finish.** CoreML ran
  the full two minutes on every Piper voice and on Pocket before giving up. An
  accelerator now gets CPU's own time twice over plus 20 s, and once it fails
  or times out on one variant it is skipped for that model's other variants on
  this device. It is still used only when it is 20% faster than CPU.
- **Deleting a chat left its settings behind.** Its agent, folder, cut and
  session keys now go with it.
- **Settings search stopped short of Voiceprint, Listening sounds and Side
  talk.** It opened their stage and left the row below the fold; it now
  scrolls to the row itself.
- **Settings showed stale model state.** A model installed or removed in
  another window or from Flow now shows when Settings opens or regains focus.
- **The Smart-Turn card claimed ~12 ms.** It runs on the CPU in a WebAssembly
  worker at about 250 ms per check, and now says so.
- **A late tool call from a stopped agent turn ran in the next one.** When
  Claude Code calls an OpenLive tool after its turn was stopped, in a call or
  in Flow, the call is now refused. Other agents send no call id, so theirs
  still run under the current turn.
- **Resuming a Flow session forgot a stopped last request.** The stop is now
  written to the session, so the brain is told again that it was cancelled,
  and history shows "You stopped it".
- **Flow history said an unanswered permission ask "did not work".** It now
  reads "No answer".
- **Calls could claim actions no tool took.** The rule Flow follows, never say
  something is done unless a tool did it, now reaches both brains in calls too.
- **A stopped request came back on the next turn.** Stop, close, hang-up or a
  barge-in mid-turn left the request in the brain's history unanswered, so the
  next unrelated turn carried it out (Claude Code opened Calculator after the
  user stopped it). Both brains are now told the request was cancelled and must
  not be done unless asked again, in chat and Flow and across a hang-up; a
  coding agent is no longer resent it, and a tool call it makes between turns
  is refused.
- **A refused Flow action had the brain nag about settings.** The tool result
  told it to point the user at Flow's settings right after they said no. It now
  says they declined this time and not to retry or ask, and the same turn does
  not ask again.
- **Flow's history said a quiet reply was spoken and a refused tool failed.**
  A reply Flow only showed now reads "Shown, not spoken", and a tool the user
  refused reads "You declined".
- **Claude Code kept what the user asked it to remember to itself.** It wrote
  its own memory files, so the built-in brain never learned it. A coding agent
  in a call is now told to use OpenLive's `remember`, which every brain reads.
- **Flow claimed actions it never took.** Side talk sent on with "Send it"
  ("Hey Sam, can you grab the mail") got "done, mail retrieved". Flow's rules
  now forbid saying something is done unless a tool did it, and a sentence sent
  on from side talk reaches either brain marked as maybe meant for someone else.
- **A slow transcription could send a turn over a playing reply without
  cutting it.** The old reply played through, then the new answer. A turn
  committed while a reply plays now cuts it as a barge-in does, at the word
  being voiced.
- **A soft talker could be dropped by their own first words.** Silero trails a
  soft voice's onset, and those words counted as room noise while the engine was
  idle, lifting the noise gate over the rest of the sentence. The floor now goes
  back to where it stood before each segment's audio began.
- **Words said while another sentence finalized could vanish.** When the
  agent's voice leaked back into the mic at that moment, the waiting words were
  dropped as if they were the echo. Only the echo is dropped now.
- **A coding agent remembered replies the user never heard.** Cutting in on
  Claude Code, Codex or any agent cut the transcript, but the agent kept its whole
  reply in its own session and answered as if it had been heard. Its next turn
  now starts by saying what was heard, in chat and in Flow, and in chat after a
  hang-up and reconnect too, as the built-in brain's history already did.
- **A coding agent without image support could not see the camera.** With a
  vision model set in Settings, the built-in brain saw through it, while an agent
  that takes no images was told to ask the user instead. It now gets the vision
  model's report too.
- **Flow's orb showed nothing while a coding agent used Flow's tools.** It now
  switches to the tool at work, as it does for the built-in brain.
- **Numbers with dots for thousands were read as versions.** German "1.500.000
  Leute" was "eins Punkt fünfhundert Punkt null". In German, Spanish, Italian,
  Portuguese and French a dotted number now reads as the number it is ("eine
  Million fünfhunderttausend"), as do French spaced groups (1 500 000) and Swiss
  apostrophes (1'500'000). Versions (v1.2.3, and 1.2.3 everywhere), addresses
  (192.168.0.1) and dotted dates (26.09.2026) read as before. In English, where
  "." is the decimal mark, 1.500 is still one point five zero zero.
- **Phone numbers were read as ranges.** "555-0123" was "five hundred fifty-five
  to zero one two three". A phone now reads digit by digit, a pause between its
  groups, in every language: 555-0123, (555) 123 4567, 555.123.4567, +49 30
  12345678, and "ext. 89" in English. Ranges such as 10-20, 1990-1995 and
  100-1000 still read as ranges, and ISO dates as dates.
- **Hanging up mid-reply saved the whole reply.** Ending a call while the voice
  was speaking kept everything the model had written, heard or not. The saved
  reply now ends where the voice stopped, and nothing is voiced after hang-up.
- **Interrupting a reply saved the rest of its sentence.** The live transcript
  kept only what was said, but after a reload the chat had the whole sentence
  that was playing. Both now end at the word being said when you cut in.
- **Short captions with a price or a date showed all at once.** "$1,200.50 on
  2026-09-25" is three words on screen and four seconds of speech. The live
  caption now reveals every line word by word, and a new line no longer flashes
  whole before its first word.
- **Tables and bullets were read out.** A table's bars and rule lines, box
  drawing and bullet characters reached the voice. Between words they are now a
  pause, at an edge nothing, in every language. The transcript still shows them.
- **Talking over a reply waited out the mid-thought hold.** A short "stop, just
  say hello" said over the agent sat up to four seconds before it was sent. What
  you say over a reply now goes as soon as you stop.
- **Piper and Matcha sentences joined at the wrong pause.** Depending on the
  voice, sentences ran into each other (17 ms apart) or sat almost 0.2 s apart,
  where one render pauses about 75 ms. Each sentence now keeps a set sliver of
  silence, so every voice joins within about 15 ms of its own pause.
- **A reply's first sentence broke in two.** When it had a comma far enough in,
  the voice spoke up to the comma as a sentence of its own, with a full stop's
  pause and fall, then started the rest over at another pitch. The first chunk
  now always ends at a sentence end, with every voice. A reply whose first
  sentence is long starts speaking a little later.
- **Kokoro paused about 0.8 s between sentences.** Like Supertonic below, each
  sentence came with its own silence, so the voice restarted on every one.
  Sentences now join at Kokoro's own pause, about 0.5 s, and a reply's first
  words start about 0.25 s sooner.
- **Supertonic paused about a second between sentences.** Each sentence came
  with its own silence before and after, so every one started over like a new
  voice. Sentences now join with the model's own pause, about 0.4 s, and the
  first words of a reply start about 0.3 s sooner.
- **Talking over an agent's unseen question did not stop the call's turn.** The
  question kept the turn running and the next sentence waited behind it. Talking
  over it now refuses the question and stops the turn.
- **Flow's Stop did nothing while an approval was up.** The orb went back to
  listening while the turn waited on the question. Stop now refuses the
  question and ends the turn, in Flow and on screen alike.
- **The orb left speaking in a pause inside a line.** A quiet stretch in the
  last sentence of a reply read as the voice being done, so the call went idle
  while it was still talking. It now waits for the line to finish playing.
- **A sentence said just as an agent asked for permission vanished.** Said
  before the ask reached the screen, it was taken as the ask's answer and
  dropped, and the unseen ask held the agent for two minutes. In calls and Flow
  the unseen ask is now refused and the sentence goes through.
- **An agent's leftover question held the next sentence.** A question an agent
  sent after its turn was over is now refused. A sign-in it asks for while
  starting still waits for you.
- **Ending a call mid-sentence started a turn.** Speech still being transcribed
  at hang-up made an empty reply in the transcript. Switching mics while hanging
  up also kept the new mic open.
- **The orb flipped to speaking while you were still talking.** A line spoken
  over your sentence no longer stops the call from hearing the rest of it.
- **Flow kept the mic after it failed to start.** "Try again" opened a second
  one on top. A failed start now lets go of it.
- **Closing Flow or putting the machine to sleep mid-reply.** Closing saved
  the whole reply, heard or not, and sleep with an approval open let the turn
  carry on after wake. Both now end the turn and keep only what was spoken.
- **A call's voice models could reload mid-call.** Turning on the camera or
  plugging in a device during a call after changing voice settings restarted
  the models and failed the sentence being heard.
- **The call heard itself.** On speakers, the reply's own voice leaking into the
  mic could be sent as a turn, cutting the reply short on screen. It is now
  dropped; talking over the reply still stops it.
- **The orb stuck on speaking.** A spoken error or reminder outside a reply, and
  a chat error with no end after it, left the call on speaking or thinking. It
  now settles once the line is said.
- **A held sentence was lost.** A mid-thought pause that ran out while
  something was being said, or a Send now tapped mid-sentence, dropped what
  was held. It is now kept and sent.
- **A chat reply lost to a dropped connection stayed open forever.** Chat now
  ends it and says the connection dropped mid-answer, as Flow does.
- **A cancelled turn's permission ask showed up in the next turn.** Asks now
  belong to their turn, and a late one is refused instead of taking your next
  sentence as its answer.
- **Flow could not answer a coding agent's question by voice.** A spoken yes
  or no now picks the agent's own allow or reject option.
- **A voice engine that hung kept the call silent.** Two sentences in a row
  that never start now switch the call to the browser voice, with a notice.
  The notice for a language with no voice is also given again on each call.
- **The voice changed in the middle of a reply.** In calls and Flow, a sentence
  the voice engine was slow on, or failed once, was read in the browser voice,
  and the reply's first few words were spoken on their own in a different
  pitch. The chosen voice now reads everything: a slow or failed sentence is
  tried again in the same voice, the engine stays loaded for the whole call,
  the first chunk is a whole sentence, and a settings change applies from the
  next reply. Only an engine that is missing or unreachable switches the call
  to the browser voice, once, with a notice. Supertonic also sounds the same
  from sentence to sentence.
- **Cloned voices failed in the desktop app** with "External buffers are not
  allowed". Cloning now hands audio over the way the packed app accepts.
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
