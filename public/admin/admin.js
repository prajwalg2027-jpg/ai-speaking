// Adam admin console: dashboard, live settings, playground (A vs B), evaluations, conversations, lessons, team.
// What each person sees follows their role's permissions; the server checks every request itself.
// Plain modules, no build step. Talks to /api/admin (server/admin/api.js). Everything shown from learners is
// escaped (html`` below), never inserted as markup.

// ---- tiny helpers ----------------------------------------------------------------------------------
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v == null || v === false ? '' : esc(v));
const html = (strings, ...vals) => raw(strings.reduce((a, s, i) => a + s + (i < vals.length ? fmt(vals[i]) : ''), ''));
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const main = $('#main');
const show = (content) => { main.innerHTML = fmt(content); };
const n0 = (x) => (x == null ? '–' : Number(x).toLocaleString('en-IN'));
const ms = (x) => (x == null ? '–' : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const inr = (x, d = 2) => (x == null ? '–' : `₹${Number(x).toFixed(d)}`);
const pct = (x) => (x == null ? '–' : `${x}%`);
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
const dayLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const humanize = (k) => String(k).replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function toast(text) {
  const t = $('#toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

// Hover tooltips: any element with data-tip.
const tip = $('#tooltip');
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - r.width - 8, e.clientX + 12)}px`;
  tip.style.top = `${Math.max(8, e.clientY - r.height - 10)}px`;
});

// ---- sign-in and API -------------------------------------------------------------------------------
// Sign-in: by an SMS code through this server (MSG91). The session token is kept for this browser tab only
// (sessionStorage), never in the page's address.
const TOKEN_KEY = 'adam.admin.token';
const tokenStore = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(v) { try { if (v) sessionStorage.setItem(TOKEN_KEY, v); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};
const bearer = () => tokenStore.get();

async function api(path, { method = 'GET', body } = {}) {
  const headers = body ? { 'content-type': 'application/json' } : {};
  const token = bearer();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api/admin${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.reason || data.error || res.statusText), { status: res.status });
  return data;
}

async function post(path, body, token) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.reason || data.error || res.statusText), { status: res.status });
  return data;
}

async function signOut() {
  const t = tokenStore.get();
  tokenStore.set(null);
  if (t) await post('/api/auth/logout', {}, t).catch(() => {});
  location.reload();
}

let me = { permissions: [] };
const can = (p) => me.permissions.includes(p);
// The permission each page needs.
const NEEDS = { overview: 'dashboard.view', settings: 'settings.view', playground: 'playground.use', models: 'playground.use', voices: 'playground.use', evals: 'evals.view', conversations: 'conversations.view', lessons: 'lessons.view', team: 'team.manage' };

async function boot() {
  const cfg = await fetch('/api/admin/config').then((r) => r.json());
  if (cfg.loginRequired && cfg.login === 'otp') {
    if (!tokenStore.get()) return otpLoginPage();
  } else if (cfg.loginRequired) {
    return show(html`<div class="card login"><h1>Sign-in isn't set up</h1><p>This server has no SMS sign-in (MSG91). See <code>deploy/msg91-setup.sh</code>.</p></div>`);
  }
  const signedIn = cfg.loginRequired;
  try {
    me = await api('/me');
    $('#who').innerHTML = fmt(html`<span>${me.phone === 'local' ? 'Local development (no login)' : me.name || me.phone} · <span class="badge">${me.roleName}</span></span>${signedIn ? html`<button class="link" id="signout">Sign out</button>` : ''}`);
    $('#signout')?.addEventListener('click', signOut);
  } catch (e) {
    if (e.status === 401 && cfg.login === 'otp') { tokenStore.set(null); return otpLoginPage(); }
    if (e.status === 403 && signedIn) return show(html`<div class="card login"><h1>No access</h1><p>${e.message}</p><button id="out">Use another number</button></div>`), $('#out').addEventListener('click', signOut);
    return show(html`<div class="card login"><h1>Can't open the console</h1><p class="err">${e.message}</p></div>`);
  }
  for (const a of $$('#nav a')) a.hidden = !can(NEEDS[a.getAttribute('href').slice(1)]);
  $('#nav').hidden = false;
  window.addEventListener('hashchange', route);
  route();
}

const loginForm = () => html`<div class="card login">
    <h1>Admin sign-in</h1>
    <p class="muted">Use the phone number on the admin list. We'll send you a code by SMS.</p>
    <form id="step1"><label class="f">Phone number<input id="phone" type="tel" value="+91 " autocomplete="tel" required></label><p></p><button class="primary" id="send" type="submit">Send code</button></form>
    <form id="step2" hidden><label class="f">Code from the SMS<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required></label><p></p>
      <div class="row end"><button class="primary" type="submit">Sign in</button><button type="button" class="link" id="again">Send the code again</button></div></form>
    <p class="err" id="lerr" role="alert"></p></div>`;

function otpLoginPage() {
  show(loginForm());
  let requestId = null;
  const busy = (form, on) => { for (const b of $$('button', form)) b.disabled = on; };
  $('#step1').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#lerr').textContent = ''; busy(e.target, true);
    try { ({ requestId } = await post('/api/auth/otp/send', { phone: $('#phone').value })); $('#step1').hidden = true; $('#step2').hidden = false; $('#code').focus(); }
    catch (x) { $('#lerr').textContent = x.message; } finally { busy(e.target, false); }
  });
  $('#again').addEventListener('click', async () => {
    $('#lerr').textContent = '';
    try { await post('/api/auth/otp/resend', { requestId }); toast('Sent again'); } catch (x) { $('#lerr').textContent = x.message; }
  });
  $('#step2').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#lerr').textContent = ''; busy(e.target, true);
    try { const s = await post('/api/auth/otp/verify', { requestId, code: $('#code').value.trim(), client: 'admin' }); tokenStore.set(s.token); location.reload(); }
    catch (x) { $('#lerr').textContent = x.message; busy(e.target, false); }
  });
}

const PAGES = { overview, settings, playground, models, voices: voicesPage, evals, conversations, lessons, team };
async function route() {
  const first = Object.keys(PAGES).find((k) => can(NEEDS[k]));
  if (!first) return show(html`<div class="card"><h2>Nothing to show yet</h2><p class="muted">Your role (${me.roleName}) doesn't include any pages. Ask an owner.</p></div>`);
  let [name, arg] = (location.hash.slice(1) || first).split('/');
  if (!(name in PAGES)) name = first;
  if (!can(NEEDS[name])) return show(html`<div class="card"><h2>Not in your role</h2><p class="muted">Your role (${me.roleName}) doesn't include this page.</p></div>`);
  const page = PAGES[name];
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${name}`));
  show(html`<p class="muted"><span class="spin"></span> Loading…</p>`);
  charts.clear();
  try { await page(arg && decodeURIComponent(arg)); }
  catch (e) { show(html`<div class="card"><h2>Something went wrong</h2><p class="err">${e.message}</p></div>`); }
}

// ---- charts ----------------------------------------------------------------------------------------
function niceMax(v) { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; }
/** Columns over time: one series, thin rounded bars anchored to the baseline, hover for the value.
 *  Drawn at the slot's real pixel width (drawCharts), so the 11px labels stay 11px at any size. */
function columnsSvg(W, days, values, unit) {
  const H = 150, L = 28, B = 20, T = 8;
  const max = niceMax(Math.max(...values, 1)), pw = W - L, step = pw / values.length, bw = Math.max(2, Math.min(28, step - 2));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const bars = values.map((v, i) => {
    const x = L + i * step + (step - bw) / 2, top = y(v), base = H - B, r = Math.min(4, bw / 2, base - top);
    const path = v > 0 ? `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z` : '';
    return `<g class="col"><rect class="hit" x="${L + i * step}" y="${T}" width="${step}" height="${H - T - B}" data-tip="${esc(`${dayLabel(days[i])}: ${n0(v)} ${unit}`)}"></rect>${path ? `<path class="bar" d="${path}"></path>` : ''}</g>`;
  }).join('');
  const grid = ticks.map((t) => `<line class="${t === 0 ? 'baseline' : 'gridline'}" x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"></line><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${Number.isInteger(t) ? t : t.toFixed(1)}</text>`).join('');
  const xl = [[0, 'start'], [Math.floor(values.length / 2), 'middle'], [values.length - 1, 'end']]
    .map(([i, a]) => `<text x="${a === 'start' ? L + i * step : a === 'end' ? L + (i + 1) * step : L + i * step + step / 2}" y="${H - 5}" text-anchor="${a}">${esc(dayLabel(days[i]))}</text>`).join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)} per day">${grid}${bars}${xl}</svg>`;
}
const charts = new Map();
let chartId = 0;
/** A placeholder that drawCharts() fills once the page is laid out. */
function columns(days, values, unit) { const id = `c${++chartId}`; charts.set(id, { days, values, unit }); return raw(`<div class="chart-slot" data-chart="${id}"></div>`); }
function drawCharts() {
  for (const el of $$('[data-chart]')) { const c = charts.get(el.dataset.chart); if (c && el.clientWidth) el.innerHTML = columnsSvg(el.clientWidth, c.days, c.values, c.unit); }
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });
const dataTable = (days, values, unit) => html`<details class="small"><summary class="muted">Show as a table</summary><div class="table-wrap"><table><tr><th>Day</th><th class="num">${humanize(unit)}</th></tr>${days.map((d, i) => html`<tr><td>${dayLabel(d)}</td><td class="num">${n0(values[i])}</td></tr>`)}</table></div></details>`;
function hbars(rows, { label = (r) => r.label, value = (r) => r.n } = {}) {
  if (!rows.length) return html`<p class="muted small">Nothing yet.</p>`;
  const max = Math.max(...rows.map(value), 1);
  return rows.map((r) => html`<div class="hbar"><span>${label(r)}</span><span class="track"><i style="width:${(100 * value(r)) / max}%" data-tip="${label(r)}: ${n0(value(r))}"></i></span><span class="n">${n0(value(r))}</span></div>`);
}

