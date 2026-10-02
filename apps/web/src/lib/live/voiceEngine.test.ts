import { expect, it, vi } from "vitest";

vi.mock("@ricky0123/vad-web", () => ({ MicVAD: class {} }));
// A streaming engine: the sentence's audio in two chunks, a tick apart.
const tts = vi.hoisted(() => ({ chunks: [] as Float32Array[], calls: 0, texts: [] as string[], heard: "", at: [] as number[], gate: Promise.resolve(), complete: false }));
// Speech-to-text hears `tts.heard` at `tts.at`, and the turn model calls it unfinished.
vi.mock("./models", () => ({
  resetNativeFallbacks() {},
  async ttsStream(text: string, _o: unknown, onChunk: (a: Float32Array, rate: number) => void, signal?: AbortSignal) {
    tts.calls++;
    tts.texts.push(text);
    for (const c of tts.chunks) { if (signal?.aborted) return; onChunk(c, 24000); await new Promise((r) => setTimeout(r, 5)); }
  },
  stt: async () => { await tts.gate; return { text: tts.heard, at: tts.at }; },
  turnModelReady: () => true,
  turnComplete: async () => tts.complete,
  activeSttEngine: () => "whisper",
  hasWebGPU: () => false,
}));
vi.mock("./asrStream", () => ({ AsrStream: class {} }));
// The agent's voiceprint: each verify call answers with the next verdict queued here (null: unreachable).
const vp = vi.hoisted(() => ({ verdicts: [] as Array<{ you: boolean; score: number; embedding: number[] } | null>, asked: [] as number[] }));
vi.mock("./voiceprint", () => ({
  voiceprintStatus: async () => null,
  verifyVoice: async (_a: Float32Array, _mic: string, voicedMs: number) => { vp.asked.push(voicedMs); return vp.verdicts.shift() ?? null; },
}));
// The agent's side talk check: answers `st.side` (never, with `hang`), and records
// what it was asked, with the Feats and log id sent, and the labels given.
const st = vi.hoisted(() => ({
  side: false, hang: false, asked: [] as Array<[string, string, string | undefined]>,
  sent: [] as Array<{ feats: Record<string, unknown>; keep?: { id: string; mode: string } }>, labels: [] as Array<[string, string]>,
}));
vi.mock("./addressee", () => ({
  sideTalk: (text: string, reply: string, speaker: string | undefined, feats: Record<string, unknown>, keep?: { id: string; mode: string }) => {
    st.asked.push([text, reply, speaker]);
    st.sent.push({ feats, keep });
    return st.hang ? new Promise(() => {}) : Promise.resolve(st.side);
  },
  labelJudgment: (id: string, label: string) => st.labels.push([id, label]),
}));
vi.mock("@/lib/log", () => ({ log: { debug() {}, info() {}, warn() {}, error() {} } }));
const { VoiceEngine } = await import("./voiceEngine");
const { DEFAULT_PIPELINE_CONFIG } = await import("./pipelineConfig");

// Between two words, or in a pause a voice keeps inside a line, the output is
// silent while the line is still playing.
it("stays on speaking through a silent stretch of a line still playing", async () => {
  const phases: string[] = [];
  const player = { level: () => 0, playing: () => true, flush() {}, close() {} };
  const eng = new VoiceEngine({ onPhase: (p) => phases.push(p) } as never, player as never);
  Object.assign(eng, { phase: "speaking" });
  (eng as any).waitDrainThenIdle((eng as any).epoch);
  await new Promise((r) => setTimeout(r, 150));
  expect(eng.currentPhase()).toBe("speaking");
  player.playing = () => false;
  await new Promise((r) => setTimeout(r, 150));
  expect(phases).toEqual(["idle"]);
});

/** 24 kHz tone for each [startMs, endMs), silence between. */
const tone = (spans: [number, number][], ms: number) => {
  const out = new Float32Array(ms * 24);
  for (const [a, b] of spans) for (let i = a * 24; i < b * 24; i++) out[i] = 0.3 * Math.sin(i / 20);
  return out;
};
const voice = { engine: "kitten-nano-int8", family: "kitten", voice: "", speed: 1, lang: "en", lexicon: null };

// A sentence starts playing before a streaming engine has all of it: the
// caption opens on an estimate, then is timed on the audio once it is in.
it("times a streamed sentence's caption on its audio once it is all in", async () => {
  const shown: number[][] = [], retimed: number[][] = [];
  const player = { level: () => 0, playing: () => true, flush() {}, close() {}, play: (_a: unknown, _e: unknown, _r: unknown, onStart?: () => void) => onStart?.() };
  const eng = new VoiceEngine({ onPhase() {}, onAgentText: (_s: string, at: number[]) => shown.push(at), onAgentTiming: (at: number[]) => retimed.push(at) } as never, player as never);
  tts.chunks = [tone([[100, 700]], 900), tone([[0, 600]], 700)]; // "one two," | pause | "three four."
  (eng as any).enqueueSpeak("one two, three four.", (eng as any).epoch, voice);
  await (eng as any).ttsChain;
  expect(shown).toHaveLength(1);
  expect(shown[0]).toHaveLength(4);
  expect(retimed).toHaveLength(1);
  expect(retimed[0]![0]).toBe(100);
  expect(retimed[0]![2]).toBe(900); // after the comma's pause, where the second chunk begins
});

it("sends no new timing for a sentence cut off by barge-in", async () => {
  const retimed: number[][] = [];
  const player = { level: () => 0, playing: () => true, flush() {}, close() {}, play: (_a: unknown, _e: unknown, _r: unknown, onStart?: () => void) => onStart?.() };
  const eng = new VoiceEngine({ onPhase() {}, onAgentText() {}, onBargeIn() {}, onAgentTiming: (at: number[]) => retimed.push(at) } as never, player as never);
  tts.chunks = [tone([[0, 500]], 500), tone([[0, 500]], 500)];
  (eng as any).enqueueSpeak("one two three four.", (eng as any).epoch, voice);
  await new Promise((r) => setTimeout(r, 1));
  eng.cutReply();
  await (eng as any).ttsChain;
  expect(retimed).toEqual([]);
});

const playNow = { level: () => 0, playing: () => true, ahead: () => 0, flush() {}, close() {}, hold() {}, release() {}, play: (_a: unknown, _e: unknown, _r: unknown, onStart?: () => void) => onStart?.() };

// What is saved on a cut is what the caption revealed: the sentences before, then
// the words of the playing one begun by the cut.
it("cuts the reply at the word being voiced, not the end of its sentence", async () => {
  const eng = new VoiceEngine({ onPhase() {}, onAgentText() {} } as never, playNow as never);
  tts.chunks = [tone([[0, 3000]], 3000)];
  Object.assign(eng, { replyFed: true });
  (eng as any).enqueueSpeak("First one.", (eng as any).epoch, voice);
  (eng as any).enqueueSpeak("Second part here.", (eng as any).epoch, voice);
  await (eng as any).ttsChain;
  expect((eng as any).voicing.text).toBe("Second part here.");
  // Retimed on its audio: the three words spread over three seconds.
  Object.assign((eng as any).voicing, { at: [0, 1000, 2000], t0: performance.now() - 1500 });
  expect(eng.cutReply()).toBe("First one. Second part");
});

