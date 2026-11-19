// Voice recordings: the learner's audio already passes through the server on its way to Sarvam (live.js), so
// the server keeps each answer's audio, compresses it to Opus (about 15× smaller than raw), and stores it:
// Cloud Storage in production (RECORDINGS_BUCKET), a local folder in development (RECORDINGS_DIR), or nowhere.
// Kept with no expiry; removed only when a customer asks for their data to be erased.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { gcsUpload, gcsDelete } from './gcp.js';

const BUCKET = process.env.RECORDINGS_BUCKET || '';
const DIR = process.env.RECORDINGS_DIR || '';
export const recordingEnabled = () => !!(BUCKET || DIR);

const RATE = 16000;
const MAX_SEC = 180; // one answer's audio is never more than this (the app caps answers at 45 s)

/** Mic audio for a conversation (PCM16 16 kHz mono), collected until the answer is sent. */
export function collect(s, pcm) {
  if (!recordingEnabled()) return;
  s.rec ||= { chunks: [], bytes: 0 };
  if (s.rec.bytes >= MAX_SEC * RATE * 2) return;
  s.rec.chunks.push(Buffer.from(pcm)); s.rec.bytes += pcm.length;
}

/** Take what's been collected (and start afresh). */
export function take(s) {
  const r = s.rec; s.rec = null;
  return r?.bytes ? Buffer.concat(r.chunks) : null;
}

/** PCM16 16 kHz mono → Ogg Opus (voice-tuned, 24 kbps). */
export function toOpus(pcm) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-f', 'ogg', 'pipe:1']);
    const out = [], err = [];
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.on('data', (c) => err.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`))));
    ff.stdin.end(pcm);
  });
}

/** Store one answer's audio. → { storagePath, codec, durationSec, bytes } */
export async function store({ userId, sessionId, seq, pcm }) {
  const opus = await toOpus(pcm);
  const storagePath = `users/${userId}/tests/${sessionId}/${String(seq).padStart(3, '0')}-${Date.now()}.opus`;
  if (BUCKET) await gcsUpload(BUCKET, storagePath, opus, 'audio/ogg');
  else {
    const file = normalize(join(DIR, storagePath));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, opus);
  }
  return { storagePath, codec: 'opus', durationSec: +(pcm.length / 2 / RATE).toFixed(2), bytes: opus.length };
}

export async function remove(storagePath) {
  if (BUCKET) return gcsDelete(BUCKET, storagePath);
  if (DIR) await rm(normalize(join(DIR, storagePath)), { force: true });
}
