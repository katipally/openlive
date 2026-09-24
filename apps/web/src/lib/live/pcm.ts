// Raw PCM plumbing for the native voice engines. Pure, so it is unit-tested.

/** Decodes a stream of little-endian Float32 bytes whose network chunks can end
 *  mid-sample: the 1-3 trailing bytes are carried into the next chunk. One copy
 *  per chunk, O(bytes). */
export function pcmDecoder(): (bytes: Uint8Array) => Float32Array {
  let carry = new Uint8Array(0);
  return (bytes) => {
    // A fresh buffer is 4-byte aligned, which a Float32Array view requires.
    const all = new Uint8Array(carry.length + bytes.length);
    all.set(carry);
    all.set(bytes, carry.length);
    const whole = all.length - (all.length % 4);
    carry = all.slice(whole);
    return new Float32Array(all.buffer, 0, whole / 4);
  };
}