it("voices all of a question the reply waits on, its last sentence too", async () => {
  const spoken: string[] = [];
  const eng = new VoiceEngine({ onPhase() {}, onAgentText: (s: string) => spoken.push(s) } as never, playNow as never);
  tts.chunks = [tone([[0, 300]], 300)];
  Object.assign(eng, { acceptingReply: true });
  eng.ask("Claude Code wants permission: Write notes.txt. Allow it?");
  await (eng as any).ttsChain;
  expect(spoken.join(" ")).toBe("Claude Code wants permission: Write notes.txt. Allow it?");
});

// After the opening, reply text waits while the voice has audio well ahead, so
// the engine gets fewer, longer chunks; it goes when the audio runs low, at the
// turn's end, or at once where synthesis barely keeps up or is not timed yet.
const opening = "Sure, here is what I found today.";
const middle = "The first thing is long enough to go alone. The second thing is also long enough.";
const replyWith = (ahead: () => number, synth?: number) => {
  const eng = new VoiceEngine({ onPhase() {}, onAgentText() {}, onBargeIn() {} } as never, { ...playNow, ahead } as never);
  tts.chunks = [tone([[0, 300]], 300)];
  tts.texts = [];
  Object.assign(eng, { replyVoice: voice, acceptingReply: true });
  if (synth !== undefined) (eng as any).paces.set("kitten-nano-int8||1|en", { synth, audio: 0.06 });
  return eng;
};
const fed = async (eng: InstanceType<typeof VoiceEngine>, ...deltas: string[]) => {
  for (const d of deltas) { eng.feedAgentDelta(d); await (eng as any).ttsChain; }
};

it("holds later sentences while audio is well ahead, and voices them with the short last line", async () => {
  const eng = replyWith(() => 30, 0.01);
  await fed(eng, `${opening} `, `${middle} `);
  expect(tts.texts).toEqual([opening]);
  eng.feedAgentDelta("Anything else?");
  eng.endAgentTurn();
  await (eng as any).ttsChain;
  expect(tts.texts).toEqual([opening, `${middle} Anything else?`]);
  eng.stop();
});

it("joins a short last line to a chunk still waiting to be synthesized, never to an opening or a line said out of band", async () => {
  const eng = replyWith(() => 30, 0.01);
  eng.feedAgentDelta(`${opening} `);
  await new Promise((r) => setTimeout(r, 0));          // the opening is synthesizing
  eng.feedAgentDelta(`${middle} `);
  eng.endAgentStep();                                  // a tool: the middle is voiced now, and waits behind the opening
  eng.feedAgentDelta("Anything else?");
  eng.endAgentTurn();
  await (eng as any).ttsChain;
  expect(tts.texts).toEqual([opening, `${middle} Anything else?`]);
  const said = replyWith(() => 30, 0.01);
  said.feedAgentDelta(`${opening} `);
  await new Promise((r) => setTimeout(r, 0));
  said.say("The agent stopped responding.");
  said.feedAgentDelta("Anything else?");
  said.endAgentTurn();
  await (said as any).ttsChain;
  expect(tts.texts).toEqual([opening, "The agent stopped responding.", "Anything else?"]);
  const asked = replyWith(() => 30, 0.01);
  asked.ask(`${opening} Shall I go on?`);             // the opening has not begun synthesizing, and is never held up
  await (asked as any).ttsChain;
  expect(tts.texts).toEqual([opening, "Shall I go on?"]);
  eng.stop(); said.stop(); asked.stop();
});

it("voices each sentence as it ends where synthesis barely keeps up, or is not timed yet", async () => {
  const slow = replyWith(() => 30, 0.5);
  await fed(slow, `${opening} `, `${middle} `);
  expect(tts.texts).toEqual([opening, middle]);
  slow.stop();
  const cold = replyWith(() => 30); // both lines in one delta: nothing timed yet
  await fed(cold, `${opening} ${middle} `);
  expect(tts.texts).toEqual([opening, middle]);
  cold.stop();
});

it("never times a voice on its first synthesis, which carries the cold start", async () => {
  const eng = replyWith(() => 30);
  await fed(eng, `${opening} `);
  expect((eng as any).paces.has("kitten-nano-int8||1|en")).toBe(false);
  await fed(eng, `${middle} `);
  expect((eng as any).paces.get("kitten-nano-int8||1|en").audio).toBeCloseTo(0.3 / middle.length, 5);
  eng.stop();
});

it("voices held text once the audio ahead runs low, and times the voice on what it synthesized", async () => {
  const t0 = performance.now();
  const eng = replyWith(() => Math.max(0, 1.3 - (performance.now() - t0) / 1000), 0.001);
  await fed(eng, `${opening} `);
  const pace = (eng as any).paces.get("kitten-nano-int8||1|en");
  expect(pace.audio).toBeCloseTo(0.7 * 0.06 + 0.3 * (0.3 / opening.length), 5);
  (eng as any).paces.set("kitten-nano-int8||1|en", { ...pace, synth: 0.001 });
  await fed(eng, `${middle} `);
  expect(tts.texts).toEqual([opening]);
  await new Promise((r) => setTimeout(r, 400));
  await (eng as any).ttsChain;
  expect(tts.texts).toEqual([opening, middle]);
  eng.stop();
});

it("drops held text on a barge-in, and voices nothing of it later", async () => {
  const t0 = performance.now();
  const eng = replyWith(() => Math.max(0, 1.5 - (performance.now() - t0) / 1000), 0.001);
  await fed(eng, `${opening} `, `${middle} `);
  eng.cutReply();
  eng.endAgentTurn();
  await new Promise((r) => setTimeout(r, 400));
  await (eng as any).ttsChain;
  expect(tts.texts).toEqual([opening]);
  eng.stop();
});

// A reminder going off mid-reply waits for the reply's last words, and is never said over the user.
it("says an announcement after the reply under way ends, never inside it", async () => {
  const eng = replyWith(() => 0);
  eng.feedAgentDelta("Here is the first part. ");
  eng.announce("Reminder: call the bank");
  eng.feedAgentDelta("And here is the last part.");
  await new Promise((r) => setTimeout(r, 450));
  expect(tts.texts).not.toContain("Reminder: call the bank");
  eng.endAgentTurn();
  await new Promise((r) => setTimeout(r, 250));
  await (eng as any).ttsChain;
  expect(tts.texts.at(-1)).toBe("Reminder: call the bank");
  expect(tts.texts.slice(0, -1).join(" ")).toBe("Here is the first part. And here is the last part.");
  eng.stop();
});

