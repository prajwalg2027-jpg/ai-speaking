// The cost counter at the top: what this conversation has cost so far in Sarvam charges (estimated, ₹).
// The server keeps the ledger (server/costs.js); this polls it every second while the conversation runs, and
// also takes the totals that come back with each turn.
const $ = (id) => document.getElementById(id);
const inr = (v, d = 2) => `₹${v.toFixed(d)}`;
const n = (v) => (v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : v.toLocaleString('en-IN'));
const PURPOSE = { understand: 'reading each reply', scoring: 'scoring answers', tutor: "writing Sakhi's lines", other: 'other' };

let timer = null, last = null;

export function startCostMeter(sessionId) {
  stopCostMeter();
  $('cost').hidden = false;
  render({ totalInr: 0 });
  const poll = async () => {
    try {
      const r = await fetch(`/api/session/cost?id=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
      if (r.ok) render(await r.json());
    } catch { /* keep the last value */ }
  };
  poll();
  timer = setInterval(poll, 1000);
  return poll;
}

/** Stop polling a few seconds after the conversation ends (calls still finishing are counted). */
export function stopCostMeter(afterMs = 0) {
  const t = timer;
  timer = null;
  if (t) setTimeout(() => clearInterval(t), afterMs);
}

export function render(c) {
  if (!c) return;
  last = c;
  $('costTotal').textContent = inr(c.totalInr ?? 0);
  if (!c.stt) return;
  const p = c.prices;
  const purposes = Object.entries(c.llm.byPurpose || {}).sort((a, b) => b[1].inr - a[1].inr)
    .map(([k, v]) => `<li><span>${PURPOSE[k] || k} · ${v.calls} call${v.calls === 1 ? '' : 's'}</span><b>${inr(v.inr, 3)}</b></li>`).join('');
  $('costDetail').innerHTML = `
    <ul>
      <li><span>Hearing (speech-to-text) · ${c.stt.seconds.toFixed(1)} s of audio</span><b>${inr(c.stt.inr, 3)}</b></li>
      <li><span>Voice (Bulbul) · ${n(c.tts.chars)} characters, ${c.tts.calls} line${c.tts.calls === 1 ? '' : 's'}${c.tts.cachedCalls ? ` (+${c.tts.cachedCalls} from cache, free)` : ''}</span><b>${inr(c.tts.inr, 3)}</b></li>
      <li><span>AI (Sarvam-105B) · ${c.llm.calls} calls, ${n(c.llm.input + c.llm.cached)} in / ${n(c.llm.output)} out tokens${c.llm.reasoning ? ` (${n(c.llm.reasoning)} reasoning)` : ''}</span><b>${inr(c.llm.inr, 3)}</b></li>
      ${purposes ? `<li class="sub"><ul>${purposes}</ul></li>` : ''}
      <li class="total"><span>Total</span><b>${inr(c.totalInr, 3)}</b></li>
    </ul>
    <p>Estimate, excluding GST. Rates (${p.asOf}): speech ₹${p.sttPerHour}/hour of audio, voice ₹${p.ttsPer10kChars} per 10,000 characters,
    AI ₹${p.llmPerMillion.input} input / ₹${p.llmPerMillion.cached} cached / ₹${p.llmPerMillion.output} output per million tokens.
    Lines already in the server's voice cache cost nothing here.</p>`;
}

export function initCostMeter() {
  $('cost').addEventListener('click', () => {
    const d = $('costDetail');
    d.hidden = !d.hidden || !last?.stt;
    $('cost').setAttribute('aria-expanded', String(!d.hidden));
  });
}
