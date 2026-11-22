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
// Sign-in: by OTP through this server (MSG91) when it's set up, else Firebase's phone sign-in in the browser.
// The OTP session token is kept for this browser tab only (sessionStorage), never in the page's address.
let auth = null; // Firebase, when that's the way in
const TOKEN_KEY = 'adam.admin.token';
const tokenStore = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(v) { try { if (v) sessionStorage.setItem(TOKEN_KEY, v); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};
const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.2';
const loadScript = (src) => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error(`could not load ${src}`)); document.head.append(s); });

async function bearer() {
  if (auth?.currentUser) return auth.currentUser.getIdToken();
  return tokenStore.get();
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = body ? { 'content-type': 'application/json' } : {};
  const token = await bearer();
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
  if (auth) await auth.signOut();
  const t = tokenStore.get();
  tokenStore.set(null);
  if (t) await post('/api/auth/logout', {}, t).catch(() => {});
  location.reload();
}

let me = { permissions: [] };
const can = (p) => me.permissions.includes(p);
// The permission each page needs.
const NEEDS = { overview: 'dashboard.view', settings: 'settings.view', playground: 'playground.use', models: 'playground.use', evals: 'evals.view', conversations: 'conversations.view', lessons: 'lessons.view', team: 'team.manage' };

async function boot() {
  const cfg = await fetch('/api/admin/config').then((r) => r.json());
  if (cfg.loginRequired && cfg.login === 'otp') {
    if (!tokenStore.get()) return otpLoginPage();
  } else if (cfg.loginRequired) {
    if (!cfg.firebase) return show(html`<div class="card login"><h1>Sign-in isn't set up</h1><p>This server has no OTP sign-in (MSG91) and no <code>FIREBASE_WEB_API_KEY</code>. See <code>deploy/README.md</code> → "Admin console".</p></div>`);
    await loadScript(`${FIREBASE}/firebase-app-compat.js`);
    await loadScript(`${FIREBASE}/firebase-auth-compat.js`);
    firebase.initializeApp(cfg.firebase);
    auth = firebase.auth();
    await new Promise((ok) => { const off = auth.onAuthStateChanged(() => { off(); ok(); }); });
    if (!auth.currentUser) return firebaseLoginPage();
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

function firebaseLoginPage() {
  show(loginForm());
  $('#again').hidden = true;
  const verifier = new firebase.auth.RecaptchaVerifier('send', { size: 'invisible' });
  let confirmation = null;
  $('#step1').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#lerr').textContent = '';
    try { confirmation = await auth.signInWithPhoneNumber($('#phone').value.replace(/\s+/g, ''), verifier); $('#step1').hidden = true; $('#step2').hidden = false; $('#code').focus(); }
    catch (x) { $('#lerr').textContent = x.message; }
  });
  $('#step2').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#lerr').textContent = '';
    try { await confirmation.confirm($('#code').value.trim()); location.reload(); } catch (x) { $('#lerr').textContent = x.message; }
  });
}