it("holds an announcement while the user is talking or being transcribed, and drops it on hang-up", async () => {
  const eng = replyWith(() => 0);
  Object.assign(eng, { hearing: true });
  eng.announce("Timer: Time's up.");
  await new Promise((r) => setTimeout(r, 250));
  expect(tts.texts).toEqual([]);
  Object.assign(eng, { hearing: false, finalizing: true });
  await new Promise((r) => setTimeout(r, 250));
  expect(tts.texts).toEqual([]);
  Object.assign(eng, { finalizing: false });
  await new Promise((r) => setTimeout(r, 250));
  await (eng as any).ttsChain;
  expect(tts.texts).toEqual(["Timer: Time's up."]);

  Object.assign(eng, { hearing: true });
  eng.announce("Reminder: never said");
  eng.stop();
  Object.assign(eng, { hearing: false });
  await new Promise((r) => setTimeout(r, 250));
  expect(tts.texts).toEqual(["Timer: Time's up."]);
});

it("voices nothing, and asks no engine, once stopped", async () => {
  const eng = new VoiceEngine({ onPhase() {}, onAgentText() {} } as never, playNow as never);
  tts.chunks = [tone([[0, 300]], 300)];
  tts.calls = 0;
  eng.stop();
  eng.feedAgentDelta("A late sentence after hanging up. And another one right behind it. ");
  eng.endAgentTurn();
  eng.say("A reminder.");
  await (eng as any).ttsChain;
  expect(tts.calls).toBe(0);
});

// "Stop, just say hello" over the agent: sent the moment it ends, not held as a
// mid-thought pause. Said into silence, the same words are held.
it("sends an utterance that barged in without the mid-thought hold", async () => {
  const run = async (overReply: boolean, heard = "stop just say hello") => {
    tts.heard = heard;
    const sent: string[] = [], holds: unknown[] = [];
    const player = { ...playNow, playing: () => overReply };
    const eng = new VoiceEngine({ onPhase() {}, onPartial() {}, onBargeIn() {}, onUserText: (t: string) => sent.push(t), onHold: (h: unknown) => h && holds.push(h) } as never, player as never, { holdMs: 4000 });
    Object.assign(eng, { phase: overReply ? "speaking" : "idle", micRms: 1 });
    (eng as any).onSpeechStart();
    await (eng as any).onSpeechEnd(new Float32Array(16000).fill(0.1));
    (eng as any).clearHold();
    return { sent, holds: holds.length };
  };
  expect(await run(true)).toEqual({ sent: ["stop just say hello"], holds: 0 });
  expect(await run(false)).toEqual({ sent: [], holds: 1 });
  expect(await run(true, "no wait, and")).toEqual({ sent: ["no wait, and"], holds: 0 }); // trailing off, still sent
  expect(await run(false, "no wait, and")).toEqual({ sent: [], holds: 1 });
});

// Each word keeps when it was said, counted from the turn's first segment:
// a held one, then one streamed, then two that ended while it was transcribing.
it("an utterance that finishes transcribing while a later reply plays cuts that reply like a barge-in", async () => {
  let open!: () => void;
  tts.gate = new Promise((r) => (open = r));
  tts.heard = "wait stop talking please";
  tts.complete = true;
  let playing = false;
  const seen: string[] = [];
  const player = { ...playNow, playing: () => playing, flush() { playing = false; } };
  const eng = new VoiceEngine({ onPhase() {}, onPartial() {}, onHold() {}, onAgentText() {}, onUserText: (t: string) => seen.push(`sent ${t}`), onBargeIn: (spoken?: string) => seen.push(`cut ${spoken}`) } as never, player as never) as any;
  Object.assign(eng, { phase: "idle", micRms: 1 });
  eng.onSpeechStart();
  const ended = eng.onSpeechEnd(new Float32Array(16000).fill(0.1));
  // The reply to an earlier turn starts playing while this one still transcribes.
  Object.assign(eng, { phase: "speaking", replyOpen: true, replyFed: true, spokenText: "Every night, Thomas climbed the stairs." });
  playing = true;
  open();
  await ended;
  expect(seen).toEqual(["cut Every night, Thomas climbed the stairs.", "sent wait stop talking please"]);
  tts.gate = Promise.resolve();
  tts.complete = false;
});

it("drops a sentence still being said or transcribed when told to discard, and hears the next one", async () => {
  const sent: string[] = [];
  const eng = new VoiceEngine({ onPhase() {}, onPartial() {}, onBargeIn() {}, onHold() {}, onUserText: (t: string) => sent.push(t) } as never, { ...playNow, playing: () => false } as never) as any;
  Object.assign(eng, { micRms: 1 });
  let open!: () => void;
  Object.assign(tts, { heard: "said before the stop", at: [], complete: true, gate: new Promise<void>((r) => { open = r; }) });
  eng.onSpeechStart();
  const transcribing = eng.onSpeechEnd(new Float32Array(16000).fill(0.1));
  eng.discard();
  open();
  await transcribing;
  tts.heard = "said after it";
  eng.onSpeechStart();
  await eng.onSpeechEnd(new Float32Array(16000).fill(0.1));
  expect(sent).toEqual(["said after it"]);
  Object.assign(tts, { complete: false, gate: Promise.resolve() });
});

it("a turn's word onsets run on across its segments", async () => {
  const sent: [string, number[]][] = [];
  const eng = new VoiceEngine({ onPhase() {}, onPartial() {}, onBargeIn() {}, onHold() {}, onUserText: (t: string, at: number[]) => sent.push([t, at]) } as never, { ...playNow, playing: () => false } as never) as any;
  Object.assign(eng, { micRms: 1 });
  const seg = () => new Float32Array(16000).fill(0.1);
  let open!: () => void;
  Object.assign(tts, { heard: "okay so", at: [900, 1200], gate: new Promise<void>((r) => { open = r; }) });
  eng.onSpeechStart();
  const first = eng.onSpeechEnd(seg());
  await eng.onSpeechEnd(seg(), Promise.resolve({ text: "the plan", at: [820, 1100] }));
  await eng.onSpeechEnd(seg(), Promise.resolve({ text: " is ", at: [810] }));
  open();
  await first;
  await vi.waitFor(() => expect(eng.pendingText).toBe("okay so the plan is"));
  await eng.onSpeechEnd(seg(), Promise.resolve({ text: "ship it", at: [850, 1300] }));
  eng.commitPending();
  expect(sent).toEqual([["okay so the plan is ship it", [900, 1200, 1820, 2100, 2810, 3850, 4300]]]);
  tts.gate = Promise.resolve();
});

// ── talk over the reply: paused at once, cut only for words ─────────────────
const second = new Float32Array(16000).fill(0.1);
const frame = new Float32Array(512).fill(0.1); // one 32 ms VAD frame
/** An engine mid-reply, and a record of what the surface and the player saw. */
function overReply(phase = "speaking", h: Record<string, unknown> = {}) {
  const seen = { phases: [] as string[], sent: [] as string[], cuts: 0, held: false, flushed: 0 };
  const player = { ...playNow, playing: () => phase === "speaking" && !seen.flushed, hold() { seen.held = true; }, release() { seen.held = false; }, flush() { seen.flushed++; seen.held = false; } };
  const eng = new VoiceEngine({ onPhase: (p: string) => seen.phases.push(p), onPartial() {}, onHold() {}, onAgentText() {}, onUserText: (t: string) => seen.sent.push(t), onBargeIn: () => seen.cuts++, ...h } as never, player as never);
  Object.assign(eng, { phase, micRms: 1, replyOpen: true });
  return { eng: eng as any, seen };
}