// ---- Overview -------------------------------------------------------------------------------------
const LEVEL_NAMES = { 1: 'Level 1 · beginner', 2: 'Level 2 · basic', 3: 'Level 3 · good', 4: 'Level 4 · very good' };
async function overview() {
  const o = await api('/overview');
  const t = o.totals, s = o.series, sp = o.spend, lat = o.latency;
  const spentPct = sp.budgetInr ? Math.min(100, (100 * sp.todayInr) / sp.budgetInr) : 0;
  const chart = (title, values, unit) => html`<div class="card chart"><h2>${title}</h2>${columns(s.days, values, unit)}${dataTable(s.days, values, unit)}</div>`;
  show(html`
    <div class="page-head"><div><h1>Overview</h1><p class="muted">Tutor: ${o.llm.tutor.provider} · ${o.llm.tutor.model} · corrections: ${o.strategy === 'verify' ? 'B (with check)' : 'A (one call)'}</p></div><button id="refresh">Refresh</button></div>
    <div class="grid g4 section">
      <div class="card tile"><div class="label">Learners</div><div class="value">${n0(t.learners)}</div><div class="sub">+${n0(t.newLearners7d)} in the last 7 days</div></div>
      <div class="card tile"><div class="label">Active learners (7 days)</div><div class="value">${n0(t.activeLearners7d)}</div><div class="sub">sent a practice message</div></div>
      <div class="card tile"><div class="label">Practice messages (24 h)</div><div class="value">${n0(t.messages24h)}</div><div class="sub">${n0(t.lessonsCompleted7d)} lessons finished in 7 days</div></div>
      <div class="card tile"><div class="label">Spend today</div><div class="value">${inr(sp.todayInr)}</div><div class="sub">of ${inr(sp.budgetInr, 0)} daily budget</div><div class="meter ${spentPct > 80 ? 'warn' : ''}"><i style="width:${spentPct}%"></i></div></div>
    </div>
    <div class="grid g4 section">
      <div class="card tile"><div class="label">Reply time, typical</div><div class="value">${ms(lat?.replyP50)}</div><div class="sub">slowest 5%: ${ms(lat?.replyP95)} · last 24 h</div></div>
      <div class="card tile"><div class="label">With corrections checked</div><div class="value">${ms(lat?.totalP50)}</div><div class="sub">slowest 5%: ${ms(lat?.totalP95)}</div></div>
      <div class="card tile"><div class="label">Placement tests (7 days)</div><div class="value">${n0(t.tests7d)}</div><div class="sub">finished</div></div>
      <div class="card tile"><div class="label">Corrections shown (7 days)</div><div class="value">${n0(t.corrections7d)}</div><div class="sub">over ${n0(t.replies7d)} replies · ${n0(o.quality?.droppedByCheck)} stopped by the check</div></div>
    </div>
    ${o.payments ? html`<div class="grid g4 section">
      <div class="card tile"><div class="label">Subscribers</div><div class="value">${n0(o.payments.activeSubscribers)}</div><div class="sub">${o.payments.required ? html`paywall on · ₹${o.payments.priceInr}/month` : 'paywall off (Settings › Payments)'}${o.payments.testMode && o.payments.configured ? ' · Razorpay TEST mode' : ''}${o.payments.configured === false ? ' · Razorpay not set up' : ''}</div></div>
      <div class="card tile"><div class="label">Revenue this month</div><div class="value">${inr((o.payments.revenueThisMonthPaise || 0) / 100, 0)}</div><div class="sub">captured payments, before fees and GST</div></div>
      <div class="card tile"><div class="label">Cancelled (30 days)</div><div class="value">${n0(o.payments.cancelled30d)}</div><div class="sub">subscriptions</div></div>
    </div>` : ''}
    <div class="grid g2 section">
      ${chart('Practice messages per day', s.messages, 'messages')}
      ${chart('Active learners per day', s.activeLearners, 'learners')}
      ${chart('Placement tests per day', s.tests, 'tests')}
      ${chart('New sign-ups per day', s.signups, 'sign-ups')}
    </div>
    <div class="grid g2 section">
      <div class="card"><h2>Learners by placement level</h2>${hbars(o.levels, { label: (r) => LEVEL_NAMES[r.level] })}</div>
      <div class="card"><h2>Most common mistakes (7 days)</h2>${hbars(o.mistakes, { label: (r) => humanize(r.concept) })}</div>
    </div>
    ${o.tests30d ? html`<div class="grid g2 section">
      <div class="card"><h2>Where placement tests are left (30 days)</h2>${hbars(o.dropOff || [], { label: (r) => (r.answers ? `After ${r.answers} answer${r.answers === 1 ? '' : 's'}` : 'Before the first answer') })}</div>
      <div class="card"><h2>Placement tests (30 days)</h2>
        <p>${n0(o.tests30d.started)} started · ${n0(o.tests30d.finished)} finished (${o.tests30d.started ? Math.round((100 * o.tests30d.finished) / o.tests30d.started) : 0}%)</p>
        <p>${n0(o.tests30d.resumed)} carried on after a break · ${n0(o.tests30d.finishedAfterBreak)} of them finished</p>
        <p class="muted small">A test counts as left when it is abandoned (the learner started over, or didn't come back within Settings › Limits) or has had no answer for an hour.</p>
      </div>
    </div>` : ''}
    <p class="muted small">Spend is counted by this server since midnight (India time); AI cost in the last 24 h from saved replies: ${inr(lat?.costInr)}. Check errors (7 days): ${n0(o.quality?.checkErrors)}.</p>`);
  drawCharts();
  $('#refresh').addEventListener('click', route);
}

// ---- Settings -------------------------------------------------------------------------------------
const ORDER = ['voice', 'placement', 'payments', 'corrections', 'llm', 'conversation', 'memory', 'limits', 'features', 'scoring'];
const JOBS = { tutor: 'Tutor replies', verify: 'Correction check (strategy B)', lessonEval: 'Lesson marking', memory: 'Memory notes and personal greetings' };
const EFFORT_OPTIONS = [['default', "The model's own default"], ['none', 'None (fastest)'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Most (slowest)']];
const TAKES_THINKING = ['openai', 'anthropic', 'gemini']; // the providers that can be told how hard to think
const META = {
  'corrections.strategy': { type: 'choice', label: 'How corrections are made', options: [
    ['single', 'A · One call', 'The tutor replies and proposes corrections in one call; the correction rules filter them. Fastest and cheapest.'],
    ['verify', 'B · One call + a check', 'When the tutor proposes corrections, a second call checks each one before the learner sees it. The reply is not delayed (it is sent first); corrections arrive a moment later.']] },
  'corrections.defaultIntensity': { type: 'select', label: 'Default correction intensity', help: 'For new learners; each learner can change theirs in the app.', options: [['gentle', 'Gentle: only mistakes that change the meaning (1 per reply)'], ['balanced', 'Balanced: clear grammar and word mistakes'], ['strict', 'Strict: most mistakes, including small ones']] },
  'corrections.voiceSafe': { type: 'bool', label: "For spoken messages, don't correct slips that speech-to-text could have caused (a/an/the, -s, -ed endings, spelling)" },
  'corrections.maxPerReply': { label: 'Most corrections shown per reply' },
  'placement.mode': { type: 'choice', label: 'Kind of placement test', options: [
    ['classic', 'Classic test', 'Five parts: about you, words, listening, reading, speaking. About five minutes.'],
    ['conversation', 'Conversation', 'Name, a picture, a line to read, then open questions for those who can go on, with a gentle tip after each answer. About two minutes.']] },
  'placement.brain': { label: 'AI for the conversation (every turn, the level and the feedback)' },
  'placement.summary': { label: 'Backup AI for the closing feedback (only if the first leaves the level out)' },
  'placement.maxQuestions': { label: 'Most open questions in a conversation', help: '1 to 6, after the name, picture and reading. The talk ends sooner when the level is clear.' },
  'placement.speed': { type: 'select', label: 'OpenAI speed', help: "Fast is OpenAI's Fast mode: up to 2.5 times quicker, at about twice the price per token. Only some OpenAI models have it (gpt-6-luna does); others answer at standard speed.", options: [['fast', 'Fast (dearer)'], ['standard', 'Standard']] },
  'placement.turnEffort': { type: 'select', label: 'Thinking on each turn', help: 'How hard the model thinks before Sakhi replies. Less is faster. Used by OpenAI, Claude and Gemini models; Sarvam ignores it.', options: EFFORT_OPTIONS },
  'placement.finalEffort': { type: 'select', label: 'Thinking for the final level and feedback', help: 'If the AI ends the talk on a turn with less thinking than this, that turn is asked once more at this level.', options: EFFORT_OPTIONS },
  'voice.source': { type: 'select', label: 'Where the voice comes from', help: 'Both Google routes are billed to the Google Cloud project (credits pay for them). If a Google voice fails, Sarvam says that line.', options: [
    ['gemini', 'Google Gemini voice, through Vertex AI (default)'], ['cloudtts', 'Google voice, through Cloud Text-to-Speech (Gemini 2.5 models, or Chirp 3 HD)'], ['sarvam', 'Sarvam Bulbul (Roopa)']] },
  'voice.model': { type: 'select', label: 'Voice model (Google)', help: 'Must match where the voice comes from. Prices are on the Compare voices page.', options: [
    ['gemini-3.8-flash-lite-tts', 'Vertex AI · Gemini 3.8 Flash-Lite TTS (fast, cheapest)'], ['gemini-3.8-flash-tts', 'Vertex AI · Gemini 3.8 Flash TTS (best quality)'], ['gemini-3.1-flash-tts-preview', 'Either · Gemini 3.1 Flash TTS (preview)'],
    ['gemini-2.5-flash-tts', 'Cloud Text-to-Speech · Gemini 2.5 Flash TTS'], ['gemini-2.5-flash-lite-preview-tts', 'Cloud Text-to-Speech · Gemini 2.5 Flash-Lite TTS (preview)'], ['gemini-2.5-pro-tts', 'Cloud Text-to-Speech · Gemini 2.5 Pro TTS'],
    ['chirp3-hd', 'Cloud Text-to-Speech · Chirp 3 HD (not Gemini: same voice names, no style, about ₹2 a minute, 1 million characters free a month, higher rate limit)']] },
  'voice.voice': { label: 'Voice name (Google)', help: 'One of Google’s voices, e.g. Sulafat (warm), Vindemiatrix (gentle), Achernar (soft), Kore (firm), Aoede (breezy), Leda (youthful). Hear them on Compare voices.' },
  'voice.style': { label: 'How she speaks (Google)', help: 'In plain words. Avoid “patiently” or “slowly”: Gemini voices hear them as “speak slowly”. Chirp 3 HD ignores this.' },
  'voice.speed': { label: 'Speed (Google)', help: '1 is Google’s own speed; 1.15 is a little quicker, 1.3 quick. Cloud Text-to-Speech takes the number; Vertex AI is told “brisk” above 1.1. Questions said again are 10% slower. A change makes her fixed lines again (Compare voices has the same Pace box to try it first).' },
  'voice.fallbackToSarvam': { type: 'bool', label: 'If the Google voice fails, Sarvam says the line' },
  'voice.oneRequestPerTurn': { type: 'bool', label: 'One voice request per turn: join each turn’s lines (Google voices). Fewer requests a minute (the free trial allows 10); she starts speaking a little later' },
  'conversation.historyMessages': { label: 'Recent messages the tutor reads', help: 'More = better memory of the conversation, slightly slower and costlier.' },
  'memory.enabled': { type: 'bool', label: 'Sakhi remembers each learner (facts, goals, coming events, past conversations). Off: practice works as before' },
  'memory.everyMessages': { label: 'Memory note after this many learner messages', help: 'Also when the learner starts a new conversation or says "forget". Lower = fresher memory, a little more AI cost.' },
  'memory.maxItems': { label: 'Most things remembered per learner', help: 'Past this, the least important old items fade.' },
  'memory.inPrompt': { label: 'Remembered things Sakhi reads on each turn' },
  'memory.pastConversations': { label: 'Earlier conversations Sakhi recalls (summaries)' },
  'memory.personalGreeting': { type: 'bool', label: 'Open a new conversation with something Sakhi remembers (one small AI call; the plain greeting if it fails)' },
  'memory.keepSummariesDays': { label: 'Keep conversation summaries for (days)' },
  'limits.dailyBudgetInr': { label: 'Daily budget (₹)', help: 'When today’s AI spend reaches this, new conversations and messages pause until tomorrow.' },
  'limits.sessionsPerIpPerHour': { label: 'Placement tests per learner per hour' },
  'limits.turnsPerSession': { label: 'Turns in one placement test' },
  'limits.listenSecPerSession': { label: 'Listening seconds per placement test' },
  'limits.learnMessagesPerDay': { label: 'Practice messages per learner per day' },
  'limits.resumeHours': { label: 'Hours a learner can carry on a test they left (0: always start again)' },
  'payments.enabled': { type: 'bool', label: 'Learning needs a subscription (the paywall is on)' },
  'payments.priceInr': { label: 'Price per month (₹)', help: 'A new price makes a new Razorpay plan; people already subscribed keep their price.' },
  'payments.gstPercent': { label: 'GST in the price (%)', help: 'For the amounts reported to Google Play when someone pays with Razorpay through Play’s screen. 0 while you’re not GST-registered (under ₹20 lakh a year); 18 once registered.' },
  'features.learningModule': { type: 'bool', label: 'Learning module (practice conversations and lessons) is on' },
  'scoring.levelCutoffs': { label: 'Level cut-offs (overall score needed)' },
  'scoring.firstGuess': { label: 'First guess after the opening answer' },
  'scoring.judgeWeight': { label: 'How much the AI judge counts, per skill (0 = not at all, 1 = only the judge)' },
};
for (const j of [...Object.keys(JOBS).map((k) => `llm.${k}`), 'placement.brain', 'placement.summary']) {
  if (j.startsWith('llm.')) META[j] = { label: JOBS[j.slice(4)] };
  META[`${j}.temperature`] = { label: 'Temperature', help: 'Lower = more consistent; higher = more varied.', step: 0.1 };
}
// AI providers, in the order they're offered, with the names people know them by.
const PROVIDERS = { sarvam: 'Sarvam', anthropic: 'Claude (Anthropic)', openai: 'OpenAI', gemini: 'Gemini' };
const providerName = (p, v) => `${PROVIDERS[p] || p}${v?.via ? ` (${v.via})` : ''}`; // v: the server's word on it, e.g. Gemini through Vertex AI

function field(path, value, providers) {
  const m = META[path] || {}, key = path.split('.').pop();
  const label = m.label || humanize(key);
  if (path.endsWith('.provider')) {
    return html`<label class="f">Provider<select data-path="${path}" data-type="string">${Object.entries(providers).map(([p, v]) => html`<option value="${p}" ${p === value ? raw('selected') : ''} ${!v.configured && p !== value ? raw('disabled') : ''}>${p === 'sarvam' ? 'Sarvam (default)' : providerName(p, v)}${v.configured ? '' : ' (no API key on the server)'}</option>`)}</select></label>`;
  }
  if (path.endsWith('.model') && m.type !== 'select') return html`<label class="f">Model<input data-path="${path}" data-type="string" value="${value}" list="models"></label>`;
  if (m.type === 'choice') return html`<div class="choices" role="radiogroup" aria-label="${label}">${m.options.map(([v, t, d]) => html`<label class="choice"><input type="radio" name="${path}" data-path="${path}" data-type="radio" value="${v}" ${v === value ? raw('checked') : ''}><div><strong>${t}</strong><span>${d}</span></div></label>`)}</div>`;
  if (m.type === 'select') return html`<label class="f">${label}<select data-path="${path}" data-type="string">${m.options.map(([v, t]) => html`<option value="${v}" ${v === value ? raw('selected') : ''}>${t}</option>`)}</select>${m.help ? html`<span class="help">${m.help}</span>` : ''}</label>`;
  if (typeof value === 'boolean') return html`<label class="check"><input type="checkbox" data-path="${path}" data-type="bool" ${value ? raw('checked') : ''}> ${label}</label>`;
  if (typeof value === 'number') return html`<label class="f">${label}<input type="number" step="${m.step || 'any'}" data-path="${path}" data-type="number" value="${value}">${m.help ? html`<span class="help">${m.help}</span>` : ''}</label>`;
  return html`<label class="f">${label}<input data-path="${path}" data-type="string" value="${value}">${m.help ? html`<span class="help">${m.help}</span>` : ''}</label>`;
}
function fields(path, value, providers) {
  const leaves = [], groups = [];
  for (const [k, v] of Object.entries(value)) {
    const p = `${path}.${k}`;
    if (v && typeof v === 'object' && !Array.isArray(v)) groups.push(html`<div class="fieldset"><h3>${META[p]?.label || humanize(k)}</h3>${fields(p, v, providers)}</div>`);
    else if (!Array.isArray(v)) leaves.push(field(p, v, providers));
  }
  return html`<div class="row">${leaves}</div>${groups}`;
}
function readForm(form, start) {
  const out = structuredClone(start);
  for (const el of $$('[data-path]', form)) {
    if (el.dataset.type === 'radio' && !el.checked) continue;
    const parts = el.dataset.path.split('.').slice(1);
    let o = out; for (const p of parts.slice(0, -1)) o = o[p];
    o[parts.at(-1)] = el.dataset.type === 'number' ? Number(el.value) : el.dataset.type === 'bool' ? el.checked : el.value;
  }
  return out;
}
function diff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diff(a[k], b[k], path ? `${path}.${k}` : k));
  return [`${path || 'value'}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
}

async function settings() {
  const [s, h] = await Promise.all([api('/settings'), api('/settings/history')]);
  const sections = ORDER.filter((k) => s.sections[k]).map((k) => {
    const sec = s.sections[k];
    return html`<form class="card section" data-key="${k}">
      <div class="section-head"><h2>${sec.label}</h2><span>${sec.changed ? html`<span class="badge on">changed from default</span>` : html`<span class="badge">default</span>`}</span></div>
      ${k === 'llm' ? html`<p class="muted small">Sarvam is the default for everything. Another provider can be chosen only when its API key is set on the server (in Secret Manager); keys never appear here.</p>` : ''}
      ${k === 'voice' ? html`<p class="muted small">The voice of every line Sakhi says in the app. A change applies to new lines at once (already-made lines in another voice are made again the first time they're needed). Try voices first on the <a href="#voices">Compare voices</a> page.</p>` : ''}
      ${k === 'placement' ? html`<p class="muted small">New tests use the chosen kind; a test in progress keeps its kind. Try models first on the <a href="#models">Compare models</a> page.</p>` : ''}
      ${k === 'scoring' ? html`<p class="muted small">The placement test's scoring. Changes apply to tests started from now on; each test stores the cut-offs it used.</p>` : ''}
      ${fields(k, sec.value, s.providers)}
      <p class="err" data-err></p>
      <div class="row"><button class="primary" type="submit">Save</button>${sec.changed ? html`<button type="button" data-reset>Reset to default</button>` : ''}</div>
    </form>`;
  });
  show(html`
    <div class="page-head"><div><h1>Settings</h1><p class="muted">Changes apply within seconds on every server, with no deploy. Every change is recorded below.${can('settings.edit') ? '' : html` <strong>Read only:</strong> your role (${me.roleName}) can't change settings.`}</p></div></div>
    ${Object.entries(s.models || {}).map(([p, list]) => html`<datalist id="models-${p}">${list.map((m) => html`<option value="${m}">`)}</datalist>`)}
    ${sections}
    <div class="card"><h2>Change history</h2>${h.changes.length ? html`<div class="table-wrap"><table><tr><th>When</th><th>Section</th><th>By</th><th>What changed</th></tr>${h.changes.map((c) => html`<tr><td>${when(c.changed_at)}</td><td>${s.sections[c.key]?.label || c.key}</td><td>${c.changed_by || '–'}</td><td class="small">${diff(c.old_value, c.new_value).slice(0, 6).map((d) => html`<div>${d}</div>`)}</td></tr>`)}</table></div>` : html`<p class="muted">No changes yet.</p>`}</div>`);
  // Each model box offers the models of the provider chosen beside it (the server asks each provider for its list).
  for (const input of $$('input[data-path$=".model"]')) {
    const prov = $(`select[data-path="${input.dataset.path.replace(/\.model$/, '.provider')}"]`);
    const link = () => input.setAttribute('list', `models-${prov?.value || 'sarvam'}`);
    link(); prov?.addEventListener('change', link);
  }
  if (!can('settings.edit')) for (const form of $$('form[data-key]')) { for (const el of $$('input, select, textarea', form)) el.disabled = true; for (const b of $$('button', form)) b.hidden = true; }
  for (const form of $$('form[data-key]')) {
    const key = form.dataset.key;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('[data-err]', form); err.textContent = '';
      const value = readForm(form, s.sections[key].value);
      const btn = $('button[type=submit]', form); btn.disabled = true;
      try { await api(`/settings/${key}`, { method: 'PUT', body: { value } }); toast(`${s.sections[key].label}: saved and applied`); route(); }
      catch (x) { err.textContent = x.message; btn.disabled = false; }
    });
    $('[data-reset]', form)?.addEventListener('click', async () => {
      if (!confirm(`Put "${s.sections[key].label}" back to the defaults?`)) return;
      try { await api(`/settings/${key}/reset`, { method: 'POST' }); toast('Back to the defaults'); route(); } catch (x) { $('[data-err]', form).textContent = x.message; }
    });
  }
}

// ---- Playground -----------------------------------------------------------------------------------
const corrBox = (c) => html`<div class="corr"><span class="was">${c.original}</span> → <strong>${c.corrected}</strong> <span class="badge">${humanize(c.concept || c.category)}</span> <span class="badge">${c.severity}</span><div class="why">${c.explanation}</div></div>`;
const droppedBox = (d) => html`<div class="corr dropped"><span class="was">${d.correction?.original ?? d.original}</span> → ${d.correction?.corrected ?? d.corrected}<div class="why">Not shown: ${d.reason}</div></div>`;
function side(title, s, note) {
  return html`<div class="card"><h2>${title}</h2><p class="muted small">${note}</p>
    <h3>The learner sees ${s.corrections.length} correction${s.corrections.length === 1 ? '' : 's'}</h3>
    ${s.corrections.length ? s.corrections.map(corrBox) : html`<p class="muted small">None.</p>`}
    ${s.dropped.length ? html`<details><summary class="small muted">${s.dropped.length} not shown</summary>${s.dropped.map(droppedBox)}</details>` : ''}
    <p class="small muted">Time: ${ms(s.ms)}${s.checkMs != null ? html` (check ${ms(s.checkMs)})` : ''} · AI cost ${inr(s.costInr, 3)}${s.checkError ? html` · <span class="err">check failed: ${s.checkError}</span>` : ''}</p></div>`;
}
async function playground() {
  show(html`
    <div class="page-head"><div><h1>Playground</h1><p class="muted">Try a learner message and see what the tutor says, with strategies A and B side by side from the same reply. Nothing is saved.</p></div></div>
    <form class="card section" id="pg">
      <label class="f">The learner says<textarea id="msg" maxlength="1000" placeholder="Yesterday I go to market with my friend and we buyed vegetables.">Yesterday I go to market with my friend and we buyed vegetables.</textarea></label>
      <div class="row end" style="margin-top:10px">
        <label class="f">How<select id="channel"><option value="text">Typed</option><option value="voice">Spoken (speech-to-text)</option></select></label>
        <label class="f">Correction intensity<select id="intensity"><option value="gentle">Gentle</option><option value="balanced" selected>Balanced</option><option value="strict">Strict</option></select></label>
        <label class="f">Learner level<select id="level"><option value="1">1 · beginner</option><option value="2" selected>2 · basic</option><option value="3">3 · good</option><option value="4">4 · very good</option></select></label>
        <button class="primary" type="submit">Run</button>
      </div>
    </form>
    <div id="out"></div>`);
  $('#pg').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('#out'); out.innerHTML = fmt(html`<p class="muted"><span class="spin"></span> Asking the tutor…</p>`);
    try {
      const r = await api('/playground', { method: 'POST', body: { message: $('#msg').value, channel: $('#channel').value, intensity: $('#intensity').value, level: Number($('#level').value) } });
      out.innerHTML = fmt(html`
        <div class="card section"><h2>Sakhi replies</h2><div class="bubble tutor">${r.reply}</div>
          ${r.encouragement ? html`<p class="small muted">Encouragement: ${r.encouragement}</p>` : ''}
          <p class="small muted">${r.meta.provider} · ${r.meta.model} · prompt ${r.meta.promptVersion} · reply in ${ms(r.meta.replyMs)}</p>
          <details><summary class="small muted">The tutor proposed ${r.proposed.length} correction${r.proposed.length === 1 ? '' : 's'} (before any rules)</summary>${r.proposed.map(corrBox)}</details></div>
        <div class="compare">${side('A · One call', r.compare.single, 'Shown after the correction rules.')}${side('B · One call + a check', r.compare.verify, 'Shown after the rules and the check.')}</div>`);
    } catch (x) { out.innerHTML = fmt(html`<p class="err">${x.message}</p>`); }
  });
}

// ---- Compare models (the conversation placement test) ---------------------------------------------
// Each model runs its own conversation placement, side by side, end to end (server/admin/placementLab.js).
// Type or speak what a learner says. For every AI call the page keeps the exact request and answer ("View log"),
// how much of the request was reused from cache, the thinking where the provider shares it, speed and cost.
// Nothing is saved.
const LEVEL_WORDS = { 1: 'Beginner', 2: 'Basic', 3: 'Good', 4: 'Very good' };
const LEARNER_EVENTS = { no_speech: '(said nothing)', skip: '(skipped)', in_hindi: '(asked for Hindi)' };
let labPicks = null; // { models: [{provider, model, price?}] }: kept for "Start again" and later visits

const lines = (list) => list.filter(Boolean).map((l) => html`<p>${l}</p>`);
const tokens = (u) => (u && (u.input || u.output) ? `${n0(u.input)} in${u.cached ? ` (${n0(u.cached)} reused)` : ''} · ${n0(u.output)} out${u.reasoning ? ` (${n0(u.reasoning)} thinking)` : ''}` : '–');
const reusedPct = (u) => (u?.input ? Math.round((100 * (u.cached || 0)) / u.input) : null);
const speedCost = (x) => html`<p class="small muted lab-meta">Speed ${ms(x.ms)}${x.replyMs != null ? ` (her reply was ready at ${ms(x.replyMs)})` : ''} · cost ${inr(x.costInr, 3)}${x.effort && x.effort !== 'default' ? ` · thinking: ${x.effort}` : ''}${servedAt(x)}<br>Tokens: ${tokens(x.usage)}</p>`;
/** The speed OpenAI really served a call at, when Fast mode was asked for or used. */
const servedAt = (x) => (x.tier === 'fast' || x.tier === 'priority' ? ' · Fast mode' : x.askedFast ? ' · Fast mode asked for, served at standard speed and price' : '');
/** What a turn costs besides the AI: speech-to-text for the learner's words (h) and Sakhi's voice (v). */
const speechCost = (h, v) => html`<p class="small muted lab-meta">${h ? html`Speech-to-text: ${h.seconds} s${h.estimated ? ' (estimated from the words)' : ''} · ${inr(h.inr, 3)}<br>` : ''}Voice: ${n0(v.chars)} characters${v.fixedChars ? ` (and ${n0(v.fixedChars)} in fixed lines, free)` : ''} · ${inr(v.inr, 3)}</p>`;
/** Adds a turn's speech-to-text and voice to a model's running total. */
function addSpeech(t, h, v) {
  if (h) { t.sttSec += h.seconds; t.sttInr += h.inr; if (h.estimated) t.sttEstimated = true; }
  if (v) { t.voiceChars += v.chars; t.voiceInr += v.inr; }
}
/** Adds one AI call to a model's running total for the talk. */
function addUse(t, x) {
  if (!x || x.ms == null) return;
  t.calls++; t.ms += x.ms || 0;
  if (x.replyMs != null) { t.replies++; t.replyMs += x.replyMs; }
  if (x.costInr == null) t.priced = false; else t.cost += x.costInr;
  for (const k of ['input', 'cached', 'output', 'reasoning']) t[k] += x.usage?.[k] || 0;
}
const newTotals = () => ({ sttSec: 0, sttInr: 0, sttEstimated: false, voiceChars: 0, voiceInr: 0, replies: 0, replyMs: 0, calls: 0, ms: 0, cost: 0, priced: true, input: 0, cached: 0, output: 0, reasoning: 0 });
const totalLine = (t) => (t.calls ? html`<h3>The whole talk</h3><p class="small">${t.calls} AI call${t.calls === 1 ? '' : 's'} · ${ms(t.ms)} in all<br>Tokens: ${tokens(t)}</p>
  <table class="lab-costs"><tr><td>AI</td><td class="num">${t.priced ? inr(t.cost, 3) : '–'}</td></tr>
  <tr><td>Speech-to-text (${t.sttSec.toFixed(1)} s${t.sttEstimated ? ', partly estimated' : ''})</td><td class="num">${inr(t.sttInr, 3)}</td></tr>
  <tr><td>Voice (${n0(t.voiceChars)} characters)</td><td class="num">${inr(t.voiceInr, 3)}</td></tr>
  <tr><th>In all</th><th class="num">${t.priced ? inr(t.cost + t.sttInr + t.voiceInr, 3) : '–'}</th></tr></table>
  ${t.priced ? '' : html`<p class="small muted">Add this model's price to see the AI cost and the total.</p>`}` : '');

const STEP_NAMES = { hello: 'Hello', picture: 'Picture', read: 'Reading', open: 'Open question' };
const stepName = (q) => (q ? `${STEP_NAMES[q.step] || q.step}${q.step === 'open' ? ` ${q.n}` : ''}` : 'Goodbye');
function progressLine(q) {
  return !q ? '' : q.step === 'hello' ? 'Now: asking their name'
    : q.step === 'picture' ? `Now: a picture on their screen (${q.screen}). Say or type what they call it`
    : q.step === 'read' ? `Now: a line on their screen to read out loud: "${q.screen}". Say or type what they read`
    : `Now: open question ${q.n}`;
}

const HAPPENED = { answered: 'Answered', asked_for_help: 'Asked for help', could_not: "Couldn't do it", something_else: 'Said something else', gave_up: 'Gave up' };
const PICTURE = { named: 'Picture named', not_named: 'Picture not named' };
const READING = { well: 'Read it well', partly: 'Read part of it', not: 'Did not read it' };
/** What one model judged on a turn: what happened, the picture or reading, the level, why, the fix, speed, tokens and cost. */
function labAi(x) {
  if (x.aiFailed) return html`<div class="lab-ai"><p class="err small">The AI did not answer (${x.aiFailed}). The app's own checks and fixed lines were used.</p></div>`;
  if (!x.ai) return html`<p class="small muted lab-fixed">Her own words again, no AI call.</p>`;
  const a = x.ai;
  return html`<div class="lab-ai"><p><span class="badge">${HAPPENED[a.happened] || a.happened}</span>
      ${a.picture ? html` <span class="badge on">${PICTURE[a.picture]}</span>` : ''}${a.reading ? html` <span class="badge on">${READING[a.reading]}</span>` : ''}
      ${a.level != null ? html` <span class="badge on">Level ${a.level} · ${LEVEL_WORDS[a.level] || ''}</span>` : ''}${a.finish ? html` <span class="badge">Ends the talk</span>` : ''}</p>
    ${a.evidence ? html`<p class="small">${a.evidence}</p>` : ''}
    ${a.tip ? html`<div class="corr"><span class="was">${a.tip.said}</span> → <strong>${a.tip.better}</strong></div>` : ''}
    ${x.dropped?.length ? html`<p class="small muted">Not said (${x.dropped.join('; ')}). A fixed line was used.</p>` : ''}
    ${speedCost(a)}
    ${x.final ? html`<p class="small"><span class="badge">Final evaluation, asked again</span> The model ended the talk here, so the level and feedback were asked for once more with more thinking${x.final.ai.finish && x.final.ai.level != null ? '' : ' (that answer did not finish the talk, so the first was kept)'}.</p>${speedCost(x.final.ai)}` : ''}
    ${x.finalFailed ? html`<p class="small muted">The final evaluation with more thinking failed (${x.finalFailed}); the turn's own answer was used.</p>` : ''}</div>`;
}

// ---- the microphone: record, then Sarvam turns it into words (as in the app) --------------------------
/** Mono samples at any rate → 16 kHz (each output sample is the average of the input samples it covers). */
function to16k(samples, rate) {
  if (rate === 16000) return samples;
  const out = new Float32Array(Math.floor((samples.length * 16000) / rate)), step = rate / 16000;
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * step), to = Math.min(samples.length, Math.max(from + 1, Math.floor((i + 1) * step)));
    let sum = 0; for (let j = from; j < to; j++) sum += samples[j];
    out[i] = sum / (to - from);
  }
  return out;
}
/** 16 kHz mono samples → a WAV file (16-bit). */
function wavOf(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const text = (at, t) => { for (let i = 0; i < t.length; i++) v.setUint8(at + i, t.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}
/** Start recording. → { stop(): Promise<{ wav, seconds }> } */
async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), chunks = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ctx.destination);
  return { async stop() {
    proc.disconnect(); src.disconnect(); for (const t of stream.getTracks()) t.stop();
    const rate = ctx.sampleRate; await ctx.close();
    const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    const s = to16k(all, rate);
    return { wav: wavOf(s), seconds: s.length / 16000 };
  } };
}
async function transcribe(wav, language) {
  const token = await bearer();
  const res = await fetch(`/api/admin/placement-lab/transcribe${language ? `?language=${language}` : ''}`, { method: 'POST', headers: { 'content-type': 'audio/wav', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: wav });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.reason || data.error || res.statusText);
  return data;
}

