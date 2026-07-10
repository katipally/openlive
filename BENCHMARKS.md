# Benchmarks

The number that decides whether a voice agent feels alive is voice-to-voice
latency: the gap between you finishing a sentence and the app starting to speak
its reply. This page defines how we measure it and holds the results. Every number
here comes from a real run on real hardware. If a cell is empty, it has not been
measured yet, and nothing here is an estimate dressed up as a result.

## What we measure

A turn breaks into three stages. The first and third run on your device; only the
middle one leaves the machine.

| Stage | What it covers | Where it runs |
|---|---|---|
| stt + endpoint | transcribe the final utterance (Whisper) and decide the turn is over (Smart-Turn) | on device |
| model | provider time to the first token of the reply | your model API |
| tts | synthesize and start playing the first audio (Kokoro) | on device |

**voice-to-voice = stt+endpoint + model + tts.** Deliberate "wait for them to
finish talking" pauses are not counted, because those are a choice, not latency.

## How to reproduce

The app instruments every turn. To collect your own numbers:

1. Start a call and open the developer console (View menu, or Cmd+Opt+I on macOS).
2. Filter the console for `[live:perf]`.
3. Have a normal back-and-forth, at least 10 turns, so medians mean something.
4. Run `openlivePerf.summary()` in the console. It prints a table of p50 and p95
   for each stage and for voice-to-voice across the session. `openlivePerf.reset()`
   clears it.

Each turn also logs a line as it happens, for example:

```
[live:perf] turn 7: stt+endpoint 210ms · model 480ms · tts 320ms · voice-to-voice 1010ms
```

## Results

Measured with WebGPU enabled (the default on supported machines). Fill a row per
configuration you test. Report p50 and p95 in milliseconds.

| Device | Model / provider | Effort | Turns | stt+endpoint (p50 / p95) | model (p50 / p95) | tts (p50 / p95) | voice-to-voice (p50 / p95) |
|---|---|---|---|---|---|---|---|
| _e.g. M2 MacBook Air_ | _claude-haiku / Anthropic_ | low | | | | | |
| | | | | | | | |

To add your run: paste the `openlivePerf.summary()` output into a row above and
open a pull request, or send it in an issue.

## What moves the numbers

- **WebGPU vs CPU.** The on-device stages fall back to WASM on CPU when WebGPU is
  unavailable, which is several times slower. The console notes which path is
  active.
- **Model and effort.** A smaller, lower-effort model returns its first token
  faster, which usually dominates the model stage.
- **Provider and network.** The model stage includes the round trip to your
  provider, so your connection and their current load both show up here.
- **First call warmup.** The voice models download and initialize once. Skip the
  first turn or two after a cold start before you record.