it("a cough or a backchannel over the reply pauses it, then goes on from there", async () => {
  for (const heard of ["", "(coughs)", "Mm-hmm.", "yeah, okay", "uh huh right"]) {
    tts.heard = heard;
    const { eng, seen } = overReply();
    const epoch = eng.epoch;
    eng.onSpeechStart();
    expect(seen.held).toBe(true);
    await eng.onSpeechEnd(second);
    expect(seen).toEqual({ phases: [], sent: [], cuts: 0, held: false, flushed: 0 });
    expect(eng.currentPhase()).toBe("speaking");
    expect(eng.epoch).toBe(epoch); // the reply's audio is not stale
  }
});

it("words that are no backchannel cut the reply and are sent", async () => {
  for (const heard of ["mm-hmm wait stop", "no, the other file", "hold on a second"]) {
    tts.heard = heard;
    const { eng, seen } = overReply();
    const epoch = eng.epoch;
    eng.onSpeechStart();
    await eng.onSpeechEnd(second);
    expect(seen).toMatchObject({ phases: ["listening", "thinking"], sent: [heard], cuts: 1, flushed: 1 });
    expect(eng.epoch).toBeGreaterThan(epoch);
  }
});

it("over a paused reply a partial decides nothing, and the final does", async () => {
  const partials: string[] = [];
  for (const [final, cuts] of [["Ha ha ha", 0], ["hold on, stop", 1]] as const) {
    tts.heard = final;
    const { eng, seen } = overReply("speaking", { onPartial: (t: string) => partials.push(t) });
    eng.onSpeechStart();
    eng.heardPartial("have a"); // Whisper's reading of half a laugh
    eng.heardPartial("hold on stop");
    expect(seen.cuts).toBe(0);
    eng.uttEngine = "moonshine-base-en-int8"; // an engine that captions mid-utterance
    for (let i = 0; i < 10; i++) eng.onFrame(frame, true);
    expect(eng.partialBusy).toBe(false); // no caption transcribed ahead of the final
    await eng.onSpeechEnd(second);
    expect(seen.cuts).toBe(cuts);
  }
  expect(partials).toEqual([]);
});

it("an interim caption that lands after its segment ended decides nothing", async () => {
  let open!: () => void, finish!: (h: { text: string; at: number[] }) => void;
  tts.gate = new Promise((r) => (open = r));
  tts.heard = "have a"; // Whisper's reading of half a laugh
  const { eng, seen } = overReply();
  eng.onSpeechStart();
  eng.uttEngine = "moonshine-base-en-int8"; // an engine that captions mid-utterance
  for (let i = 0; i < 10; i++) eng.onFrame(frame, true); // the caption starts transcribing
  const ended = eng.onSpeechEnd(second, new Promise((r) => (finish = r)));
  open();
  await new Promise((r) => setTimeout(r, 0));
  expect(seen.cuts).toBe(0);
  finish({ text: "Ha ha ha", at: [] });
  await ended;
  expect(seen).toMatchObject({ cuts: 0, sent: [] });
  expect(eng.currentPhase()).toBe("speaking");
  tts.gate = Promise.resolve();
});

it("talk voiced past the cap cuts even before any words are in, however slow the transcriber", async () => {
  let open!: () => void;
  tts.gate = new Promise((r) => (open = r));
  tts.heard = "mm-hmm";
  const { eng, seen } = overReply();
  eng.onSpeechStart();
  for (let i = 0; i < 46; i++) eng.onFrame(frame, true); // 1472 ms voiced
  for (let i = 0; i < 20; i++) eng.onFrame(frame, false); // a pause voices nothing
  expect(seen.cuts).toBe(0);
  const ended = eng.onSpeechEnd(second);
  for (let i = 0; i < 100; i++) eng.onFrame(frame, true); // after the segment: only its transcript decides
  expect(seen.cuts).toBe(0);
  open();
  await ended;
  expect(eng.currentPhase()).toBe("speaking");
  tts.gate = Promise.resolve();
  eng.speakingStartAt = 0; // past the resumed voice's onset grace
  eng.onSpeechStart();
  for (let i = 0; i < 47; i++) eng.onFrame(frame, true); // 1504 ms
  expect(seen.cuts).toBe(1);
});

it("a sentence begun while a backchannel is still transcribing decides for both", async () => {
  let open!: () => void;
  tts.gate = new Promise((r) => (open = r));
  tts.heard = "yeah";
  const { eng, seen } = overReply();
  eng.onSpeechStart();
  const first = eng.onSpeechEnd(second);
  eng.onSpeechStart(); // the user goes on talking
  open();
  await first;
  expect(seen.held).toBe(true); // not resumed over them
  tts.heard = "yeah actually stop";
  await eng.onSpeechEnd(second);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toMatchObject({ cuts: 1, sent: ["yeah actually stop"] });
  tts.gate = Promise.resolve();
});

it("a laugh over the reply is no turn when talk after it cut the reply before its words were in", async () => {
  let finish!: (h: { text: string; at: number[] }) => void;
  const { eng, seen } = overReply();
  eng.onSpeechStart();
  const laugh = eng.onSpeechEnd(second, new Promise((r) => (finish = r)));
  eng.onSpeechStart(); // the user goes on talking
  for (let i = 0; i < 47; i++) eng.onFrame(frame, true); // 1504 ms voiced: cut
  expect(seen.cuts).toBe(1);
  finish({ text: "Ha ha ha", at: [] });
  await laugh;
  expect(seen.sent).toEqual([]);
  tts.heard = "wait stop";
  await eng.onSpeechEnd(second);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toMatchObject({ cuts: 1, sent: ["wait stop"] });
});

it("sounds over the reply, held while another transcribes, are no turn after talk cut the reply", async () => {
  let finish!: (h: { text: string; at: number[] }) => void;
  const { eng, seen } = overReply();
  eng.onSpeechStart();
  const laugh = eng.onSpeechEnd(second, new Promise((r) => (finish = r)));
  eng.onSpeechStart();
  void eng.onSpeechEnd(second, Promise.resolve({ text: "ahem", at: [] })); // held: the laugh still transcribes
  eng.onSpeechStart(); // the user goes on talking
  for (let i = 0; i < 47; i++) eng.onFrame(frame, true); // 1504 ms voiced: cut
  finish({ text: "Ha ha ha", at: [] });
  await laugh;
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toMatchObject({ cuts: 1, sent: [] });
});

it("a held thought is not sent on its own while its continuation still transcribes", async () => {
  let open1!: () => void, open2!: () => void;
  tts.gate = new Promise((r) => (open1 = r));
  tts.heard = "so I was thinking about the";
  const { eng, seen } = overReply("idle");
  eng.onSpeechStart();
  const first = eng.onSpeechEnd(second);
  eng.onSpeechStart();
  void eng.onSpeechEnd(second); // ends while the first transcribes: replayed after it
  tts.gate = new Promise((r) => (open2 = r));
  open1();
  await first; // the first is held, and its continuation now transcribes
  tts.heard = "so I was thinking about the weather tomorrow?";
  eng.flushPending(); // the hold runs out before the continuation's words are in
  open2();
  await new Promise((r) => setTimeout(r, 0));
  eng.commitPending(); // the turn model calls it unfinished; the hold sends it
  await new Promise((r) => setTimeout(r, 0));
  expect(seen.sent).toEqual(["so I was thinking about the weather tomorrow?"]);
  tts.gate = Promise.resolve();
  eng.clearHold();
});