// ---- the log: every AI call's exact request and answer -------------------------------------------------
// Who a message in the log is from. The server's own lines ("[System] ...") are system messages for OpenAI and marked user messages for the others.
const ROLE = (m, i, all) => (m.role === 'assistant' ? 'Sakhi' : i === 0 && m.role === 'system' ? 'Fixed instructions'
  : m.role === 'system' || /^\[(System\]|Note from the app)/.test(m.content) ? (/^\[System\] (RECORDED|STEP)/.test(m.content) ? 'System: the step' : /^\[System\] MEASURED/.test(m.content) ? 'System: measured' : /^\[System\] CUT OFF/.test(m.content) ? 'System: cut off' : 'System')
  : i === 1 && all[0].role === 'system' && /^\(/.test(m.content) ? 'Start' : 'Learner');
/**
 * Which messages were reused from cache. Providers say only HOW MANY input tokens were reused, not which; reuse
 * always starts at the top of the request, so each message is marked by where it falls by length. An estimate.
 */
function reuseMarks(messages, usage) {
  const total = messages.reduce((n, m) => n + m.content.length, 0), share = usage?.input ? (usage.cached || 0) / usage.input : 0;
  let at = 0;
  return messages.map((m) => { const start = at / total, end = (at += m.content.length) / total; return share <= 0 ? 'new' : end <= share + 0.01 ? 'reused' : start < share ? 'partly' : 'new'; });
}
const pretty = (raw) => { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw || ''; } };
const REUSE_WORDS = { reused: 'reused from cache', partly: 'partly reused', new: 'new, not reused' };
function logCall(c) {
  const u = c.ai?.usage, log = c.log;
  const head = html`<h3>Call ${c.n} · ${c.at}${c.ai ? html` <span class="muted small">${ms(c.ai.ms)} · ${inr(c.ai.costInr, 4)}${c.ai.effort && c.ai.effort !== 'default' ? ` · thinking: ${c.ai.effort}` : ''}${servedAt(c.ai)}${c.ai.firstTextMs != null ? ` · first words of the answer at ${ms(c.ai.firstTextMs)}` : ''}${c.ai.replyMs != null ? ` · her reply ready at ${ms(c.ai.replyMs)}` : ''}</span>` : ''}</h3>
    <p class="small"><strong>Learner:</strong> ${c.learner}${c.heard ? html` <span class="muted">(spoken, ${c.heard.audioSec} s; Sarvam took ${ms(c.heard.ms)} to hear it)</span>` : ''}</p>`;
  const speech = c.voice ? speechCost(c.stt, c.voice) : '';
  if (!log) return html`<div class="log-call">${head}<p class="small muted">${c.aiFailed ? `The AI did not answer: ${c.aiFailed}. The app's own checks and fixed lines were used.` : 'No AI call on this turn.'}</p>
    <h4>What Sakhi said</h4><div class="log-box">${lines(c.say)}</div>${speech}</div>`;
  const marks = reuseMarks(log.messages, u), pct = reusedPct(u);
  return html`<div class="log-call">${head}
    ${u ? html`<div class="log-bar" title="Input tokens: reused from cache and new"><i class="reused" style="flex:${u.cached || 0}"></i><i class="fresh" style="flex:${Math.max(0, (u.input || 0) - (u.cached || 0))}"></i></div>
      <p class="small">Input ${n0(u.input)} tokens: <strong>${n0(u.cached || 0)} reused from cache${pct != null ? ` (${pct}%)` : ''}</strong>, ${n0((u.input || 0) - (u.cached || 0))} new. Output ${n0(u.output)} tokens${u.reasoning ? `, of which ${n0(u.reasoning)} were thinking` : ''}.${log.attempts > 1 ? ' The first answer was not valid, so the model was asked again (both are counted).' : ''}</p>` : ''}
    <h4>Request: exactly what was sent</h4>
    ${log.messages.map((m, i, all) => html`<div class="log-msg ${marks[i]}"><div class="log-role"><span>${ROLE(m, i, all)}</span><span class="log-reuse">${REUSE_WORDS[marks[i]]}</span></div>
      ${i === 0 && m.role === 'system' ? html`<details><summary class="small">Show the fixed instructions (${n0(m.content.length)} characters, the same on every call)</summary><pre>${m.content}</pre></details>` : html`<pre>${m.content}</pre>`}</div>`)}
    <h4>Thinking</h4>
    ${log.thinking ? html`<div class="log-box"><pre>${log.thinking}</pre></div><p class="small muted">A summary from the provider; the full thinking is never shared.</p>`
      : html`<p class="small muted">${u?.reasoning ? `The model used ${n0(u.reasoning)} thinking tokens, but this provider did not share a summary of them.` : 'None reported for this call.'}</p>`}
    <h4>Response: exactly what came back</h4><div class="log-box"><pre>${pretty(log.raw)}</pre></div>
    <p class="small muted">The answer is kept as short as it can be, and anything that does not apply is left out. <strong>h</strong> what happened (a answered, h asked for help, c could not, s something else, g gave up) · <strong>p</strong> picture (y named, n not) · <strong>rd</strong> reading (w well, p partly, n not) · <strong>lv</strong> level · <strong>ev</strong> why · <strong>tip</strong> [their words, the right way] · <strong>n</strong> name · <strong>r</strong> her reply · <strong>q</strong> her question · <strong>f</strong> the final level and feedback (lv, why, good, next, bye).</p>
    <h4>What Sakhi said</h4><div class="log-box">${lines(c.say)}</div>${speech}
    ${c.dropped?.length ? html`<p class="small muted">Not said (${c.dropped.join('; ')}). A fixed line was used.</p>` : ''}</div>`;
}
/** The same log as plain text, to copy. */
function logText(model, calls) {
  return [`${model}: ${calls.length} turns`, ...calls.map((c) => [
    `\n===== Call ${c.n} · ${c.at}${c.ai ? ` · ${ms(c.ai.ms)} · tokens ${tokens(c.ai.usage)} · cost ${inr(c.ai.costInr, 4)}` : ''} =====`,
    `Learner: ${c.learner}`,
    ...(c.log ? [...c.log.messages.map((m, i, all) => `\n--- ${ROLE(m, i, all)} [${m.role}] ---\n${m.content}`), ...(c.log.thinking ? [`\n--- Thinking (summary) ---\n${c.log.thinking}`] : []), `\n--- Response ---\n${pretty(c.log.raw)}`]
      : [c.aiFailed ? `The AI did not answer: ${c.aiFailed}` : 'No AI call on this turn.']),
    `\n--- What Sakhi said ---\n${c.say.join('\n')}`,
    ...(c.voice ? [`\n--- Speech ---\n${c.stt ? `Speech-to-text: ${c.stt.seconds} s${c.stt.estimated ? ' (estimated)' : ''}, ${inr(c.stt.inr, 4)}. ` : ''}Voice: ${c.voice.chars} characters, ${inr(c.voice.inr, 4)}.`] : []),
  ].join('\n'))].join('\n');
}

async function models() {
  const info = await api('/placement-lab');
  const provs = [...Object.keys(PROVIDERS).filter((p) => p in info.providers), ...Object.keys(info.providers).filter((p) => !(p in PROVIDERS))];
  const ok = (p) => !!info.providers[p]?.configured;
  const sugg = (p) => info.suggestions?.[p] || [];
  if (!labPicks?.models) labPicks = { models: (info.defaults?.length ? info.defaults : [{ provider: 'sarvam', model: 'sarvam-105b-conversations' }]).map((m) => ({ ...m })) };
  // The listed price of a model, in words (US dollars per million tokens; Sarvam's is in rupees).
  const priceOf = (p, model, speed) => {
    const pr = info.prices || {}, fastUsd = p === 'openai' && speed === 'fast' && pr.openaiFast?.[model], usd = fastUsd || pr[p]?.[model] || Object.entries(pr[p] || {}).filter(([k]) => model.startsWith(`${k}-`)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
    const per = (x, sign) => `${sign}${x.input} input · ${x.cached != null ? `${sign}${x.cached} reused input · ` : ''}${sign}${x.output} output, per million tokens`;
    if (p === 'sarvam' && pr.sarvamInr) return `Price: ${per(pr.sarvamInr, '₹')}.`;
    if (usd) return `Price: ${per(usd, '$')}${p === 'openai' ? ` (OpenAI's ${fastUsd ? 'Fast mode' : 'list'} price, ${pr.openaiAsOf})` : p === 'gemini' ? ` (Google's price, ${pr.geminiAsOf})` : ''}${p === 'openai' && speed === 'fast' && !fastUsd ? ' This model has no Fast mode: it will answer at standard speed.' : ''}. Shown in rupees at ₹${pr.usdInr} to the dollar.`;
    return 'No price is known for this model, so its cost will show as "–". Add one below to see it.';
  };

  show(html`
    <div class="page-head"><div><h1>Compare models</h1><p class="muted">Each AI model runs its own conversation placement test, side by side, from the first hello to the level and feedback. Type or speak what a learner would say: it goes to every model. Every turn is handled by the model, which also decides the final level. They all get the same picture and the same line to read. "View log" shows exactly what was sent and what came back. Nothing is saved.</p></div></div>
    ${provs.map((p) => html`<datalist id="sugg-${p}">${sugg(p).map((m) => html`<option value="${m}">`)}</datalist>`)}
    <div id="lab"></div>
    <dialog id="logdlg" class="log-dialog"><div class="log-top"><h2 id="logtitle"></h2><span class="row"><button type="button" id="logcopy">Copy log</button><button type="button" id="logclose" class="primary">Close</button></span></div>
      <p class="small muted">Shading shows which parts of each request were reused from cache. Providers report only how many input tokens were reused, not which ones; reuse always starts from the top, so the marks are worked out from each part's length and are an estimate.</p>
      <div id="logbody"></div></dialog>`);
  const box = $('#lab'), dlg = $('#logdlg');
  $('#logclose').addEventListener('click', () => dlg.close());

  const pickRow = (m, i) => html`<div class="row end pick" data-i="${i}">
    <label class="f">Provider<select data-prov>${provs.map((p) => html`<option value="${p}" ${p === m.provider ? raw('selected') : ''}>${providerName(p, info.providers[p])}${ok(p) ? '' : ' (no API key on the server)'}</option>`)}</select></label>
    <label class="f grow">Model<input data-model value="${m.model}" list="sugg-${m.provider}" maxlength="100" autocomplete="off" required></label>
    ${i > 0 ? html`<button type="button" class="link danger" data-remove>Remove</button>` : ''}
    <div class="lab-think" data-think ${TAKES_THINKING.includes(m.provider) ? '' : raw('hidden')}><div class="row">
      <label class="f">Thinking on each turn<select data-effort="turn">${EFFORT_OPTIONS.map(([v, t]) => html`<option value="${v}" ${v === (m.turnEffort ?? info.effortFor?.turn) ? raw('selected') : ''}>${t}</option>`)}</select></label>
      <label class="f">Thinking for the final level and feedback<select data-effort="final">${EFFORT_OPTIONS.map(([v, t]) => html`<option value="${v}" ${v === (m.finalEffort ?? info.effortFor?.final) ? raw('selected') : ''}>${t}</option>`)}</select></label>
      <label class="f" data-speedbox ${m.provider === 'openai' ? '' : raw('hidden')}>Speed<select data-speed>${[['fast', 'Fast mode (about twice the price)'], ['standard', 'Standard']].map(([v, t]) => html`<option value="${v}" ${v === (m.speed ?? info.speed) ? raw('selected') : ''}>${t}</option>`)}</select></label></div></div>
    <p class="small muted lab-priceline" data-priceline>${priceOf(m.provider, m.model, m.speed ?? info.speed)}</p>
    <details class="lab-price"><summary class="small muted">Use a different price for this model</summary>
      <div class="row"><label class="f">Input, $ per 1M tokens<input type="number" min="0" step="any" data-price="input" value="${m.price?.input ?? ''}"></label>
      <label class="f">Reused input, $ per 1M<input type="number" min="0" step="any" data-price="cached" value="${m.price?.cached ?? ''}"></label>
      <label class="f">Output, $ per 1M<input type="number" min="0" step="any" data-price="output" value="${m.price?.output ?? ''}"></label></div>
      <p class="small muted">Only needed when no price is shown above, or yours differs from the list price.</p></details></div>`;
  const readPick = (row) => {
    const num = (k) => { const v = $(`[data-price="${k}"]`, row).value; return v === '' ? undefined : Number(v); };
    const price = num('input') != null && num('output') != null ? { input: num('input'), output: num('output'), ...(num('cached') != null ? { cached: num('cached') } : {}) } : undefined;
    const provider = $('[data-prov]', row).value;
    const think = TAKES_THINKING.includes(provider) ? { turnEffort: $('[data-effort="turn"]', row).value, finalEffort: $('[data-effort="final"]', row).value } : {};
    return { provider, model: $('[data-model]', row).value.trim(), ...think, ...(provider === 'openai' ? { speed: $('[data-speed]', row).value } : {}), ...(price ? { price } : {}) };
  };
  const readPicks = () => ({ models: $$('.pick', box).map(readPick) });

  function setup() {
    box.innerHTML = fmt(html`<form class="card section" id="setup" novalidate>
      <h2>Models to compare</h2>
      <p class="muted small">Up to four. Each one runs its own conversation.</p>
      <div id="picks">${labPicks.models.map(pickRow)}</div>
      ${labPicks.models.length < 4 ? html`<p><button type="button" id="addm">Add a model</button></p>` : ''}
      <p class="muted small">Thinking can be chosen for each OpenAI, Claude or Gemini model (Sarvam has no such choice). It starts at the levels in <a href="#settings">Settings › Placement test</a>. To compare thinking levels, add the same model twice.</p>
      <p class="muted small">API keys are added on the server with <code>deploy/llm-keys-setup.sh</code>. This page spends real AI credit.</p>
      <p class="err" id="serr" role="alert"></p>
      <div class="row"><button class="primary" type="submit">Start the conversations</button></div></form>`);
    for (const row of $$('.pick', box)) {
      const sel = $('[data-prov]', row), input = $('[data-model]', row);
      const reprice = () => { $('[data-priceline]', row).textContent = priceOf(sel.value, input.value.trim(), $('[data-speed]', row).value); };
      $('[data-speed]', row).addEventListener('change', reprice);
      sel.addEventListener('change', () => {
        input.setAttribute('list', `sugg-${sel.value}`);
        if (!sugg(sel.value).includes(input.value)) input.value = sugg(sel.value)[0] || '';
        $('[data-think]', row).hidden = !TAKES_THINKING.includes(sel.value);
        $('[data-speedbox]', row).hidden = sel.value !== 'openai';
        reprice();
      });
      input.addEventListener('input', reprice);
    }
    for (const b of $$('[data-remove]', box)) b.addEventListener('click', () => {
      const i = Number(b.closest('.pick').dataset.i);
      labPicks = readPicks(); labPicks.models.splice(i, 1); setup();
    });
    $('#addm', box)?.addEventListener('click', () => {
      labPicks = readPicks();
      const p = labPicks.models[0].provider, used = labPicks.models.map((m) => m.model);
      labPicks.models.push({ provider: p, model: sugg(p).find((m) => !used.includes(m)) || '' });
      setup();
      $$('[data-model]', box).at(-1)?.focus();
    });
    $('#setup', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#serr', box); err.textContent = '';
      labPicks = readPicks();
      if (labPicks.models.some((m) => !m.model)) { err.textContent = 'Type a model name in every row.'; return; }
      const btn = $('button[type=submit]', e.target); btn.disabled = true;
      try { const r = await api('/placement-lab/start', { method: 'POST', body: labPicks }); if (box.isConnected) talk(r, structuredClone(labPicks)); }
      catch (x) { err.textContent = x.message; btn.disabled = false; }
    });
  }

  function talk(start, picks) {
    const n = start.talks.length, canHear = !!navigator.mediaDevices?.getUserMedia;
    const mic = (cls) => (canHear ? html`<button type="button" class="${cls}" data-mic>Speak</button>` : '');
    box.innerHTML = fmt(html`<div class="card section">
      <div class="section-head"><h2>Conversations</h2><button type="button" class="link" id="again">Start again</button></div>
      <div class="lab-cols">${start.talks.map((t, i) => html`<div class="card lab-col" data-i="${i}">
        <div class="lab-model"><strong>${t.model}</strong>${t.error ? '' : html` <button type="button" class="link" data-log>View log</button>`}</div>
        ${t.error ? html`<p class="err">${t.error}</p>` : html`<div class="lab-log"><div class="bubble tutor"><div class="meta">Sakhi</div>${lines(t.say)}</div></div>
          <p class="small muted lab-progress" data-progress>${progressLine(t.step)}</p>
          <form class="lab-own"><div class="row end"><label class="f grow">Reply to this one only<input maxlength="2000" autocomplete="off"></label>${mic('')}<button type="submit">Send to this one</button></div>
            <div class="row lab-events"><button type="button" data-event="no_speech">Says nothing</button><button type="button" data-event="skip">Skips</button><button type="button" data-event="in_hindi">Asks for Hindi</button></div></form>
          <div data-result></div>`}</div>`)}</div>
      <form id="turn" class="lab-input">
        <div class="row end"><label class="f grow">Reply to all (goes to every conversation still going)<input id="said" maxlength="2000" autocomplete="off" placeholder="My name is Ravi"></label>
          ${mic('')}<button class="primary" type="submit">Send to all</button></div>
        <div class="row lab-events"><button type="button" data-event="no_speech">Says nothing</button><button type="button" data-event="skip">Skips</button><button type="button" data-event="in_hindi">Asks for Hindi</button>
          <span class="small muted" id="wait" hidden><span class="spin"></span> <span id="waitwhat">Waiting for the models. This can take several seconds.</span></span></div>
        <p class="small muted">Each conversation also has its own box, for a reply to that one alone. After that the conversations may be on different steps; a reply to all still goes to each, wherever it is.${canHear ? ' Speak: press, say it, press Stop (up to 30 seconds). Sarvam turns it into words, as in the app, and it is sent.' : ''}</p>
        <p class="err" id="terr" role="alert"></p>
      </form>
      <div id="labsum"></div></div>`);
    const form = $('#turn', box), input = $('#said', box);
    const col = (i) => $(`.lab-col[data-i="${i}"]`, box);
    // Per talk: finished?, its running totals, the step it is on, every call (for the log), and its result.
    const state = start.talks.map((t) => { const totals = newTotals(); addSpeech(totals, null, t.voice); return { model: t.model, over: !!t.error, error: t.error, totals, step: t.step, calls: [], done: null }; });
    input.focus();
    const busy = (on, what) => { for (const el of $$('input, button', box)) if (el.id !== 'again' && !('log' in el.dataset)) el.disabled = on; $('#wait', box).hidden = !on; if (what) $('#waitwhat', box).textContent = what; };
    $('#again', box).addEventListener('click', () => { labPicks = picks; setup(); });

    const sp = info.speechPrices;
    const speechNote = sp ? html`<p class="small muted">Speech-to-text and voice are what the same talk would cost in the app, at Sarvam's prices (${sp.asOf}): ₹${sp.sttPerHour} for an hour of the learner's speech, ₹${sp.ttsPer10kChars} for 10,000 characters of Sakhi's voice. Spoken turns use the recording's real length; typed turns are estimated at ${sp.wordsASecond} words a second. Her fixed lines (the hello, the reading request, the level) are made once ahead of time and cost a talk nothing. This page plays no sound, so the voice cost is not spent here; speech-to-text is, when you use Speak. In the app the microphone also sends the pauses around their words, so the real speech-to-text cost is somewhat higher.</p>` : '';
    function summary() {
      const rows = state.filter((s) => !s.error && s.totals.calls);
      $('#labsum', box).innerHTML = rows.length ? fmt(html`<h2>Side by side</h2><div class="table-wrap"><table>
        <tr><th>Model</th><th>Level</th><th>Decided by</th><th class="num">AI calls</th><th class="num">Time in all</th><th class="num">Average a turn</th><th class="num">Reply ready, average</th><th class="num">Input tokens</th><th class="num">Reused</th><th class="num">Output</th><th class="num">Thinking</th><th class="num">AI cost</th><th class="num">Speech-to-text</th><th class="num">Voice</th><th class="num">Cost in all</th></tr>
        ${rows.map((s) => { const t = s.totals; return html`<tr><td class="lab-model">${s.model}</td><td>${s.done ? `${s.done.level} · ${s.done.name}` : html`<span class="muted">still talking</span>`}</td><td>${s.done?.decidedBy || '–'}</td>
          <td class="num">${t.calls}</td><td class="num">${ms(t.ms)}</td><td class="num">${ms(t.ms / t.calls)}</td><td class="num">${t.replies ? ms(t.replyMs / t.replies) : '–'}</td><td class="num">${n0(t.input)}</td><td class="num">${reusedPct(t) == null ? '–' : `${reusedPct(t)}%`}</td>
          <td class="num">${n0(t.output)}</td><td class="num">${t.reasoning ? n0(t.reasoning) : '–'}</td><td class="num">${t.priced ? inr(t.cost, 3) : '–'}</td><td class="num">${inr(t.sttInr, 3)}</td><td class="num">${inr(t.voiceInr, 3)}</td><td class="num"><strong>${t.priced ? inr(t.cost + t.sttInr + t.voiceInr, 3) : '–'}</strong></td></tr>`; })}
      </table></div>${speechNote}<p class="small muted">"Reused" is the share of input tokens the provider took from its cache, at a lower price. "Thinking" tokens are part of the output. "Reply ready" is for models whose answer is streamed (OpenAI): how soon Sakhi's reply was written, which is when her voice starts being made, before the rest of the answer arrives.</p>`) : '';
    }

    function showLog(i) {
      const s = state[i];
      $('#logtitle').textContent = `${s.model}: every call`;
      $('#logbody').innerHTML = fmt(s.calls.length ? s.calls.map(logCall) : html`<p class="muted">No turns yet. The log fills as the talk goes on.</p>`);
      $('#logcopy').onclick = async () => {
        try { await navigator.clipboard.writeText(logText(s.model, s.calls)); toast('Log copied'); }
        catch { const r = document.createRange(); r.selectNodeContents($('#logbody')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Select and copy: your browser blocked the copy'); }
      };
      dlg.showModal();
    }

    function finished(i, x) {
      const d = x.done, m = picks.models[i];
      const list = (title, items) => (items?.length ? html`<h3>${title}</h3><ul class="lab-list">${items.map((y) => html`<li>${y}</li>`)}</ul>` : '');
      const el = $('[data-result]', col(i));
      el.innerHTML = fmt(html`<div class="lab-result"><h2>Level ${d.level} of 4 · ${d.name}</h2>
        <p class="small muted">Decided by ${d.decidedBy || 'the AI'}.</p>
        ${list('Why', d.reasons)}${list('What you did well', d.doingWell)}${list('What we’ll practise next', d.practise)}
        ${totalLine(state[i].totals)}
        ${can('settings.edit') ? html`<p><button type="button" data-use>Use this model for the placement test</button></p><p class="err" data-err role="alert"></p>` : ''}</div>`);
      $('[data-use]', el)?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.disabled = true; $('[data-err]', el).textContent = '';
        try {
          const s = await api('/settings');
          const value = structuredClone(s.sections.placement.value);
          value.brain = { provider: m.provider, model: m.model, temperature: value.brain.temperature };
          value.summary = { provider: m.provider, model: m.model, temperature: value.summary.temperature };
          if (m.speed) value.speed = m.speed;
          if (m.turnEffort) value.turnEffort = m.turnEffort;
          if (m.finalEffort) value.finalEffort = m.finalEffort;
          await api('/settings/placement', { method: 'PUT', body: { value } });
          toast(`Saved. New tests in conversation mode use ${m.model}${m.turnEffort ? `, thinking ${m.turnEffort} on each turn and ${m.finalEffort} for the final level` : ''}.`);
        } catch (x2) { $('[data-err]', el).textContent = x2.message; }
        btn.disabled = false;
      });
    }

    async function send(event, message, only, heard) {
      const err = $('#terr', box); err.textContent = '';
      if (event === 'answer' && !message) { err.textContent = 'Type or say what the learner says.'; return; }
      busy(true, 'Waiting for the models. This can take several seconds.');
      let r;
      try { r = await api('/placement-lab/turn', { method: 'POST', body: { labId: start.labId, event, ...(event === 'answer' ? { message } : {}), ...(heard ? { speechSec: heard.audioSec } : {}), ...(only != null ? { only } : {}) } }); }
      catch (x) { if (box.isConnected) { err.textContent = x.message; busy(false); input.focus(); } return; }
      if (!box.isConnected) return;
      r.talks.forEach((x, i) => {
        if (!x) return;
        const c = col(i), log = $('.lab-log', c), s = state[i];
        const turn = document.createElement('div');
        if (x.error) { turn.innerHTML = fmt(html`<p class="err">${x.error}</p>`); log.append(turn); s.over = true; $('.lab-own', c).hidden = true; return; }
        const said = event === 'answer' ? message : LEARNER_EVENTS[event];
        turn.innerHTML = fmt(html`<div class="bubble learner">${event === 'answer' ? message : html`<span class="muted">${said}</span>`}<div class="meta">Learner${heard ? ` · spoken, ${heard.audioSec} s` : ''}</div></div>
          ${labAi(x)}<div class="bubble tutor"><div class="meta">Sakhi</div>${lines(x.say)}</div>${x.voice ? speechCost(r.heard, x.voice) : ''}`);
        log.append(turn);
        s.calls.push({ n: s.calls.length + 1, at: stepName(s.step), learner: said, heard, ai: x.ai, log: x.log, say: x.say, dropped: x.dropped, aiFailed: x.aiFailed, stt: r.heard, voice: x.voice });
        if (x.final) s.calls.push({ n: s.calls.length + 1, at: `${stepName(s.step)} · final evaluation, asked again with more thinking`, learner: said, ai: x.final.ai, log: x.final.log, say: x.say });
        s.step = x.step;
        if (x.ai) addUse(s.totals, x.ai);
        addSpeech(s.totals, r.heard, x.voice);
        if (x.final) addUse(s.totals, x.final.ai);
        if (x.done?.ai) addUse(s.totals, x.done.ai);
        $('[data-progress]', c).textContent = progressLine(x.step);
        // Each talk can be answered on its own at any point, until it has finished.
        $('.lab-own', c).hidden = !!x.done;
        if (x.done) { s.over = true; s.done = x.done; finished(i, x); }
      });
      summary();
      busy(false);
      for (const f of $$('.lab-own input', box)) f.value = '';
      input.value = '';
      if (state.every((s) => s.over)) { form.hidden = true; return; }
      (only != null && !state[only].over ? $('.lab-own input', col(only)) : input).focus();
    }

    // The microphone: press to start, press again to stop; the words are heard by Sarvam and sent.
    let rec = null, timer = null;
    async function speak(btn, only) {
      const err = $('#terr', box); err.textContent = '';
      if (rec) { // stop, hear, send
        clearTimeout(timer);
        const r = rec; rec = null; btn.textContent = 'Speak'; btn.classList.remove('recording');
        busy(true, 'Sarvam is turning that into words…');
        try {
          const { wav, seconds } = await r.stop();
          if (seconds < 0.4) throw new Error('That was too short. Press Speak, say it, then press Stop.');
          // The reading step is always English, as in the app.
          const on = state[only ?? state.findIndex((s) => !s.over)]?.step?.step;
          const heard = await transcribe(wav, on === 'read' ? 'en-IN' : '');
          if (!box.isConnected) return;
          if (!heard.transcript) { busy(false); err.textContent = 'Sarvam heard nothing in that recording. Try again, a little closer to the microphone.'; return; }
          await send('answer', heard.transcript, only, { audioSec: heard.audioSec, ms: heard.ms });
        } catch (x) { busy(false); err.textContent = x.message; }
        return;
      }
      try { rec = await startRecording(); }
      catch (x) { err.textContent = x.name === 'NotAllowedError' ? 'The microphone is blocked for this page. Allow it in the browser (the icon beside the address), then try again. If the browser never asks, the website needs its latest deploy (docs/PLACEMENT.md).' : `Couldn't start the microphone: ${x.message}`; return; }
      btn.textContent = 'Stop'; btn.classList.add('recording');
      timer = setTimeout(() => { if (rec) speak(btn, only); }, 28_000); // Sarvam takes up to 30 seconds
    }

    form.addEventListener('submit', (e) => { e.preventDefault(); send('answer', input.value.trim()); });
    for (const b of $$('[data-event]', form)) b.addEventListener('click', () => send(b.dataset.event));
    for (const b of $$('.lab-own [data-event]', box)) b.addEventListener('click', () => send(b.dataset.event, undefined, Number(b.closest('.lab-col').dataset.i)));
    $('[data-mic]', form)?.addEventListener('click', (e) => speak(e.currentTarget));
    for (let i = 0; i < n; i++) {
      const c = col(i);
      $('.lab-own', c)?.addEventListener('submit', (e) => { e.preventDefault(); send('answer', $('input', e.target).value.trim(), i); });
      $('.lab-own [data-mic]', c)?.addEventListener('click', (e) => speak(e.currentTarget, i));
      $('[data-log]', c)?.addEventListener('click', () => showLog(i));
    }
  }

  setup();
}

