// Streaming resampler: Float32 mic frames at any rate → Int16 PCM at 16 kHz (mono).
// Stateful, so frame boundaries don't cause clicks or drift (e.g. 44.1 kHz → 16 kHz isn't an integer ratio).

export function createResampler(srcRate, dstRate = 16000) {
  const step = srcRate / dstRate;
  let pos = 0; // fractional read position into the (virtual) concatenated input
  let last = 0; // last sample of the previous chunk, for interpolation across the boundary
  return function resample(input) {
    const out = [];
    // pos is relative to the start of `input`; index -1 refers to `last`.
    // Interpolating at pos needs input[floor(pos) + 1], so stop one sample early; the rest carries over.
    while (pos < input.length - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? last : input[i];
      const b = input[i + 1];
      out.push(a + (b - a) * frac);
      pos += step;
    }
    last = input[input.length - 1] ?? last;
    pos -= input.length;
    const pcm = new Int16Array(out.length);
    for (let k = 0; k < out.length; k++) {
      const x = Math.max(-1, Math.min(1, out[k]));
      pcm[k] = x < 0 ? x * 0x8000 : x * 0x7fff;
    }
    return pcm;
  };
}
