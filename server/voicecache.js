// Sakhi's fixed lines (about 124 scripted phrases), kept between server starts so a restart doesn't pay Sarvam
// to generate them again (about ₹15 each time). Each clip is stored under a hash of its text, language, pace,
// voice and model, so changing the voice regenerates them automatically. Only the fixed lines are kept:
// lines the AI writes during a conversation may contain a learner's name or details, and stay in memory only.
//   Production: Cloud Storage (VOICE_CACHE_BUCKET). Development: a folder (VOICE_CACHE_DIR). Otherwise off.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gcsDownload, gcsUpload } from './gcp.js';

const BUCKET = process.env.VOICE_CACHE_BUCKET || '';
const DIR = process.env.VOICE_CACHE_DIR || '';
export const voiceCacheEnabled = () => !!(BUCKET || DIR);
const name = (key) => `voice/${key}.pcm`;

/** A stored clip (raw PCM), or null. Never throws: a broken store just means generating again. */
export async function load(key) {
  try {
    if (BUCKET) return await gcsDownload(BUCKET, name(key));
    if (DIR) return await readFile(join(DIR, name(key)));
  } catch { /* not stored yet, or the store is unreachable */ }
  return null;
}

export async function save(key, pcm) {
  if (BUCKET) return gcsUpload(BUCKET, name(key), pcm, 'application/octet-stream');
  if (DIR) { await mkdir(join(DIR, 'voice'), { recursive: true }); await writeFile(join(DIR, name(key)), pcm); }
}