it("outside a reply a lone yeah is an answer, and over a pending ask a yes answers it", async () => {
  tts.heard = "yeah";
  const idle = overReply("idle");
  idle.eng.onSpeechStart();
  await idle.eng.onSpeechEnd(second);
  idle.eng.commitPending(); // the turn model calls it unfinished; the hold sends it
  expect(idle.seen).toMatchObject({ sent: ["yeah"], cuts: 0, held: false });
  tts.heard = "yes";
  const ask = overReply("speaking", { holdBargeIn: () => true });
  ask.eng.onSpeechStart();
  await ask.eng.onSpeechEnd(second);
  ask.eng.commitPending();
  expect(ask.seen).toMatchObject({ sent: ["yes"], cuts: 0, held: false });
});

it("a spoken answer to a pending ask is sent at once; anything else still holds", async () => {
  const answersAsk = (t: string) => /^(yes|no)\b/i.test(t);
  for (const [heard, sent] of [["Yes.", ["Yes."]], ["No.", ["No."]], ["let me think", []]] as const) {
    tts.heard = heard;
    const { eng, seen } = overReply("thinking", { holdBargeIn: () => true, answersAsk });
    eng.onSpeechStart();
    await eng.onSpeechEnd(second);
    expect(seen.sent).toEqual(sent);
    eng.clearHold();
  }
});

it("once an ask's question is voiced the reply waits on the user, still open", async () => {
  let asking = true;
  const { eng, seen } = overReply("speaking", { holdBargeIn: () => asking });
  let playing = true;
  eng.player.playing = () => playing;
  eng.enqueueSpeak("", eng.epoch, voice); // the question, queued last
  await eng.ttsChain;
  await new Promise((r) => setTimeout(r, 150));
  expect(eng.currentPhase()).toBe("speaking"); // still voicing it
  playing = false;
  await vi.waitFor(() => expect(seen.phases).toEqual(["thinking"]));
  expect(eng.replyOpen).toBe(true);
  eng.onSpeechStart(); // the answer, never a barge-in
  expect(seen.cuts).toBe(0);
  asking = false;
  const after = overReply("speaking", { holdBargeIn: () => asking });
  after.eng.player.playing = () => false;
  after.eng.enqueueSpeak("", after.eng.epoch, voice);
  after.eng.waitDrainThenIdle(after.eng.epoch);
  await new Promise((r) => setTimeout(r, 150));
  expect(after.eng.currentPhase()).toBe("speaking"); // no ask: an open reply is not idled here
});

it("push-to-talk cuts at once, and cuts a reply paused by a cough", () => {
  const { eng, seen } = overReply();
  Object.assign(eng, { vad: { start() {}, pause() {} } });
  eng.beginPtt();
  expect(seen.cuts).toBe(1);
  const paused = overReply("thinking");
  Object.assign(paused.eng, { vad: { start() {}, pause() {} } });
  paused.eng.onSpeechStart();
  paused.eng.beginPtt();
  expect(paused.seen).toMatchObject({ cuts: 1, phases: ["listening"] });
});

// Flow's surface: a turn at work (thinking, tools running) is not cancelled by a
// cough, and the words of a real sentence still cancel it.
it("while the agent works, a cough keeps it working and words stop it", async () => {
  const flow = { onPartial() {}, onHold() {} };
  tts.heard = "(coughs)";
  const a = overReply("thinking", flow);
  a.eng.onSpeechStart();
  await a.eng.onSpeechEnd(second);
  expect(a.seen).toMatchObject({ phases: [], cuts: 0, held: false });
  expect(a.eng.currentPhase()).toBe("thinking");
  tts.heard = "stop that";
  const b = overReply("thinking", flow);
  b.eng.onSpeechStart();
  await b.eng.onSpeechEnd(second);
  expect(b.seen).toMatchObject({ phases: ["listening", "thinking"], sent: ["stop that"], cuts: 1 });
});

it("a pause holds the caption with the voice: a cut after it keeps only the words heard before", () => {
  const eng = new VoiceEngine({ onPhase() {}, onAgentText() {}, onBargeIn() {} } as never, playNow as never) as any;
  Object.assign(eng, { phase: "speaking", micRms: 1, replyFed: true, spokenText: "First one. Second part here.",
    voicing: { before: "First one.", text: "Second part here.", at: [0, 1000, 2000], t0: performance.now() - 1500, lag: 0 } });
  eng.onSpeechStart();
  eng.pausedAt -= 1000; eng.voicing.t0 -= 1000; // a second into the pause
  expect(eng.cutReply()).toBe("First one. Second part");
});

// ── the voiceprint gate ─────────────────────────────────────────────────────
const you = { you: true, score: 0.7, embedding: [1, 0, 0] };
const other = (embedding = [0, 1, 0]) => ({ you: false, score: 0.1, embedding });
/** `mode`: the voiceprint setting, the user enrolled. */
function gated(mode: "gate" | "label", phase = "idle") {
  const r = overReply(phase);
  r.eng.print = { mic: "Built-in", gate: mode === "gate" };
  const speakers: (string | undefined)[] = [];
  r.eng.h.onUserText = (t: string, _at: number[], speaker?: string) => { r.seen.sent.push(t); speakers.push(speaker); };
  return { ...r, speakers };
}

it("with the gate on, another voice never starts a turn; the user's does, labelled", async () => {
  tts.heard = "what time is it";
  for (const [verdict, sent] of [[other(), []], [you, ["what time is it"]], [null, ["what time is it"]]] as const) {
    vp.verdicts = [verdict]; vp.asked = [];
    const { eng, seen, speakers } = gated("gate");
    Object.assign(eng, { replyOpen: false });
    eng.turnCfg = () => ({ threshold: 0.5, holdMs: 4000, redemptionMs: 550, engine: "silence" });
    eng.onSpeechStart();
    await eng.onSpeechEnd(second);
    expect(seen.sent).toEqual(sent);
    expect(vp.asked).toEqual([0]); // too short for an early verdict: only the whole segment is checked
    if (verdict) expect(speakers).toEqual(sent.length ? ["you"] : []);
    expect(eng.currentPhase()).toBe(sent.length ? "thinking" : "idle");
  }
});

it("labels each turn with who said it, other voices numbered as first heard", async () => {
  tts.heard = "hello there";
  vp.verdicts = [you, other([0, 1, 0]), other([0, 0, 1]), other([0, 0.9, 0.1])];
  const { eng, speakers } = gated("label");
  eng.turnCfg = () => ({ threshold: 0.5, holdMs: 4000, redemptionMs: 550, engine: "silence" });
  for (let i = 0; i < 4; i++) { Object.assign(eng, { phase: "idle" }); eng.onSpeechStart(); await eng.onSpeechEnd(second); }
  expect(speakers).toEqual(["you", "other 1", "other 2", "other 1"]);
});