// ---- Compare voices ---------------------------------------------------------------------------------
// Sarvam's and Google's voices side by side, on the same words: hear each, see how soon it started and how long it
// took, what it cost, and what a whole talk would cost with it (server/admin/voices.js). Nothing is saved.
let voicePicks = null; // the voice rows, kept for later visits
const VOICE_PROVIDERS = { sarvam: 'Sarvam', cloudtts: 'Google Cloud TTS', gemini: 'Google Gemini (newest models)' };
const inr4 = (x) => (x == null ? '–' : x < 0.01 ? `₹${x.toFixed(4)}` : `₹${x.toFixed(3)}`);
const b64ToBlob = (b64, type) => { const bin = atob(b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new Blob([bytes], { type }); };

async function voicesPage() {
  const info = await api('/voices');
  const sarvamList = (model) => info.voices.sarvam[model] || info.voices.sarvam['bulbul:v4-flash'];
  if (!voicePicks) voicePicks = [
    { provider: 'sarvam', model: info.current.model, voice: info.current.voice },
    { provider: 'sarvam', model: 'bulbul:v4-flash', voice: 'ishita_enhi_companion' },
    { provider: 'cloudtts', model: 'gemini-2.5-flash-tts', voice: 'Sulafat', style: 'Say this warmly and patiently, like a kind teacher on a phone call.' },
    { provider: 'cloudtts', model: 'gemini-3.1-flash-tts-preview', voice: 'Achernar', style: 'Say this warmly and patiently, like a kind teacher on a phone call.' },
    { provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'Sulafat', style: 'warm, friendly and patient, like a kind teacher on a phone call' },
  ];
  const label = (v) => `${VOICE_PROVIDERS[v.provider]} · ${v.model} · ${v.voice}${v.style ? ` · “${v.style.slice(0, 40)}${v.style.length > 40 ? '…' : ''}”` : ''}${v.pace && v.pace !== 1 ? ` · pace ${v.pace}` : ''}`;
  const pr = info.prices;

  show(html`
    <div class="page-head"><div><h1>Compare voices</h1><p class="muted">Sakhi's voice from Sarvam (what the app uses now: <code>${info.current.voice}</code>) and from Google Gemini, on the same words. Each card plays the sound and shows how soon it started, how long it took and what it cost. This page spends real credit with each provider. Nothing changes in the app.</p></div></div>
    <datalist id="vl-sarvam-bulbul:v4-flash">${sarvamList('bulbul:v4-flash').map((v) => html`<option value="${v}">`)}</datalist>
    <datalist id="vl-sarvam-bulbul:v3">${sarvamList('bulbul:v3').map((v) => html`<option value="${v}">`)}</datalist>
    <datalist id="vl-gemini">${info.voices.gemini.map((v) => html`<option value="${v.id}">${v.label}</option>`)}</datalist>
    <datalist id="vl-cloudtts">${info.voices.cloudtts.map((v) => html`<option value="${v.id}">${v.label}</option>`)}</datalist>
    <form class="card section" id="vform" novalidate>
      <h2>What Sakhi says</h2>
      <div class="row end"><label class="f">Her real lines<select id="vsample"><option value="">Choose one…</option>${info.samples.map((s, i) => html`<option value="${i}">${s.label}</option>`)}</select></label></div>
      <label class="f"><span>Words ("|" marks where her reaction ends and her question begins)</span><textarea id="vtext" rows="3" maxlength="1200">${info.samples[0].text}</textarea></label>
      <div class="choices" role="radiogroup" aria-label="How it is sent">${info.modes.map(([v, t], i) => html`<label class="choice"><input type="radio" name="vmode" value="${v}" ${i === 0 ? raw('checked') : ''}><div><strong>${t}</strong></div></label>`)}</div>
      <h2>Voices</h2>
      ${Object.keys(VOICE_PROVIDERS).filter((p) => !info.providers[p]?.configured).map((p) => html`<p class="small err">${{ gemini: 'Google Gemini: works only on the deployed server (through Vertex AI, signed in as its Google Cloud account), so these voices fail when the console runs elsewhere.', cloudtts: 'Google Cloud TTS works only on the deployed server (it signs in as its Google Cloud service account), so these voices fail when the console runs elsewhere.', sarvam: 'No Sarvam key on the server.' }[p]}</p>`)}
      <div id="vrows"></div>
      <p><button type="button" id="vadd">Add a voice</button></p>
      <p class="muted small">Sarvam: ${info.voices.sarvam['bulbul:v4-flash'].length} voices for Bulbul v4 Flash and ${info.voices.sarvam['bulbul:v3'].length} for v3 (Sarvam's list on ${info.voices.sarvam.asOf}); each name is person_language_style, so <code>roopa_hi_companion</code> is Roopa, Hindi, companion style. Pace, pitch and steadiness are Sarvam's own controls. Google: the same 30 voices through Google Cloud TTS (streamed, signed in as the server's Google Cloud account, billed to the project; Gemini 3.1 Flash preview and the 2.5 models) or through the Gemini API (an API key; the newest 3.8 models, which Cloud TTS does not have); either is told how to speak in words, not with numbers.</p>
      <div class="row end"><label class="f">Characters Sakhi says in a talk, for the estimate<input type="number" id="vtalk" min="100" max="10000" value="700"></label>
        <label class="f">Talks<input type="number" id="vtalks" min="1" max="10000000" value="1000"></label></div>
      <p class="err" id="verr" role="alert"></p>
      <div class="row"><button class="primary" type="submit">Make every voice</button><button type="button" id="vplayall" disabled>Play them one after another</button></div>
    </form>
    <div id="vout" class="voice-grid"></div>
    <div class="card section"><h2>What each voice model costs</h2>
      <div class="table-wrap"><table><tr><th>Provider</th><th>Model</th><th>Billed by</th><th class="num">₹ per 1,000 characters</th><th class="num">₹ per minute of speech</th><th class="num">₹ per talk (at the characters above)</th></tr>
      ${pr.rows.map((r) => html`<tr><td>${VOICE_PROVIDERS[r.provider]}</td><td>${r.label}${r.rises ? html`<br><span class="small muted">doubles from ${r.rises.from}</span>` : ''}</td><td class="small">${r.billedBy}</td><td class="num">${inr4(r.per1000Chars)}</td><td class="num">${inr4(r.perMinute)}</td><td class="num" data-pertalk="${r.per1000Chars}">${inr4((r.per1000Chars * 700) / 1000)}</td></tr>`)}
      </table></div>
      <p class="small muted">Sarvam charges for characters sent (₹ per 1,000, pay as you go); Google for seconds of sound made (25 tokens a second) and a little for the text. To put them side by side the table assumes Sakhi says about ${pr.charsPerSecond} characters a second, and $1 = ₹${pr.usdInr}. The cards below use what each clip really took. Her fixed lines (the hello, the level) are made once and reused, so a talk pays only for what the AI writes. Google's spending is not counted in the daily budget.</p>
    </div>`);

  const rowsBox = $('#vrows');
  const rowHtml = (v, i) => html`<div class="card vrow" data-i="${i}"><div class="row end">
      <label class="f">Provider<select data-k="provider">${Object.entries(VOICE_PROVIDERS).map(([p, t]) => html`<option value="${p}" ${p === v.provider ? raw('selected') : ''}>${t}${info.providers[p].configured ? '' : ' (not set up on this server)'}</option>`)}</select></label>
      <label class="f">Model<select data-k="model">${info.models[v.provider].map((m) => html`<option value="${m.id}" ${m.id === v.model ? raw('selected') : ''}>${m.label}</option>`)}</select></label>
      <label class="f grow">Voice<input data-k="voice" value="${v.voice}" list="${v.provider === 'sarvam' ? `vl-sarvam-${v.model}` : `vl-${v.provider}`}" autocomplete="off"></label>
      <button type="button" class="link danger" data-remove>Remove</button></div>
    ${v.provider === 'gemini'
      ? html`<label class="f">How to say it (style, optional)<input data-k="style" value="${v.style || ''}" maxlength="400" placeholder="warm, friendly and patient"></label>`
      : v.provider === 'cloudtts' && v.model === 'chirp3-hd'
      ? html`<div class="row"><label class="f">Pace<input type="number" data-k="pace" min="0.5" max="2" step="0.05" value="${v.pace ?? 1}"></label><p class="small muted grow">Chirp 3 HD takes no style; the same voice names as Gemini.</p></div>`
      : v.provider === 'cloudtts'
      ? html`<div class="row"><label class="f grow">How to say it (Google's prompt, optional)<input data-k="style" value="${v.style || ''}" maxlength="400" placeholder="Say this warmly and patiently."></label>
          <label class="f">Pace<input type="number" data-k="pace" min="0.5" max="2" step="0.05" value="${v.pace ?? 1}"></label></div>`
      : html`<div class="row"><label class="f">Pace<input type="number" data-k="pace" min="0.5" max="2" step="0.05" value="${v.pace ?? 1}"></label>
          <label class="f">Pitch<input type="number" data-k="pitch" min="-0.5" max="0.5" step="0.05" value="${v.pitch ?? 0}"></label>
          <label class="f">Steadiness (temperature: lower is steadier)<input type="number" data-k="temperature" min="0.01" max="1" step="0.05" value="${v.temperature ?? 0.6}"></label></div>`}</div>`;
  const readRows = () => $$('.vrow', rowsBox).map((r) => {
    const get = (k) => $(`[data-k="${k}"]`, r);
    const o = { provider: get('provider').value, model: get('model').value, voice: get('voice').value.trim() };
    if (o.provider !== 'sarvam' && get('style')?.value.trim()) o.style = get('style').value.trim();
    if (o.provider !== 'gemini') for (const k of ['pace', 'pitch', 'temperature']) { const n = Number(get(k)?.value); if (get(k) && get(k).value !== '' && Number.isFinite(n)) o[k] = n; }
    return o;
  });
  function drawRows() {
    rowsBox.innerHTML = fmt(html`${voicePicks.map(rowHtml)}`);
    for (const r of $$('.vrow', rowsBox)) {
      const i = Number(r.dataset.i);
      $('[data-k="provider"]', r).addEventListener('change', (e) => {
        voicePicks = readRows();
        const p = e.target.value;
        voicePicks[i] = { gemini: { provider: p, model: 'gemini-3.8-flash-tts', voice: 'Sulafat' }, cloudtts: { provider: p, model: 'gemini-2.5-flash-tts', voice: 'Sulafat' }, sarvam: { provider: p, model: 'bulbul:v4-flash', voice: 'roopa_hi_companion' } }[p];
        drawRows();
      });
      $('[data-k="model"]', r).addEventListener('change', () => { voicePicks = readRows(); drawRows(); });
      $('[data-remove]', r).addEventListener('click', () => { voicePicks = readRows(); voicePicks.splice(i, 1); drawRows(); });
    }
    $('#vadd').disabled = voicePicks.length >= 8;
  }
  drawRows();
  $('#vadd').addEventListener('click', () => { voicePicks = readRows(); voicePicks.push({ provider: 'cloudtts', model: 'gemini-2.5-flash-tts', voice: 'Kore' }); drawRows(); });
  $('#vsample').addEventListener('change', (e) => { if (e.target.value !== '') $('#vtext').value = info.samples[Number(e.target.value)].text; });
  const talkChars = () => Math.max(1, Number($('#vtalk').value) || 700), talks = () => Math.max(1, Number($('#vtalks').value) || 1000);
  const refreshEstimates = () => {
    for (const td of $$('[data-pertalk]')) td.textContent = inr4((Number(td.dataset.pertalk) * talkChars()) / 1000);
    for (const el of $$('[data-perchar]')) el.textContent = `${inr4(Number(el.dataset.perchar) * talkChars())} a talk · ₹${(Number(el.dataset.perchar) * talkChars() * talks()).toFixed(0)} for ${talks().toLocaleString('en-IN')} talks`;
  };
  $('#vtalk').addEventListener('input', refreshEstimates); $('#vtalks').addEventListener('input', refreshEstimates);

  // Every voice at once; each card fills in as soon as its sound is ready.
  let clips = [];
  $('#vform').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#verr').textContent = '';
    voicePicks = readRows();
    const text = $('#vtext').value.trim(), mode = $('input[name="vmode"]:checked').value;
    if (!text) { $('#verr').textContent = 'Type what Sakhi says.'; return; }
    if (!voicePicks.length) { $('#verr').textContent = 'Add at least one voice.'; return; }
    for (const u of clips) URL.revokeObjectURL(u);
    clips = []; $('#vplayall').disabled = true;
    const out = $('#vout');
    out.innerHTML = fmt(html`${voicePicks.map((v, i) => html`<div class="card vcard" data-i="${i}"><h3>${label(v)}</h3><p class="muted small"><span class="spin"></span> Making the sound…</p></div>`)}`);
    const btn = $('button[type=submit]', e.target); btn.disabled = true;
    await Promise.all(voicePicks.map(async (v, i) => {
      const card = $(`.vcard[data-i="${i}"]`, out);
      try {
        const r = await api('/voices/speak', { method: 'POST', body: { ...v, text, mode } });
        const url = URL.createObjectURL(b64ToBlob(r.audio, 'audio/wav'));
        clips[i] = url;
        const perChar = r.costInr / Math.max(1, r.chars);
        card.innerHTML = fmt(html`<h3>${label(v)}</h3>
          <audio controls preload="auto" src="${url}"></audio>
          <table class="vstats">
            <tr><td>First sound after</td><td class="num"><strong>${ms(r.firstAudioMs)}</strong></td></tr>
            <tr><td>All made in</td><td class="num">${ms(r.totalMs)}</td></tr>
            <tr><td>Length of speech</td><td class="num">${r.seconds.toFixed(1)} s (${(r.chars / Math.max(0.1, r.seconds)).toFixed(1)} characters a second)</td></tr>
            <tr><td>Cost of this clip</td><td class="num"><strong>${inr4(r.costInr)}</strong> for ${r.chars} characters</td></tr>
            <tr><td>Per minute of speech</td><td class="num">${inr4((r.costInr / Math.max(0.1, r.seconds)) * 60)}</td></tr>
            <tr><td>At this rate</td><td class="num" data-perchar="${perChar}"></td></tr>
          </table>
          ${r.pieces.length > 1 ? html`<details><summary class="small muted">Sent as ${r.pieces.length} requests</summary><ol class="small">${r.pieces.map((p) => html`<li>${p.text} <span class="muted">(first sound ${ms(p.firstByteMs)}, ${p.seconds} s, ${inr4(p.costInr)}${p.tokens ? `, ${p.tokens.output} sound tokens${p.tokens.counted ? '' : ' estimated'}` : ''})</span></li>`)}</ol></details>` : ''}
          ${r.pieces[0]?.tokens && !r.pieces[0].tokens.counted ? html`<p class="small muted">Google did not report its count: the cost is worked out from the length of the sound.</p>` : ''}
          <p><a class="small" href="${url}" download="${`${v.provider}-${v.voice}.wav`.replace(/[^\w.-]+/g, '_')}">Download</a></p>`);
        refreshEstimates();
      } catch (x) { card.innerHTML = fmt(html`<h3>${label(v)}</h3><p class="err">${x.message}</p>`); }
    }));
    btn.disabled = false;
    $('#vplayall').disabled = !clips.some(Boolean);
  });
  // Blind comparison is easier one after another, with a short pause between voices.
  $('#vplayall').addEventListener('click', async () => {
    const players = $$('.vcard audio');
    for (const a of players) {
      a.closest('.vcard').classList.add('playing');
      a.currentTime = 0;
      await a.play().catch(() => {});
      await new Promise((ok) => { a.onended = ok; a.onpause = ok; });
      a.closest('.vcard').classList.remove('playing');
      await new Promise((ok) => setTimeout(ok, 600));
    }
  });
}