const PAGES = { overview, settings, playground, models, evals, conversations, lessons, team };
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
    <p class="muted small">Spend is counted by this server since midnight (India time); AI cost in the last 24 h from saved replies: ${inr(lat?.costInr)}. Check errors (7 days): ${n0(o.quality?.checkErrors)}.</p>`);
  drawCharts();
  $('#refresh').addEventListener('click', route);
}

// ---- Settings -------------------------------------------------------------------------------------
const ORDER = ['placement', 'payments', 'corrections', 'llm', 'conversation', 'limits', 'features', 'scoring'];
const JOBS = { tutor: 'Tutor replies', verify: 'Correction check (strategy B)', lessonEval: 'Lesson marking' };
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
  'placement.brain': { label: 'AI for each turn (conversation)' },
  'placement.summary': { label: 'AI for the closing feedback (conversation)' },
  'placement.maxQuestions': { label: 'Most open questions in a conversation', help: '1 to 6, after the name, picture and reading. The talk ends sooner when the level is clear.' },
  'conversation.historyMessages': { label: 'Recent messages the tutor reads', help: 'More = better memory of the conversation, slightly slower and costlier.' },
  'limits.dailyBudgetInr': { label: 'Daily budget (₹)', help: 'When today’s AI spend reaches this, new conversations and messages pause until tomorrow.' },
  'limits.sessionsPerIpPerHour': { label: 'Placement tests per learner per hour' },
  'limits.turnsPerSession': { label: 'Turns in one placement test' },
  'limits.listenSecPerSession': { label: 'Listening seconds per placement test' },
  'limits.learnMessagesPerDay': { label: 'Practice messages per learner per day' },
  'payments.enabled': { type: 'bool', label: 'Learning needs a subscription (the paywall is on)' },
  'payments.priceInr': { label: 'Price per month (₹)', help: 'A new price makes a new Razorpay plan; people already subscribed keep their price.' },
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
const providerName = (p) => PROVIDERS[p] || p;

function field(path, value, providers) {
  const m = META[path] || {}, key = path.split('.').pop();
  const label = m.label || humanize(key);
  if (path.endsWith('.provider')) {
    return html`<label class="f">Provider<select data-path="${path}" data-type="string">${Object.entries(providers).map(([p, v]) => html`<option value="${p}" ${p === value ? raw('selected') : ''} ${!v.configured && p !== value ? raw('disabled') : ''}>${p === 'sarvam' ? 'Sarvam (default)' : providerName(p)}${v.configured ? '' : ' (no API key on the server)'}</option>`)}</select></label>`;
  }
  if (path.endsWith('.model')) return html`<label class="f">Model<input data-path="${path}" data-type="string" value="${value}" list="models"></label>`;
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
// Type what a learner says; the first model runs a real conversation placement and the others get exactly the
// same turns, shown side by side (server/admin/placementLab.js). Nothing is saved.
const LEVEL_WORDS = { 1: 'Beginner', 2: 'Basic', 3: 'Good', 4: 'Very good' };
const LEARNER_EVENTS = { no_speech: '(said nothing)', skip: '(skipped)', in_hindi: '(asked for Hindi)' };
let labPicks = null; // { primary: {provider, model}, others: [...] }: kept for "Start again" and later visits

const levelBadge = (x) => (x.answered === false ? html`<span class="badge">Not an answer</span>`
  : x.level == null ? html`<span class="muted small">–</span>` : html`<span class="badge on">Level ${x.level} · ${LEVEL_WORDS[x.level] || ''}</span>`);
const lines = (list) => list.filter(Boolean).map((l) => html`<p>${l}</p>`);
const tokens = (u) => (u && (u.input || u.output) ? `${n0(u.input)} in${u.cached ? ` (${n0(u.cached)} cached)` : ''} · ${n0(u.output)} out${u.reasoning ? ` (${n0(u.reasoning)} thinking)` : ''}` : '–');
const speedCost = (x) => html`<p class="small muted lab-meta">Speed ${ms(x.ms)} · cost ${inr(x.costInr, 3)}<br>Tokens: ${tokens(x.usage)}</p>`;
/** Adds one AI call to a model's running total for the talk. */
function addUse(totals, x) {
  if (!x || x.error || !('ms' in x) || x.ms == null) return;
  const t = (totals[x.model] ||= { calls: 0, ms: 0, cost: 0, priced: true, input: 0, cached: 0, output: 0, reasoning: 0 });
  t.calls++; t.ms += x.ms || 0;
  if (x.costInr == null) t.priced = false; else t.cost += x.costInr;
  for (const k of ['input', 'cached', 'output', 'reasoning']) t[k] += x.usage?.[k] || 0;
}
const totalLine = (t) => (t ? html`<h3>The whole talk</h3><p class="small">${t.calls} AI call${t.calls === 1 ? '' : 's'} · ${ms(t.ms)} in all · cost ${t.priced ? inr(t.cost, 3) : '– (add this model\'s price to see it)'}<br>Tokens: ${tokens(t)}</p>` : '');

function progressLine(ratings, q) {
  const parts = [];
  if (ratings.length) parts.push(`Answers so far: ${ratings.map((r) => `level ${r.level} (asked ${r.asked}${r.missed ? ", couldn't answer" : ''})`).join(', ')}`);
  if (q) parts.push(q.step === 'hello' ? 'Now: asking their name (not counted)'
    : q.step === 'picture' ? `Now: a picture on their screen (${q.screen}). Type what they call it`
    : q.step === 'read' ? `Now: a line on their screen to read out loud: "${q.screen}". Type what they read`
    : `Now: open question ${q.n}, a level ${q.level} question`);
  return parts.join(' · ');
}

/** One model's answer to a turn. say: what Sakhi actually said (used for the first model when it made no AI call). */
function labTurnCol(x, first, say) {
  if (x.error) return html`<div class="card lab-col ${first ? 'first' : ''}">${labHead(x, first)}<p class="err">${x.error}</p></div>`;
  const fromAi = x.reply || x.question;
  const counted = first && x.counted ? (x.counted.missed ? `counted as level ${x.counted.level} (couldn't answer)`
    : x.level != null && x.counted.level !== x.level ? `counted as level ${x.counted.level} (measured words)` : '') : '';
  const rated = 'level' in x || 'answered' in x;
  return html`<div class="card lab-col ${first ? 'first' : ''}">${labHead(x, first)}
    <h3>Sakhi says</h3>
    <div class="lab-say">${fromAi ? lines([x.reply, x.question]) : html`${lines(say)}<p class="small muted">Fixed lines, no AI call this turn.</p>`}</div>
    ${rated || counted ? html`<h3>Level given</h3><p>${levelBadge(x)}${counted ? html` <span class="small muted">${counted}</span>` : ''}</p>` : ''}
    ${x.evidence ? html`<p class="small">${x.evidence}</p>` : ''}
    ${x.tip ? html`<h3>Fix</h3><div class="corr"><span class="was">${x.tip.said}</span> → <strong>${x.tip.better}</strong></div>` : ''}
    ${'ms' in x ? speedCost(x) : ''}</div>`;
}
const labHead = (x, first) => html`<div class="lab-model"><strong>${x.model}</strong>${first ? html` <span class="badge on">runs the conversation</span>` : ''}</div>`;