it("over the reply, another voice's first second lets the reply go on, and its words decide nothing", async () => {
  tts.heard = "hold on, stop"; // a second person's words, not the user's
  vp.verdicts = [other(), other()]; vp.asked = [];
  const { eng, seen } = gated("gate", "speaking");
  eng.onSpeechStart();
  expect(seen.held).toBe(true);
  for (let i = 0; i < 32; i++) eng.onFrame(frame, true); // 1024 ms voiced: the early verdict
  await new Promise((r) => setTimeout(r, 0));
  expect(seen.held).toBe(false);
  expect(eng.currentPhase()).toBe("speaking");
  for (let i = 0; i < 40; i++) eng.onFrame(frame, true); // past the backchannel cap: still no cut
  await eng.onSpeechEnd(second);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toMatchObject({ cuts: 0, sent: [] });
  expect(vp.asked).toEqual([1024, 72 * 32]); // the first second, then the whole segment again
});

it("a first second judged wrong is overturned by the whole segment: the user still cuts in", async () => {
  tts.heard = "no, the other file";
  vp.verdicts = [other(), you];
  const { eng, seen } = gated("gate", "speaking");
  eng.onSpeechStart();
  for (let i = 0; i < 32; i++) eng.onFrame(frame, true);
  await new Promise((r) => setTimeout(r, 0));
  await eng.onSpeechEnd(second);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toMatchObject({ cuts: 1, sent: ["no, the other file"] });
});

it("soft speech the echo check took for the agent's voice barges in once the voiceprint knows it", async () => {
  tts.heard = "wait, stop";
  vp.verdicts = [you, you, you];
  const { eng, seen } = gated("gate", "speaking");
  Object.assign(eng, { micRms: 0, speakingStartAt: 0 }); // under the echo check's bar
  eng.onSpeechStart();
  expect(eng.echo).toBe(true);
  for (let i = 0; i < 32; i++) eng.onFrame(frame, true);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen.held).toBe(false); // one second is not sure enough to pause the reply for
  for (let i = 0; i < 32; i++) eng.onFrame(frame, true);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen.held).toBe(true);
  await eng.onSpeechEnd(second);
  expect(seen).toMatchObject({ cuts: 1, sent: ["wait, stop"] });
});

it("a verdict that comes back after a mute drops the segment acts on nothing", async () => {
  vp.verdicts = [you, you];
  const { eng, seen } = gated("gate", "speaking");
  Object.assign(eng, { micRms: 0, speakingStartAt: 0, vad: { pause() {}, start() {} } });
  eng.onSpeechStart();
  for (let i = 0; i < 32; i++) eng.onFrame(frame, true);
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 32; i++) eng.onFrame(frame, true); // the two-second check leaves
  eng.setMuted(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen.held).toBe(false);
  expect(eng.currentPhase()).toBe("speaking");
});

it("the agent's own voice through the speakers stays echo, and without the agent the gate asks nothing more", async () => {
  vp.verdicts = [other()]; vp.asked = [];
  const { eng, seen } = gated("gate", "speaking");
  Object.assign(eng, { micRms: 0 });
  eng.onSpeechStart();
  for (let i = 0; i < 32; i++) eng.onFrame(frame, true);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen.held).toBe(false);
  vp.verdicts = [null];
  await eng.onSpeechEnd(second);
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toMatchObject({ cuts: 0, sent: [] });
});

it("without a verdict, soft speech the echo check took for the agent's voice stays echo", async () => {
  vp.verdicts = [null];
  const { eng, seen } = gated("gate", "speaking");
  Object.assign(eng, { micRms: 0, speakingStartAt: 0 });
  eng.onSpeechStart();
  for (let i = 0; i < 64; i++) eng.onFrame(frame, true);
  await new Promise((r) => setTimeout(r, 0));
  await eng.onSpeechEnd(second);
  expect(seen).toMatchObject({ held: false, cuts: 0, sent: [] });
});

it("over the reply, talk past the backchannel cap cuts only once two seconds of it pass the voiceprint", async () => {
  tts.heard = "";
  vp.verdicts = [you, you];
  const { eng, seen } = gated("gate", "speaking");
  eng.onSpeechStart();
  for (let i = 0; i < 32; i++) eng.onFrame(frame, true);
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 30; i++) eng.onFrame(frame, true); // 1984 ms: past the cap, second check not yet asked
  expect(seen.cuts).toBe(0);
  eng.onFrame(frame, true);
  await new Promise((r) => setTimeout(r, 0));
  eng.onFrame(frame, true);
  expect(seen.cuts).toBe(1);
});

it("push-to-talk is never turned away, and is labelled by its longest stretch of speech", async () => {
  tts.heard = "open the file";
  vp.verdicts = [other(), you]; vp.asked = [];
  const { eng, seen, speakers } = gated("gate", "idle");
  Object.assign(eng, { vad: { start() {}, pause() {} }, replyOpen: false });
  eng.beginPtt();
  for (const frames of [40, 10]) {
    eng.onSpeechStart();
    for (let i = 0; i < frames; i++) eng.onFrame(frame, true);
    await eng.onSpeechEnd(second);
  }
  await eng.endPtt();
  expect(vp.asked).toEqual([40 * 32, 10 * 32]); // no early checks: only each segment, for its label
  expect(seen.sent).toEqual(["open the file"]);
  expect(speakers).toEqual(["other 1"]);
});

it("a hold let go while its last segment is still being transcribed waits for those words", async () => {
  const sent: string[] = [];
  const eng = new VoiceEngine({ onPhase() {}, onPartial() {}, onBargeIn() {}, onHold() {}, onUserText: (t: string) => sent.push(t) } as never, { ...playNow, playing: () => false } as never) as any;
  Object.assign(eng, { micRms: 1, vad: { start() {}, pause() {}, setOptions() {} } });
  let open!: () => void;
  Object.assign(tts, { heard: "a long thought said while holding", at: [], gate: new Promise<void>((r) => { open = r; }) });
  eng.beginPtt();
  eng.onSpeechStart();
  const transcribing = eng.onSpeechEnd(new Float32Array(16000).fill(0.1));
  setTimeout(open, 3000);
  await eng.endPtt(true);
  // Heard by the time the release is over, while the hold's owner still takes it.
  expect(sent).toEqual(["a long thought said while holding"]);
  await transcribing;
  tts.gate = Promise.resolve();
});

it("a hold begun before the VAD was up is written down from its tape, words before the VAD included", async () => {
  const sent: string[] = [];
  const eng = new VoiceEngine({ onPhase() {}, onPartial() {}, onBargeIn() {}, onHold() {}, onUserText: (t: string) => sent.push(t) } as never, { ...playNow, playing: () => false } as never) as any;
  const cuts: number[] = [];
  Object.assign(eng, { ptt: true, vad: { start() {}, pause() {}, setOptions() {} }, tape: { stop: async (lateMs: number) => { cuts.push(lateMs); return new Float32Array(16000).fill(0.1); } } });
  Object.assign(tts, { heard: "send the report to the team", at: [] });
  expect(await eng.endPtt(true, 120)).toBe(true);
  expect(cuts).toEqual([120]);
  expect(sent).toEqual(["send the report to the team"]);
});

