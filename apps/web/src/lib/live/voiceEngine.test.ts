import { expect, it, vi } from "vitest";

vi.mock("@ricky0123/vad-web", () => ({ MicVAD: class {} }));
// A streaming engine: the sentence's audio in two chunks, a tick apart.
const tts = vi.hoisted(() => ({ chunks: [] as Float32Array[], calls: 0, heard: "", at: [] as number[], gate: Promise.resolve() }));
// Speech-to-text hears `tts.heard` at `tts.at`, and the turn model calls it unfinished.
vi.mock("./models", () => ({
  resetNativeFallbacks() {},
  async ttsStream(_text: string, _o: unknown, onChunk: (a: Float32Array, rate: number) => void, signal?: AbortSignal) {
    tts.calls++;
    for (const c of tts.chunks) { if (signal?.aborted) return; onChunk(c, 24000); await new Promise((r) => setTimeout(r, 5)); }
  },
  stt: async () => { await tts.gate; return { text: tts.heard, at: tts.at }; },
  turnModelReady: () => true,
  turnComplete: async () => false,
  activeSttEngine: () => "whisper",
  hasWebGPU: () => false,
}));
vi.mock("./asrStream", () => ({ AsrStream: class {} }));
vi.mock("@/lib/log", () => ({ log: { debug() {}, info() {}, warn() {}, error() {} } }));
const { VoiceEngine } = await import("./voiceEngine");

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

const playNow = { level: () => 0, playing: () => true, flush() {}, close() {}, hold() {}, release() {}, play: (_a: unknown, _e: unknown, _r: unknown, onStart?: () => void) => onStart?.() };

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