// ---- Evaluations ----------------------------------------------------------------------------------
const METRICS = [
  ['precision', 'Precision', 'Of the corrections shown, how many were right', true],
  ['falseAlarmRate', 'False alarms', 'Correct messages that got a correction anyway', false],
  ['recall', 'Recall', 'Of the real mistakes, how many were corrected', true],
  ['f05', 'F0.5', 'Combined score, precision counts double', true],
];
function compareBars(sum) {
  return html`<div class="legend"><span><i style="background:var(--series-1)"></i>A · one call</span><span><i style="background:var(--series-2)"></i>B · one call + check</span></div>
    ${METRICS.map(([k, name, help]) => html`<div style="margin:10px 0"><div class="small"><strong>${name}</strong> <span class="muted">· ${help}</span></div>
      ${[['single', 'A', 'var(--series-1)'], ['verify', 'B', 'var(--series-2)']].map(([s, l, c]) => html`<div class="hbar"><span class="small muted">${l}</span><span class="track"><i style="width:${sum[s][k] ?? 0}%;background:${c}" data-tip="${l}: ${pct(sum[s][k])}"></i></span><span class="n">${pct(sum[s][k])}</span></div>`)}</div>`)}`;
}
function summaryTable(sum) {
  const better = (k, hi) => { const a = sum.single[k], b = sum.verify[k]; if (a == null || b == null || a === b) return ''; return (hi ? b > a : b < a) ? 'verify' : 'single'; };
  const row = (label, f, k, hi) => { const w = k ? better(k, hi) : ''; return html`<tr><td>${label}</td><td class="num">${f(sum.single)} ${w === 'single' ? html`<span class="win">better</span>` : ''}</td><td class="num">${f(sum.verify)} ${w === 'verify' ? html`<span class="win">better</span>` : ''}</td></tr>`; };
  return html`<div class="table-wrap"><table><tr><th></th><th class="num">A · one call</th><th class="num">B · one call + check</th></tr>
    ${row('Precision (right ÷ shown)', (x) => pct(x.precision), 'precision', true)}
    ${row('False alarms on correct messages', (x) => `${pct(x.falseAlarmRate)} of ${x.cleanItems}`, 'falseAlarmRate', false)}
    ${row('Recall (corrected ÷ real mistakes)', (x) => pct(x.recall), 'recall', true)}
    ${row('F0.5', (x) => pct(x.f05), 'f05', true)}
    ${row('Right / false / missed', (x) => `${x.tp} / ${x.fp} / ${x.fn}`)}
    ${row('Time, typical / slowest 5%', (x) => `${ms(x.latencyMs.p50)} / ${ms(x.latencyMs.p95)}`)}
    ${row('AI cost per message', (x) => inr(x.costInr.perTurn, 4))}
    ${row('Failed (errors)', (x) => `${x.failed} of ${x.items}`)}</table></div>`;
}
async function evals(id) {
  if (id) return evalDetail(id);
  const { runs, dataset } = await api('/evals');
  const latest = runs.find((r) => r.status === 'done' && r.summary?.single);
  show(html`
    <div class="page-head"><div><h1>Evaluations</h1><p class="muted">How well corrections work, on ${dataset.items} hand-labelled learner messages (${dataset.version}). Each message gets one tutor reply; A shows its corrections after the rules, B also checks them. So the only difference is the check.</p></div></div>
    <div class="grid g2 section">
      <div class="card"><h2>Latest result</h2>${latest ? html`<p class="small muted">${when(latest.finished_at)} · ${latest.config?.intensity} intensity · prompt ${latest.prompt_version} · tutor ${latest.config?.llm?.tutor?.model}</p>${compareBars(latest.summary)}` : html`<p class="muted">No finished runs yet.</p>`}</div>
      ${can('evals.run') ? '' : html`<div class="card"><h2>Run an evaluation</h2><p class="muted">Your role (${me.roleName}) can see evaluations but not start them.</p></div>`}
      <form class="card" id="start" ${can('evals.run') ? '' : raw('hidden')}><h2>Run an evaluation</h2>
        <p class="small muted">Uses the current settings and the real AI. The full set takes 2–4 minutes and costs about ₹2.</p>
        <label class="f">Correction intensity<select id="eint"><option value="">Default</option><option value="gentle">Gentle</option><option value="balanced">Balanced</option><option value="strict">Strict</option></select></label>
        <h3>Only these groups (none = all)</h3><div class="row">${dataset.groups.map((g) => html`<label class="check small"><input type="checkbox" value="${g}"> ${humanize(g)}</label>`)}</div>
        <p></p><button class="primary" type="submit">Start</button><p class="err" id="eerr"></p></form>
    </div>
    ${latest ? html`<div class="card section"><h2>Latest result in numbers</h2>${summaryTable(latest.summary)}</div>` : ''}
    <div class="card"><h2>Runs</h2><div class="table-wrap"><table><tr><th>Started</th><th>Status</th><th>Intensity</th><th>Prompt</th><th class="num">A precision / recall</th><th class="num">B precision / recall</th><th>By</th></tr>
      ${runs.map((r) => html`<tr class="click" data-id="${r.id}"><td>${when(r.started_at)}</td><td>${r.status === 'running' ? html`<span class="status warn">running ${r.progress ? `${r.progress.done}/${r.progress.total}` : ''}</span>` : r.status === 'done' ? html`<span class="status good">done</span>` : html`<span class="status bad">failed</span>`}</td><td>${r.config?.intensity}</td><td>${r.prompt_version}</td><td class="num">${r.summary?.single ? `${pct(r.summary.single.precision)} / ${pct(r.summary.single.recall)}` : '–'}</td><td class="num">${r.summary?.verify ? `${pct(r.summary.verify.precision)} / ${pct(r.summary.verify.recall)}` : '–'}</td><td class="small">${r.started_by || '–'}</td></tr>`)}
    </table></div></div>`);
  $$('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `evals/${tr.dataset.id}`; }));
  $('#start').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/evals', { method: 'POST', body: { intensity: $('#eint').value || undefined, only: $$('#start input:checked').map((i) => i.value) } }); toast('Started. This page refreshes while it runs.'); route(); }
    catch (x) { $('#eerr').textContent = x.message; }
  });
  if (runs.some((r) => r.status === 'running')) setTimeout(() => { if (location.hash.startsWith('#evals') && !location.hash.includes('/')) route(); }, 5000);
}
async function evalDetail(id) {
  const r = await api(`/evals/${encodeURIComponent(id)}`);
  if (r.status !== 'done') return show(html`<p><a href="#evals">← Evaluations</a></p><div class="card"><h2>Run ${r.status}</h2><p class="muted">${r.progress ? `${r.progress.done} of ${r.progress.total} messages` : r.summary?.error || ''}</p></div>`);
  const items = r.results || [];
  const differs = (x) => x.error || x.single.fp || x.single.fn || x.verify.fp || x.verify.fn || JSON.stringify(x.single.corrections) !== JSON.stringify(x.verify.corrections);
  const list = (cs) => (cs?.length ? cs.map((c) => html`<div class="small"><span class="was">${c.original}</span> → ${c.corrected}</div>`) : html`<span class="muted small">none</span>`);
  const groups = Object.keys(r.summary.byGroup.single);
  show(html`<p><a href="#evals">← Evaluations</a></p>
    <div class="page-head"><div><h1>Evaluation run</h1><p class="muted">${when(r.started_at)} · ${r.config.intensity} intensity · prompt ${r.prompt_version} · ${r.dataset_version} · tutor ${r.config.llm.tutor.provider}/${r.config.llm.tutor.model} · check ${r.config.llm.verify.provider}/${r.config.llm.verify.model}</p></div></div>
    <div class="grid g2 section"><div class="card">${compareBars(r.summary)}</div><div class="card">${summaryTable(r.summary)}</div></div>
    <div class="card section"><h2>By kind of message</h2><div class="table-wrap"><table><tr><th>Group</th><th class="num">Messages</th><th class="num">A right / false / missed</th><th class="num">B right / false / missed</th></tr>
      ${groups.map((g) => { const a = r.summary.byGroup.single[g], b = r.summary.byGroup.verify[g]; return html`<tr><td>${humanize(g)}</td><td class="num">${a.items}</td><td class="num">${a.tp} / ${a.fp} / ${a.fn}</td><td class="num">${b.tp} / ${b.fp} / ${b.fn}</td></tr>`; })}</table></div></div>
    <div class="card"><h2>Messages where something went wrong or A and B differ</h2><div class="table-wrap"><table><tr><th>Message</th><th>Expected</th><th>A shows</th><th>B shows</th><th>The check said</th></tr>
      ${items.filter(differs).map((x) => html`<tr><td><div class="small muted">${x.id} · ${x.channel}</div>${x.text}${x.error ? html`<div class="err">${x.error}</div>` : ''}</td>
        <td class="small">${x.single.missed?.length ? html`missed: ${x.single.missed.join(', ')}` : ''}${(x.single.falseCorrections || []).map((f) => html`<div class="err">A: ${f.original} (${f.why})</div>`)}${(x.verify.falseCorrections || []).map((f) => html`<div class="err">B: ${f.original} (${f.why})</div>`)}</td>
        <td>${list(x.single.corrections)}</td><td>${list(x.verify.corrections)}</td><td class="small muted">${(x.verify.droppedByCheck || []).map((d) => html`<div>${d.original}: ${d.reason}</div>`)}</td></tr>`)}
    </table></div></div>`);
}