it("a hold whose words could not be written down says so", async () => {
  const eng = new VoiceEngine({ onPhase() {}, onPartial() {}, onBargeIn() {}, onHold() {}, onUserText() {} } as never, { ...playNow, playing: () => false } as never) as any;
  Object.assign(eng, { ptt: true, vad: { start() {}, pause() {}, setOptions() {} }, tape: { stop: async () => new Float32Array(16000).fill(0.1) } });
  tts.gate = Promise.reject(new Error("no speech model"));
  tts.gate.catch(() => {});
  expect(await eng.endPtt(true)).toBe(false);
  tts.gate = Promise.resolve();
});

it("with labels, a held thought is sent on its own when another voice speaks next", async () => {
  vp.verdicts = [you, other([0, 1, 0]), other([0, 0.9, 0.1])];
  const { eng, seen, speakers } = gated("label", "idle");
  Object.assign(eng, { replyOpen: false });
  eng.turnCfg = () => ({ threshold: 0.5, holdMs: 4000, redemptionMs: 550, engine: "smart-turn" }); // the turn model holds every segment
  for (const heard of ["No.", "now what have you", "to say"]) {
    tts.heard = heard;
    eng.onSpeechStart();
    await eng.onSpeechEnd(second);
  }
  eng.clearHold();
  expect(seen.sent).toEqual(["No."]);
  expect(speakers).toEqual(["you"]);
  expect(eng.pendingSpeaker).toBe("other 1");
  expect(eng.pending.length).toBe(2 * second.length); // the same voice's two segments still join
});

it("another voice the gate ignores, onset included, teaches the room's noise floor nothing", async () => {
  vp.verdicts = [other()];
  const { eng } = gated("gate", "idle");
  const floor = eng.noiseFloor;
  for (let i = 0; i < 10; i++) eng.onFrame(frame, false); // its first words, before the VAD is sure
  expect(eng.noiseFloor).toBeGreaterThan(floor);
  eng.onSpeechStart();
  expect(eng.noiseFloor).toBe(floor);
  for (let i = 0; i < 32; i++) eng.onFrame(frame, true);
  await new Promise((r) => setTimeout(r, 0));
  expect(eng.currentPhase()).toBe("idle"); // ignored: the engine is idle while that voice goes on
  for (let i = 0; i < 64; i++) eng.onFrame(frame, i % 2 === 0); // its words, and the gaps between them
  expect(eng.noiseFloor).toBe(floor);
  await eng.onSpeechEnd(second);
  eng.onFrame(new Float32Array(512).fill(0.004), false); // the room itself
  expect(eng.noiseFloor).toBeGreaterThan(floor);
});

it("with the voiceprint off, a segment's onset is unlearned the same, and a frame reads no settings", async () => {
  const { useVoicePrefs } = await import("../prefs");
  const reads = vi.spyOn(useVoicePrefs, "getState");
  try {
    const { eng } = overReply("idle");
    const floor = eng.noiseFloor;
    for (let i = 0; i < 10; i++) eng.onFrame(frame, true); // speech heard idle, before the VAD is sure
    const raised = eng.noiseFloor;
    expect(raised).toBeGreaterThan(floor);
    eng.onSpeechStart();
    expect(eng.noiseFloor).toBe(floor);
    reads.mockClear();
    for (let i = 0; i < 100; i++) eng.onFrame(frame, true);
    expect(reads).not.toHaveBeenCalled();
  } finally { reads.mockRestore(); }
});

/** The side talk check on for `run`, answering `side`; what it was asked comes back. */
async function withSideTalk(side: boolean, run: () => Promise<void> | void, mode: "ignore" | "shadow" = "ignore", keepLog = false) {
  Object.assign(st, { side, hang: false, asked: [], sent: [], labels: [] });
  Object.assign(DEFAULT_PIPELINE_CONFIG, { sideTalk: mode, sideTalkLog: keepLog });
  try { await run(); } finally { Object.assign(DEFAULT_PIPELINE_CONFIG, { sideTalk: "off", sideTalkLog: false }); }
  return st.asked;
}

it("side talk over the reply lets it go on, marked, however long it runs; talk to the app still cuts it", async () => {
  tts.heard = "honey, did you feed the dog before we left this morning";
  const marked: string[] = [];
  const { eng, seen } = overReply("speaking", { onSideTalk: (t: string) => marked.push(t) });
  Object.assign(eng, { spokenText: "The build passed." });
  const asked = await withSideTalk(true, async () => {
    eng.onSpeechStart();
    for (let i = 0; i < 100; i++) eng.onFrame(frame, true); // 3.2 s voiced: past the cap, the words decide
    expect(seen.cuts).toBe(0);
    await eng.onSpeechEnd(second);
  });
  expect(asked).toEqual([[tts.heard, "The build passed.", undefined]]);
  expect(seen).toMatchObject({ sent: [], cuts: 0, held: false });
  expect(marked).toEqual([tts.heard]);
  expect(eng.currentPhase()).toBe("speaking");
  tts.heard = "no wait, use the other file";
  const app = overReply();
  await withSideTalk(false, async () => { app.eng.onSpeechStart(); await app.eng.onSpeechEnd(second); });
  expect(app.seen).toMatchObject({ sent: [tts.heard], cuts: 1 });
});

it("a held sentence judged side talk is dropped when its hold ends, marked; tapped, it is sent", async () => {
  tts.heard = "can you grab the milk";
  for (const tapped of [false, true]) {
    const marked: string[] = [];
    const { eng, seen } = overReply("idle", { onSideTalk: (t: string) => marked.push(t) });
    await withSideTalk(true, async () => { eng.onSpeechStart(); await eng.onSpeechEnd(second); });
    if (tapped) eng.commitPending(); else eng.flushPending(); // the hold timer's end
    expect([seen.sent, marked]).toEqual(tapped ? [[tts.heard], []] : [[], [tts.heard]]);
  }
});

it("push-to-talk, an open ask and the setting left off never ask the side talk check", async () => {
  tts.heard = "did you feed the dog";
  const ptt = overReply("idle");
  Object.assign(ptt.eng, { vad: { start() {}, pause() {} } });
  const asks = [await withSideTalk(true, async () => { ptt.eng.beginPtt(); ptt.eng.onSpeechStart(); await ptt.eng.onSpeechEnd(second); await ptt.eng.endPtt(); })];
  expect(ptt.seen.sent).toEqual([tts.heard]);
  const ask = overReply("thinking", { holdBargeIn: () => true, answersAsk: () => true });
  asks.push(await withSideTalk(true, async () => { ask.eng.onSpeechStart(); await ask.eng.onSpeechEnd(second); }));
  expect(ask.seen.sent).toEqual([tts.heard]);
  Object.assign(st, { side: true, asked: [] });
  const off = overReply("speaking");
  off.eng.onSpeechStart();
  await off.eng.onSpeechEnd(second);
  expect(off.seen.sent).toEqual([tts.heard]);
  expect([...asks, st.asked]).toEqual([[], [], []]);
});

