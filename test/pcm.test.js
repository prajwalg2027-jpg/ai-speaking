import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResampler } from '../public/pcm.js';

const sine = (n, rate, f, t0 = 0) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * f * ((t0 + i) / rate)));

for (const rate of [48000, 44100, 16000]) {
  test(`resampler ${rate} → 16000 keeps duration and signal across chunk boundaries`, () => {
    const r = createResampler(rate);
    const chunk = 2048, chunks = 50;
    let total = 0, maxErr = 0, outIdx = 0;
    for (let c = 0; c < chunks; c++) {
      const pcm = r(sine(chunk, rate, 440, c * chunk));
      for (const s of pcm) {
        const expected = 0.5 * Math.sin(2 * Math.PI * 440 * (outIdx / 16000));
        maxErr = Math.max(maxErr, Math.abs(s / 0x7fff - expected));
        outIdx++;
      }
      total += pcm.length;
    }
    const expectedLen = (chunk * chunks * 16000) / rate;
    assert.ok(Math.abs(total - expectedLen) <= 2, `length ${total} vs ${expectedLen}`);
    assert.ok(maxErr < 0.02, `max error ${maxErr}`);
  });
}