/** One model's closing feedback. say: Sakhi's last lines (the first model's). */
function labEndCol(x, first, say, totals = {}) {
  const list = (title, items) => (items?.length ? html`<h3>${title}</h3><ul class="lab-list">${items.map((i) => html`<li>${i}</li>`)}</ul>` : '');
  if (x.error) return html`<div class="card lab-col ${first ? 'first' : ''}">${labHead(x, first)}<p class="err">${x.error}</p></div>`;
  const closing = first ? say : x.closing ? [x.closing].flat() : [];
  return html`<div class="card lab-col ${first ? 'first' : ''}">${labHead(x, first)}
    ${list('What you did well', x.doingWell)}${list('What we’ll practise next', x.practise)}
    ${closing.length ? html`<h3>Says at the end</h3><div class="lab-say">${lines(closing)}</div>` : ''}
    ${x.fallback ? html`<p class="small muted">Plain lines were used: ${x.fallback}</p>` : ''}
    ${speedCost(x)}${totalLine(totals[x.model])}</div>`;
}

async function models() {
  const info = await api('/placement-lab');
  const provs = [...Object.keys(PROVIDERS).filter((p) => p in info.providers), ...Object.keys(info.providers).filter((p) => !(p in PROVIDERS))];
  const ok = (p) => !!info.providers[p]?.configured;
  const sugg = (p) => info.suggestions?.[p] || [];
  if (!labPicks) { const b = info.current?.brain || {}; labPicks = { primary: { provider: b.provider, model: b.model || '' }, others: [] }; }
  if (!ok(labPicks.primary.provider)) { const p = provs.find(ok); if (p) labPicks.primary = { provider: p, model: sugg(p)[0] || '' }; }

  show(html`
    <div class="page-head"><div><h1>Compare models</h1><p class="muted">Try AI models for the conversation placement test side by side: type what a learner would say and see how each model replies, which level it gives and what tip it offers. The final level is not the AI's opinion: a fixed rule takes the highest level the learner reached in two answers. Nothing is saved.</p></div></div>
    ${provs.map((p) => html`<datalist id="sugg-${p}">${sugg(p).map((m) => html`<option value="${m}">`)}</datalist>`)}
    <div id="lab"></div>`);
  const box = $('#lab');

  const pickRow = (m, i) => html`<div class="row end pick" data-i="${i}">
    <label class="f">Provider<select data-prov>${provs.map((p) => html`<option value="${p}" ${p === m.provider ? raw('selected') : ''} ${i < 0 && !ok(p) ? raw('disabled') : ''}>${providerName(p)}${ok(p) ? '' : ' (no API key on the server)'}</option>`)}</select></label>
    <label class="f grow">Model<input data-model value="${m.model}" list="sugg-${m.provider}" maxlength="100" autocomplete="off" required></label>
    ${i >= 0 ? html`<button type="button" class="link danger" data-remove>Remove</button>` : ''}
    <details class="lab-price"><summary class="small muted">Price (optional, to show cost for models the server has no price for)</summary>
      <div class="row"><label class="f">Input, $ per 1M tokens<input type="number" min="0" step="any" data-price="input" value="${m.price?.input ?? ''}"></label>
      <label class="f">Cached input, $ per 1M<input type="number" min="0" step="any" data-price="cached" value="${m.price?.cached ?? ''}"></label>
      <label class="f">Output, $ per 1M<input type="number" min="0" step="any" data-price="output" value="${m.price?.output ?? ''}"></label></div>
      <p class="small muted">From the provider's pricing page. Sarvam and Claude prices are already known. Leave empty otherwise.</p></details></div>`;
  const readPick = (row) => {
    const num = (k) => { const v = $(`[data-price="${k}"]`, row).value; return v === '' ? undefined : Number(v); };
    const price = num('input') != null && num('output') != null ? { input: num('input'), output: num('output'), ...(num('cached') != null ? { cached: num('cached') } : {}) } : undefined;
    return { provider: $('[data-prov]', row).value, model: $('[data-model]', row).value.trim(), ...(price ? { price } : {}) };
  };
  const readPicks = () => ({ primary: readPick($('.pick[data-i="-1"]', box)), others: $$('#others .pick', box).map(readPick) });

  function setup() {
    box.innerHTML = fmt(html`<form class="card section" id="setup" novalidate>
      <h2>Model that runs the conversation</h2>
      ${pickRow(labPicks.primary, -1)}
      <h3>Also compare</h3>
      <p class="muted small">Up to three more models. They get exactly the same turns and their answers are shown beside the first one, but only the first model's words are used in the talk.</p>
      <div id="others">${labPicks.others.map(pickRow)}</div>
      ${labPicks.others.length < 3 ? html`<p><button type="button" id="addm">Add a model to compare</button></p>` : ''}
      <p class="muted small">API keys are added on the server with <code>deploy/llm-keys-setup.sh</code>. This page spends real AI credit.</p>
      <p class="err" id="serr" role="alert"></p>
      <div class="row"><button class="primary" type="submit">Start a conversation</button></div></form>`);
    for (const sel of $$('[data-prov]', box)) sel.addEventListener('change', () => {
      const input = $('[data-model]', sel.closest('.pick'));
      input.setAttribute('list', `sugg-${sel.value}`);
      if (!sugg(sel.value).includes(input.value)) input.value = sugg(sel.value)[0] || '';
    });
    for (const b of $$('[data-remove]', box)) b.addEventListener('click', () => {
      const i = Number(b.closest('.pick').dataset.i);
      labPicks = readPicks(); labPicks.others.splice(i, 1); setup();
    });
    $('#addm', box)?.addEventListener('click', () => {
      labPicks = readPicks();
      const p = labPicks.primary.provider, used = [labPicks.primary, ...labPicks.others].map((m) => m.model);
      labPicks.others.push({ provider: p, model: sugg(p).find((m) => !used.includes(m)) || '' });
      setup();
      $$('#others [data-model]', box).at(-1)?.focus();
    });
    $('#setup', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#serr', box); err.textContent = '';
      labPicks = readPicks();
      if ([labPicks.primary, ...labPicks.others].some((m) => !m.model)) { err.textContent = 'Type a model name in every row.'; return; }
      const btn = $('button[type=submit]', e.target); btn.disabled = true;
      try { const r = await api('/placement-lab/start', { method: 'POST', body: labPicks }); if (box.isConnected) talk(r, structuredClone(labPicks)); }
      catch (x) { err.textContent = x.message; btn.disabled = false; }
    });
  }

  function talk(start, picks) {
    box.innerHTML = fmt(html`<div class="card section">
      <div class="section-head"><h2>Conversation</h2><span class="small muted lab-model">${start.models.map((m) => m.model).join(' · ')}</span></div>
      <div id="log"><div class="bubble tutor"><div class="meta">Sakhi</div>${lines(start.say)}</div></div>
      <div id="foot">
        <p class="small muted lab-progress" id="progress">${progressLine([], start.question)}</p>
        <form id="turn" class="lab-input">
          <div class="row end"><label class="f grow">What the learner says<input id="said" maxlength="2000" autocomplete="off" placeholder="In the morning I go to the market…"></label>
            <button class="primary" type="submit">Send</button></div>
          <div class="row lab-events"><button type="button" data-event="no_speech">Says nothing</button><button type="button" data-event="skip">Skips</button><button type="button" data-event="in_hindi">Asks for Hindi</button>
            <span class="small muted" id="wait" hidden><span class="spin"></span> Waiting for the models. This can take several seconds.</span></div>
          <p class="err" id="terr" role="alert"></p>
        </form>
      </div></div>`);
    const form = $('#turn', box), input = $('#said', box), log = $('#log', box);
    input.focus();
    const busy = (on) => { for (const el of $$('input, button', form)) el.disabled = on; $('#wait', box).hidden = !on; };
    const totals = {}; // per model: AI calls, time, tokens and cost over the whole talk

    async function send(event, message) {
      const err = $('#terr', box); err.textContent = '';
      if (event === 'answer' && !message) { err.textContent = 'Type what the learner says.'; return; }
      busy(true);
      let r;
      try { r = await api('/placement-lab/turn', { method: 'POST', body: { labId: start.labId, event, ...(event === 'answer' ? { message } : {}) } }); }
      catch (x) { if (box.isConnected) { err.textContent = x.message; busy(false); input.focus(); } return; }
      if (!box.isConnected) return;
      const turn = document.createElement('div');
      turn.className = 'lab-turn';
      turn.innerHTML = fmt(html`<div class="bubble learner">${event === 'answer' ? message : html`<span class="muted">${LEARNER_EVENTS[event]}</span>`}<div class="meta">Learner</div></div>
        <div class="lab-cols">${labTurnCol(r.primary, true, r.done ? [] : r.say)}${r.others.map((x) => labTurnCol(x, false))}</div>
        ${!r.others.length && picks.others.length ? html`<p class="small muted">The name, the picture and the reading use fixed lines, so no model is asked here. ${picks.others.map((m) => m.model).join(' and ')} will answer beside the first model from the open question onwards.</p>` : ''}`);
      log.append(turn);
      for (const x of [r.primary, ...r.others, ...(r.done ? [r.done.primary, ...r.done.others] : [])]) addUse(totals, x);
      $('#progress', box).textContent = progressLine(r.ratings || [], r.done ? null : r.question);
      if (r.done) { form.hidden = true; result(r, picks, totals); return; }
      input.value = ''; busy(false); input.focus();
      turn.scrollIntoView({ block: 'start' });
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); send('answer', input.value.trim()); });
    for (const b of $$('[data-event]', form)) b.addEventListener('click', () => send(b.dataset.event));
  }

  function result(r, picks, totals) {
    const d = r.done, first = `${picks.primary.provider}/${picks.primary.model}`;
    const card = document.createElement('div');
    card.className = 'card section lab-result';
    card.innerHTML = fmt(html`<h2>Level ${d.level} of 4 · ${d.name}</h2>
      ${d.reasons?.length ? html`<h3>Why</h3><ul class="lab-list">${d.reasons.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
      <div class="lab-cols">${labEndCol(d.primary, true, r.say, totals)}${d.others.map((x) => labEndCol(x, false, null, totals))}</div>
      <div class="row" style="margin-top:14px"><button type="button" data-again>Start again</button>
        ${can('settings.edit') ? html`<button type="button" class="primary" data-use>Use ${first} for the placement test</button>` : ''}</div>
      <p class="err" data-err role="alert"></p>`);
    $('#foot', box).append(card);
    card.scrollIntoView({ block: 'start' });
    $('[data-again]', card).addEventListener('click', () => { labPicks = picks; setup(); box.scrollIntoView({ block: 'start' }); });
    $('[data-use]', card)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; $('[data-err]', card).textContent = '';
      try {
        const s = await api('/settings');
        const value = structuredClone(s.sections.placement.value);
        const { provider, model } = picks.primary;
        value.brain = { provider, model, temperature: value.brain.temperature };
        value.summary = { provider, model, temperature: value.summary.temperature };
        await api('/settings/placement', { method: 'PUT', body: { value } });
        toast(`Saved. New tests in conversation mode use ${model}.`);
      } catch (x) { $('[data-err]', card).textContent = x.message; }
      btn.disabled = false;
    });
  }

  setup();
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