it("a dropped sentence tapped to send is a turn: it cuts a reply under way, and waits out the user's own talk", () => {
  const { eng, seen } = overReply("speaking");
  eng.sendAside("did you feed the dog", "you");
  expect(seen).toMatchObject({ sent: ["did you feed the dog"], cuts: 1 });
  expect(eng.currentPhase()).toBe("thinking");
  const talking = overReply("listening");
  talking.eng.sendAside("did you feed the dog");
  expect(talking.seen).toMatchObject({ sent: [], cuts: 0 });
});

it("judging only, side talk is still answered, over the reply it cuts as with the check off, and the turn never waits on the verdict", async () => {
  tts.heard = "honey, did you feed the dog";
  const marked: string[] = [];
  const { eng, seen } = overReply("speaking", { onSideTalk: (t: string) => marked.push(t) });
  const asked = await withSideTalk(true, async () => {
    st.hang = true;
    eng.onSpeechStart();
    for (let i = 0; i < 60; i++) eng.onFrame(frame, true); // past the backchannel cap: cut before the words, as with the check off
    expect(seen.cuts).toBe(1);
    await eng.onSpeechEnd(second);
  }, "shadow");
  expect(asked).toHaveLength(1);
  expect(marked).toEqual([]);
  expect(seen.sent).toEqual([tts.heard]);
});

it("with the log on, each judgment gets an id the surface keeps, with how the sentence sounded", async () => {
  tts.heard = "can you grab the milk";
  const judged: Array<string | undefined> = [];
  const { eng } = overReply("idle", { onUserText: (_t: string, _a: number[], _s?: string, id?: string) => judged.push(id) });
  Object.assign(eng, { replyOpen: false });
  const say = (keepLog: boolean) => withSideTalk(false, async () => { eng.onSpeechStart(); await eng.onSpeechEnd(second); eng.flushPending(); }, "shadow", keepLog);
  await say(true); // the turn model holds it; its hold's end sends it
  expect(st.sent[0]!.keep).toEqual({ id: judged[0], mode: "shadow" });
  expect(judged[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(st.sent[0]!.feats).toMatchObject({ durS: 1, cut: 0, gapS: null, relDb: null, change: null });
  // Judged, the sentence sets the user's level: the next one is judged against it.
  await say(true);
  expect(st.sent[0]!.feats.relDb).toBe(0);
  // With the log off, the check still hears how it sounded, but nothing is kept.
  await say(false);
  expect(st.sent[0]!.keep).toBeUndefined();
  expect(judged[2]).toBeUndefined();
});

it("the user overruling a logged verdict labels it: send now on a held one, Send it on a dropped one", async () => {
  tts.heard = "can you grab the milk";
  const marked: Array<string | undefined> = [];
  const { eng, seen } = overReply("idle", { onSideTalk: (_t: string, _s?: string, id?: string) => marked.push(id) });
  await withSideTalk(true, async () => { eng.onSpeechStart(); await eng.onSpeechEnd(second); eng.commitPending(); }, "ignore", true);
  expect(seen.sent).toEqual([tts.heard]);
  expect(st.labels).toEqual([[st.sent[0]!.keep!.id, "to"]]);
  const dropped = overReply("idle", { onSideTalk: (_t: string, _s?: string, id?: string) => marked.push(id) });
  await withSideTalk(true, async () => { dropped.eng.onSpeechStart(); await dropped.eng.onSpeechEnd(second); dropped.eng.flushPending(); }, "ignore", true);
  expect(marked).toEqual([st.sent[0]!.keep!.id]);
  st.labels = [];
  Object.assign(dropped.eng, { phase: "idle" });
  expect(dropped.eng.sendAside(tts.heard, undefined, marked[0])).toBe(true);
  expect(st.labels).toEqual([[marked[0], "to"]]);
});

it("Not for you cuts the reply under way, and does nothing once it is over", () => {
  const { eng, seen } = overReply("speaking");
  eng.dropReply();
  expect(seen.cuts).toBe(1);
  const done = overReply("idle");
  Object.assign(done.eng, { replyOpen: false });
  done.eng.dropReply();
  expect(done.seen.cuts).toBe(0);
});

// Silero trails a soft voice's onset: its first words tick along under the speech
// threshold while the engine is still idle, and must not count as the room.
it("a soft talker's own first words do not raise the noise gate over them", async () => {
  tts.heard = "can you hear me";
  const { eng } = overReply("idle");
  const soft = new Float32Array(512).fill(0.012), quiet = new Float32Array(512).fill(0.001);
  for (let i = 0; i < 60; i++) eng.onFrame(quiet, false);
  for (let i = 0; i < 20; i++) eng.onFrame(soft, false); // under the threshold, already talk
  eng.onFrame(soft, true);
  eng.onSpeechStart();
  for (let i = 0; i < 30; i++) eng.onFrame(soft, true);
  const heard = [...Array(5).fill(quiet), ...Array(51).fill(soft)];
  await eng.onSpeechEnd(eng.concat(heard, heard.length * 512));
  expect(eng.pendingText).toBe("can you hear me");
  eng.clearHold();
});

// Agent voice leaking back opens an echo segment while a user segment waits on
// the one still finalizing: the waiting words are theirs, and still heard.
it("words that waited on a finalizing segment are kept while an echo segment is open", async () => {
  let open!: () => void;
  tts.gate = new Promise((r) => (open = r));
  tts.heard = "okay so";
  const { eng } = overReply("idle");
  eng.onSpeechStart();
  const first = eng.onSpeechEnd(second);
  eng.onSpeechStart();
  await eng.onSpeechEnd(second); // deferred behind the first
  eng.player.playing = () => true; // a line starts playing
  eng.micRms = 0;
  eng.onSpeechStart(); // its echo
  expect(eng.echo).toBe(true);
  open();
  await first;
  await vi.waitFor(() => expect(eng.pending?.length).toBe(2 * second.length));
  expect(eng.echo).toBe(true); // the echo segment's own end is still dropped
  eng.clearHold();
  tts.gate = Promise.resolve();
});

// The voiced time picks the voiceprint's threshold: audio replayed after a
// finalizing segment is judged on its own, not on the segment open by then.
it("deferred segments are judged on their own voiced time", async () => {
  let open!: () => void;
  tts.gate = new Promise((r) => (open = r));
  tts.heard = "okay so";
  vp.verdicts = []; vp.asked = [];
  const { eng } = gated("label");
  const say = (frames: number) => { eng.onSpeechStart(); for (let i = 0; i < frames; i++) eng.onFrame(frame, true); };
  say(10);
  const first = eng.onSpeechEnd(second);
  for (const frames of [20, 5]) { say(frames); await eng.onSpeechEnd(second); } // deferred behind the first
  say(40); // still open when the deferred audio is replayed
  open();
  await first;
  await vi.waitFor(() => expect(vp.asked).toEqual([10 * 32, 25 * 32]));
  eng.clearHold();
  tts.gate = Promise.resolve();
});
