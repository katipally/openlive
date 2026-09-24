// Raw PCM helpers shared by the routes, the ASR socket, and the worker. Pure,
// so the worker bundle stays free of the agent's other imports.

export const SAMPLE_RATE = 16_000;

/** Raw little-endian Float32 PCM bytes as samples (copied, so aligned and
 *  transferable to the worker). Null when the byte count is not whole samples. */
export function pcmFromBytes(bytes: Uint8Array): Float32Array | null {
  if (bytes.byteLength % 4) return null;
  return new Float32Array(new Uint8Array(bytes).buffer); // not bytes.slice(): on a Buffer that is a view into a shared pool
}

export const pcmBytes = (s: Float32Array) => new Uint8Array(s.buffer, s.byteOffset, s.byteLength);

// Measured 2026-09-24: the moonshine export returns nothing for clips of ~9 s
// or more, so longer audio is cut into windows of at most 8 s, each ending at
// the quietest 20 ms frame of its last 3 s. O(n) over the samples.
export function splitAtPauses(samples: Float32Array): Float32Array[] {
  const max = 8 * SAMPLE_RATE;
  const frame = SAMPLE_RATE / 50;
  const search = 3 * SAMPLE_RATE;
  const out: Float32Array[] = [];
  let start = 0;
  while (samples.length - start > max) {
    const end = start + max;
    let cut = end, quietest = Infinity;
    for (let f = end - search; f + frame <= end; f += frame) {
      let energy = 0;
      for (let i = f; i < f + frame; i++) energy += samples[i]! ** 2;
      if (energy < quietest) { quietest = energy; cut = f + frame / 2; }
    }
    out.push(samples.subarray(start, cut));
    start = cut;
  }
  out.push(samples.subarray(start));
  return out;
}

// Measured 2026-09-24 over 64 kitten sentences (8 voices): peaks reach 1.08
// (median 0.77), so it clips; pocket stays under 0.92. A streamed chunk cannot
// know the peak of the chunks still to come, so an over-loud chunk is scaled down
// to the ceiling and nothing is ever scaled up: chunks that did not clip keep
// their level, and the rare one that did drops by at most about 1 dB.
const PEAK_CEILING = 0.95;

/** Scale `samples` in place so no sample exceeds PEAK_CEILING. O(n). */
export function limitPeak(samples: Float32Array): Float32Array {
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  if (peak <= PEAK_CEILING) return samples;
  const gain = PEAK_CEILING / peak;
  for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! * gain;
  return samples;
}