// ---- Conversations --------------------------------------------------------------------------------
async function conversations(id) {
  if (id) return conversation(id);
  const { conversations: rows } = await api('/conversations');
  show(html`<div class="page-head"><div><h1>Conversations</h1><p class="muted">The latest 100 practice conversations and lessons. Phone numbers are partly hidden.</p></div></div>
    <div class="card"><div class="table-wrap"><table><tr><th>Last message</th><th>Learner</th><th>Kind</th><th class="num">Messages</th><th class="num">Corrections</th><th>Latest from the learner</th></tr>
    ${rows.map((c) => html`<tr class="click" data-id="${c.id}"><td>${when(c.last_message_at)}</td><td>${c.name || c.phone || 'local'}</td><td>${c.mode === 'lesson' ? html`lesson: ${c.title}` : 'practice'}</td><td class="num">${c.learner_messages}</td><td class="num">${c.corrections}</td><td class="small">${(c.last_learner_message || '').slice(0, 90)}</td></tr>`)}
    </table></div>${rows.length ? '' : html`<p class="muted">No conversations yet.</p>`}</div>`);
  $$('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `conversations/${tr.dataset.id}`; }));
}
async function conversation(id) {
  const { conversation: c, messages } = await api(`/conversations/${encodeURIComponent(id)}`);
  show(html`<p><a href="#conversations">← Conversations</a></p>
    <div class="page-head"><div><h1>${c.mode === 'lesson' ? `Lesson: ${c.title}` : 'Practice conversation'}</h1><p class="muted">${c.name || c.phone || 'local'} · started ${when(c.started_at)}</p></div></div>
    <div class="card">${messages.map((m) => {
      const md = m.metadata || {};
      return m.role === 'learner'
        ? html`<div class="bubble learner">${m.content}<div class="meta">${m.channel === 'voice' ? 'spoken' : 'typed'} · ${when(m.created_at)}${md.sttConfidence != null ? ` · speech confidence ${md.sttConfidence}` : ''}</div>${m.corrections.map((k) => corrBox({ ...k, concept: k.concept_key }))}</div>`
        : html`<div class="bubble tutor">${m.content}<div class="meta">${md.kind === 'greeting' ? 'greeting' : html`${md.strategy === 'verify' ? 'B' : 'A'} · ${md.intensity} · ${md.model} · reply ${ms(md.replyMs)}${md.checkMs != null ? ` · check ${ms(md.checkMs)}` : ''} · ${inr(md.costInr, 3)} · ${md.promptVersion}`}</div>
            ${md.dropped?.length ? html`<details><summary class="small muted">${md.dropped.length} correction${md.dropped.length === 1 ? '' : 's'} not shown</summary>${md.dropped.map(droppedBox)}</details>` : ''}${md.checkError ? html`<div class="err small">check failed: ${md.checkError}</div>` : ''}</div>`;
    })}</div>`);
}

// ---- Lessons --------------------------------------------------------------------------------------
async function lessons() {
  const { lessons: rows } = await api('/lessons');
  show(html`<div class="page-head"><div><h1>Lessons</h1><p class="muted">Lessons come from <code>shared/lessons.json</code> and are loaded when the server starts; changed content becomes a new version.</p></div></div>
    <div class="card"><div class="table-wrap"><table><tr><th>Lesson</th><th>Kind</th><th class="num">Level</th><th class="num">Version</th><th class="num">Started</th><th class="num">Finished</th><th class="num">Average score</th></tr>
    ${rows.map((l) => html`<tr><td>${l.title}${l.active ? '' : html` <span class="badge">off</span>`}</td><td>${humanize(l.category)}</td><td class="num">${l.level}</td><td class="num">${l.version}</td><td class="num">${l.started}</td><td class="num">${l.completed}</td><td class="num">${l.avgScorePct == null ? '–' : `${l.avgScorePct}%`}</td></tr>`)}
    </table></div></div>`);
}

// ---- Team ----------------------------------------------------------------------------------------
const actionWords = { 'member.added': 'added', 'member.changed': 'changed', 'member.removed': 'removed', 'role.created': 'made role', 'role.changed': 'changed role', 'role.deleted': 'deleted role' };
function auditLine(c) {
  const d = c.detail || {};
  if (c.action === 'member.added') return `${c.target} as ${d.role}${d.name ? ` (${d.name})` : ''}`;
  if (c.action === 'member.changed') return `${c.target}: ${Object.entries(d.to || {}).map(([k, v]) => `${k} ${d.from?.[k] ?? '–'} → ${v}`).join(', ')}`;
  if (c.action === 'member.removed') return `${c.target} (was ${d.role})`;
  if (c.action === 'role.changed' && d.to?.permissions) return `${c.target}: ${d.to.permissions.join(', ') || 'no permissions'}`;
  return c.target;
}
const permChecks = (perms, chosen, { disabled = false } = {}) => html`<div class="perms">${Object.entries(perms).map(([k, label]) =>
  html`<label class="check small"><input type="checkbox" value="${k}" ${chosen.includes(k) ? raw('checked') : ''} ${disabled ? raw('disabled') : ''}> <span>${label}</span></label>`)}</div>`;

async function team() {
  const [t, a] = await Promise.all([api('/team'), api('/team/audit')]);
  const roleName = Object.fromEntries(t.roles.map((r) => [r.id, r.name]));
  const isOwner = me.role === 'owner';
  const mayGive = (r) => isOwner || (!r.everything && r.permissions.every(can));
  const roleOptions = (current) => t.roles.filter((r) => mayGive(r) || r.id === current).map((r) => html`<option value="${r.id}" ${r.id === current ? raw('selected') : ''}>${r.name}</option>`);
  const locked = (m) => m.fromServer || m.phone === me.phone || (m.role === 'owner' && !isOwner);
  show(html`
    <div class="page-head"><div><h1>Team</h1><p class="muted">Who can open this console and what each person can do. People sign in with their phone number (an SMS code). Changes apply at once.</p></div></div>
    <div class="card section"><h2>People</h2>
      <div class="table-wrap"><table><tr><th>Name</th><th>Phone</th><th>Role</th><th>Status</th><th>Last seen</th><th></th></tr>
      ${t.members.map((m) => html`<tr data-phone="${m.phone}">
        <td>${m.name || '–'}${m.phone === me.phone ? html` <span class="badge">you</span>` : ''}</td>
        <td>${m.phone}</td>
        <td>${locked(m) ? html`${roleName[m.role] || m.role}${m.fromServer ? html` <span class="muted small" data-tip="In ADMIN_PHONES on the server: always an owner, changed only there">· server settings</span>` : ''}` : html`<select data-role>${roleOptions(m.role)}</select>`}</td>
        <td>${m.active ? html`<span class="status good">active</span>` : html`<span class="status warn">paused</span>`}</td>
        <td class="small">${m.fromServer ? '–' : when(m.lastSeenAt)}</td>
        <td class="row end">${locked(m) ? '' : html`<button class="link" data-pause>${m.active ? 'Pause' : 'Resume'}</button><button class="link danger" data-remove>Remove</button>`}</td></tr>`)}
      </table></div>
      <form id="addm" class="row end" style="margin-top:14px">
        <label class="f">Phone number<input name="phone" type="tel" placeholder="+91 98765 43210" required></label>
        <label class="f">Name<input name="name" placeholder="Optional"></label>
        <label class="f">Role<select name="role">${roleOptions('support')}</select></label>
        <button class="primary" type="submit">Add</button>
      </form><p class="err" id="merr" role="alert"></p>
    </div>
    <div class="card section"><h2>Roles</h2><p class="muted small">What each role allows. Owner always has everything${isOwner ? '' : '; you can only give out permissions you have yourself'}.</p>
      <div class="grid g2">${t.roles.map((r) => html`<form class="card role" data-id="${r.id}">
        <div class="section-head"><h3>${r.name}</h3><span class="badge">${r.members} ${r.members === 1 ? 'person' : 'people'}</span></div>
        ${r.description ? html`<p class="muted small">${r.description}</p>` : ''}
        ${r.everything ? (r.description ? '' : html`<p class="small">Everything, including the team.</p>`) : html`${permChecks(t.permissions, r.permissions, { disabled: !mayGive(r) })}
          ${mayGive(r) ? html`<div class="row"><button class="primary" type="submit">Save</button>${r.builtin ? '' : html`<button type="button" class="link danger" data-delrole>Delete</button>`}</div>` : ''}`}
        <p class="err" data-err></p></form>`)}</div>
      <form id="addr" class="card" style="margin-top:14px"><h3>New role</h3>
        <div class="row"><label class="f">Name<input name="name" required maxlength="40" placeholder="e.g. Content team"></label><label class="f" style="flex:1">What it's for<input name="description" maxlength="200" placeholder="Optional"></label></div>
        ${permChecks(Object.fromEntries(Object.entries(t.permissions).filter(([k]) => isOwner || can(k))), [])}
        <div class="row"><button class="primary" type="submit">Make role</button></div><p class="err" id="rerr"></p></form>
    </div>
    <div class="card"><h2>Team changes</h2>${a.changes.length ? html`<div class="table-wrap"><table><tr><th>When</th><th>By</th><th>What</th><th>Details</th></tr>
      ${a.changes.map((c) => html`<tr><td>${when(c.at)}</td><td>${c.actor}</td><td>${actionWords[c.action] || c.action}</td><td class="small">${auditLine(c)}</td></tr>`)}</table></div>` : html`<p class="muted">No changes yet.</p>`}</div>`);

  const done = (msg) => { toast(msg); route(); };
  const member = (el) => decodeURIComponent(el.closest('tr').dataset.phone);
  const enc = encodeURIComponent;
  $('#addm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#merr').textContent = '';
    const f = new FormData(e.target);
    try { await api('/team/members', { method: 'POST', body: { phone: f.get('phone'), name: f.get('name') || undefined, role: f.get('role') } }); done('Added. They can sign in now.'); }
    catch (x) { $('#merr').textContent = x.message; }
  });
  for (const sel of $$('select[data-role]')) sel.addEventListener('change', async () => {
    try { await api(`/team/members/${enc(member(sel))}`, { method: 'PUT', body: { role: sel.value } }); done('Role changed'); }
    catch (x) { $('#merr').textContent = x.message; route(); }
  });
  for (const b of $$('[data-pause]')) b.addEventListener('click', async () => {
    const active = b.textContent !== 'Pause';
    try { await api(`/team/members/${enc(member(b))}`, { method: 'PUT', body: { active } }); done(active ? 'Access resumed' : 'Access paused'); }
    catch (x) { $('#merr').textContent = x.message; }
  });
  for (const b of $$('[data-remove]')) b.addEventListener('click', async () => {
    if (!confirm(`Remove ${member(b)} from the team? They lose access at once.`)) return;
    try { await api(`/team/members/${enc(member(b))}`, { method: 'DELETE' }); done('Removed'); }
    catch (x) { $('#merr').textContent = x.message; }
  });
  for (const form of $$('form.role')) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api(`/team/roles/${enc(form.dataset.id)}`, { method: 'PUT', body: { permissions: $$('input:checked', form).map((i) => i.value) } }); done('Role saved'); }
      catch (x) { $('[data-err]', form).textContent = x.message; }
    });
    $('[data-delrole]', form)?.addEventListener('click', async () => {
      if (!confirm('Delete this role?')) return;
      try { await api(`/team/roles/${enc(form.dataset.id)}`, { method: 'DELETE' }); done('Role deleted'); }
      catch (x) { $('[data-err]', form).textContent = x.message; }
    });
  }
  $('#addr').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#rerr').textContent = '';
    const f = new FormData(e.target);
    try { await api('/team/roles', { method: 'POST', body: { name: f.get('name'), description: f.get('description') || undefined, permissions: $$('#addr input:checked').map((i) => i.value) } }); done('Role made'); }
    catch (x) { $('#rerr').textContent = x.message; }
  });
}

boot().catch((e) => show(html`<div class="card"><h2>Can't start</h2><p class="err">${e.message}</p></div>`));
