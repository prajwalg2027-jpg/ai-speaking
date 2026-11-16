// HTTP server: static files, /api proxy to Sarvam, and the /api/live realtime STT relay.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, demoMode } from './config.js';
import * as sarvam from './sarvam.js';
import { attachLiveRelay } from './live.js';
import { createGate } from './auth.js';
import { detectClarification, isUnintelligible, looksTruncated } from './clarify.js';
import { features, heuristicScores, blend, provisionalLevel, finalLevel } from './scoring.js';
import { JUDGE_SYSTEM, judgeUser, INTENT_SYSTEM, REPLY_SYSTEM } from './prompts.js';
import { QUESTIONS, variantFor } from '../shared/assessment.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const DEVANAGARI = /[ऀ-ॿ]/;

const gate = createGate(config.appPassword);

const readBody = async (req, limit = 8 * 1024 * 1024) => {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('Payload too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
};
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

/**
 * Evaluate one answer. Transport-independent: called with a transcript that came from
 * REST STT (WAV upload), Realtime STT (already transcribed in the browser session), or demo mode.
 */
export async function evaluateTurn({ qIndex, level, transcript, languageCode = null, englishMeaning = null, speechSec = 0, prior = '' }) {
  const question = QUESTIONS[qIndex];
  if (!question) throw Object.assign(new Error('bad question index'), { status: 400 });
  const variant = variantFor(question, level);
  transcript = [prior, transcript].filter(Boolean).join(' ').trim();

  // 1. Did we fail to understand the user?
  if (isUnintelligible(transcript)) return { action: 'didnt_hear', transcript };
  if (looksTruncated(transcript, speechSec)) return { action: 'cut_off', transcript };

  // 2. Hindi / code-mixed answer: get the English meaning (if the transport didn't already).
  if (!englishMeaning && !demoMode() && DEVANAGARI.test(transcript)) {
    englishMeaning = await sarvam.translateToEnglish(transcript).catch((e) => (console.warn(e.message), null));
  }

  // 3. Is the user asking us to clarify?
  let intent = detectClarification(englishMeaning || transcript) || detectClarification(transcript);
  if (!intent && !demoMode() && transcript.split(/\s+/).length <= 4 && question.kind !== 'vocab') {
    // Ambiguous short reply: ask the LLM (skip for vocab, where 1-2 word answers are normal).
    intent = (await sarvam.chatJSON([{ role: 'system', content: INTENT_SYSTEM },
      { role: 'user', content: `Tutor asked: ${variant.say}\nLearner replied: ${transcript}` }], { temperature: 0, maxTokens: 30 }).catch(() => null))?.intent;
    if (intent === 'answer' || intent === 'off_topic') intent = null;
  }
  if (intent) return { action: 'clarify', intent, transcript };

  // 4. Score it (LLM judge + acknowledgment in parallel).
  const f = features(transcript, { speechSec, kind: question.kind, reference: variant.screen, expect: variant.expect });
  const heur = heuristicScores(f, question.kind);
  let llm = null, ack = null;
  if (!demoMode()) {
    [llm, ack] = await Promise.all([
      sarvam.chatJSON([{ role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: judgeUser({ question: variant.say, transcript, englishMeaning, features: f, kind: question.kind, reference: question.kind === 'read' ? variant.screen : null }) }]).catch((e) => (console.warn(e.message), null)),
      question.id === 'q1_intro'
        ? sarvam.chat([{ role: 'system', content: REPLY_SYSTEM }, { role: 'user', content: englishMeaning || transcript }],
          { temperature: 0.6, maxTokens: 60, model: config.sarvam.llmReplyModel }).catch(() => null)
        : null,
    ]);
  }
  const scores = blend(llm, heur);
  const out = { action: 'scored', transcript, englishMeaning, languageCode, features: f, scores, llmNote: llm?.note ?? null, ack };
  if (question.id === 'q1_intro') out.provisionalLevel = provisionalLevel(f, scores);
  return out;
}

// ---- /api/turn ------------------------------------------------------------
// Query: q (question index), level (variant level), speechSec, prior (text to prepend after a cut-off).
// Body: audio/wav (REST STT path) or JSON {transcript, languageCode} (Realtime and demo paths).
async function handleTurn(req, res, url) {
  const args = {
    qIndex: Number(url.searchParams.get('q')),
    level: Number(url.searchParams.get('level') || 2),
    speechSec: Number(url.searchParams.get('speechSec') || 0),
    prior: url.searchParams.get('prior') || '',
  };
  const body = await readBody(req);
  if ((req.headers['content-type'] || '').startsWith('application/json')) {
    const j = JSON.parse(body.toString() || '{}');
    args.transcript = String(j.transcript || '');
    args.languageCode = j.languageCode || null;
  } else {
    if (demoMode()) return send(res, 400, { error: 'demo mode expects a JSON transcript' });
    ({ transcript: args.transcript, languageCode: args.languageCode } = await sarvam.transcribe(body));
    // Hindi / mixed answer: Saaras translate mode on the same audio gives the English meaning.
    if (args.transcript && DEVANAGARI.test(args.transcript)) {
      args.englishMeaning = (await sarvam.transcribeToEnglish(body).catch(() => null))?.transcript ?? null;
    }
  }
  send(res, 200, await evaluateTurn(args));
}

async function handleTTS(req, res) {
  const { text, lang = 'en-IN', pace = 1 } = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
  if (demoMode()) return send(res, 200, { demo: true });
  if (!text || text.length > 2500) return send(res, 400, { error: 'text required (max 2500 chars)' });
  send(res, 200, { audio: await sarvam.speak(text, { lang, pace }) });
}

async function handleFinal(req, res) {
  const { answers } = JSON.parse((await readBody(req, 512 * 1024)).toString() || '{}');
  if (!Array.isArray(answers)) return send(res, 400, { error: 'answers[] required' });
  send(res, 200, finalLevel(answers));
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'public/index.html' : pathname.startsWith('/shared/') ? pathname.slice(1) : `public${pathname}`;
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (await gate.handle(req, res, url)) return; // /login, /healthz, or not signed in
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { demo: demoMode(), realtime: !demoMode() && config.sarvam.realtime.enabled });
    }
    if (req.method === 'POST' && url.pathname === '/api/turn') return await handleTurn(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/tts') return await handleTTS(req, res);
    if (req.method === 'POST' && url.pathname === '/api/final') return await handleFinal(req, res);
    if (req.method === 'GET') return await serveStatic(res, url.pathname);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, e.status || 502, { error: e.name === 'AbortError' ? 'Upstream timeout' : e.message });
  }
});

attachLiveRelay(server, { enabled: () => !demoMode() && config.sarvam.realtime.enabled, authorize: gate.check });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(config.port, () => console.log(`AI English Coach on http://localhost:${config.port}` +
    `${demoMode() ? '  (demo mode: no SARVAM_API_KEY)' : ''}${gate.enabled ? '  (password required)' : ''}`));
}
