// Everything on screen except the orb: the conversation (Silk edge), the fanned task card, the hint, the
// connection notice, the microphone screen and the result. Implements the design handoff's motion system with
// classes and CSS custom properties; app.js drives it from the real conversation.

const LANGS = {
  hi: { tap: 'छूइए और बात कीजिए', listening: 'सुन रही हूँ…', wait: 'आराम से। जब तैयार हों, बोलिए।', speaking: 'बीच में भी बोल सकते हैं', thinking: 'एक पल…', notice: 'गोले को छूकर फिर कोशिश करें', result: 'यहीं से शुरुआत करते हैं', native: { repeat: 'दोबारा सुनें', hindi: 'हिंदी में', done: 'बोल लिया', skip: 'आगे बढ़ें' } },
  pa: { tap: 'ਛੂਹੋ ਤੇ ਗੱਲ ਕਰੀਏ', listening: 'ਸੁਣ ਰਹੀ ਹਾਂ…', wait: 'ਆਰਾਮ ਨਾਲ। ਜਦੋਂ ਤਿਆਰ ਹੋਵੋ, ਬੋਲੋ।', speaking: 'ਵਿੱਚੋਂ ਵੀ ਬੋਲ ਸਕਦੇ ਹੋ', thinking: 'ਇੱਕ ਪਲ…', native: { repeat: 'ਦੁਬਾਰਾ ਸੁਣੋ', hindi: 'ਪੰਜਾਬੀ ਵਿੱਚ', done: 'ਬੋਲ ਲਿਆ', skip: 'ਅੱਗੇ ਚੱਲੋ' } },
  ta: { tap: 'தொட்டுப் பேசலாம்', listening: 'கேட்கிறேன்…', wait: 'நிதானமாக. தயாரானதும் பேசுங்கள்.', speaking: 'இடையில் பேசலாம்', thinking: 'ஒரு நொடி…', native: { repeat: 'மீண்டும் கேள்', hindi: 'தமிழில்', done: 'பேசி முடித்தேன்', skip: 'அடுத்தது' } },
  bn: { tap: 'ছুঁয়ে কথা বলুন', listening: 'শুনছি…', wait: 'ধীরে সুস্থে। তৈরি হলে বলুন।', speaking: 'মাঝখানেও বলতে পারেন', thinking: 'এক মুহূর্ত…', native: { repeat: 'আবার শুনুন', hindi: 'বাংলায়', done: 'বলা শেষ', skip: 'এগিয়ে যান' } },
};
const HINT_EN = {
  idle: 'Tap and let’s talk', notice: 'Tap the orb to try again', speaking: 'You can interrupt anytime',
  listening: 'Listening… pause when you’re done', thinking: 'One moment…', result: 'This is where we start', wait: 'Take your time. Whenever you’re ready.',
};
const HINT_KEY = { idle: 'tap', notice: 'notice', speaking: 'speaking', listening: 'listening', thinking: 'thinking', result: 'result', wait: 'wait' };
const ORB_LABEL = { idle: 'Start talking with Sakhi', speaking: 'Sakhi is speaking. Tap to interrupt', listening: 'Listening. Tap when you are done', thinking: 'Sakhi is thinking' };
const SKILLS = [['comprehension', 'Understanding'], ['vocabulary', 'English words'], ['grammar', 'Making sentences'], ['fluency', 'Speaking smoothly'], ['pronunciation', 'Saying words clearly'], ['coherence', 'Joining ideas']];
const SKILL_WORDS = ['Just starting', 'Growing', 'Steady', 'Strong', 'Shining'];
const MAX_ALIVE = 9;

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const later = (fn, ms) => setTimeout(fn, ms);
const langAttr = (code) => (code ? code.slice(0, 2) : 'en');

export function createUI(app, { onRestart } = {}) {
  const $ = (id) => document.getElementById(id);
  const convo = $('convo'), card = $('card'), cardRow = $('cardRow'), hint = $('hint'), noticeRow = $('noticeRow'), orbBtn = $('orb');
  const reduced = () => app.classList.contains('rm') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lang = 'hi', hintKey = null, waitOn = false, noticeOn = false;
  let thinkRow = null; // the "…" bubble that becomes Sakhi's next line

  // ---------- theme ----------
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const setTheme = () => { app.dataset.theme = new URLSearchParams(location.search).get('theme') || (dark.matches ? 'dark' : 'light'); };
  setTheme(); dark.addEventListener?.('change', setTheme);
  if (new URLSearchParams(location.search).get('rm') === '1') app.classList.add('rm');

  // ---------- hint ----------
  function renderHint() {
    const session = app.dataset.session;
    const key = noticeOn ? 'notice' : session === 'idle' ? 'idle' : session === 'result' ? 'result' : waitOn && app.dataset.state === 'listening' ? 'wait' : app.dataset.state;
    if (key === hintKey || !HINT_EN[key]) return;
    hint.querySelectorAll('.hint-layer.out').forEach((n) => n.remove());
    hint.querySelectorAll('.hint-layer').forEach((n) => { n.classList.remove('in'); n.classList.add('out'); later(() => n.remove(), 220); });
    hintKey = key;
    const L = LANGS[lang] || LANGS.hi, sub = L[HINT_KEY[key]] ?? LANGS.hi[HINT_KEY[key]] ?? '', subLang = L[HINT_KEY[key]] != null ? lang : 'hi';
    const layer = el('span', 'hint-layer in', `<span class="hint-en">${esc(HINT_EN[key])}</span>${sub ? `<span class="hint-sub" lang="${subLang}">${esc(sub)}</span>` : ''}`);
    hint.append(layer);
  }

  // ---------- session / state ----------
  function setState(state) {
    if (app.dataset.state === state) return;
    app.dataset.state = state;
    orbBtn.setAttribute('aria-label', ORB_LABEL[state] || ORB_LABEL.idle);
    if (state !== 'listening') waitOn = false;
    renderHint();
  }
  function setSession(session) { app.dataset.session = session; renderHint(); }
  function setLanguage(code) {
    const l = { 'pa-IN': 'pa', 'ta-IN': 'ta', 'bn-IN': 'bn' }[code] || 'hi';
    if (l === lang) return;
    lang = l; hintKey = null; renderHint();
    const L = LANGS[lang];
    document.querySelectorAll('#chips [data-native]').forEach((s) => { s.textContent = L.native[s.dataset.native]; s.lang = lang; });
  }
  function setWait(on) { waitOn = on; renderHint(); }

  // ---------- conversation ----------
  function alive() { return [...convo.querySelectorAll('.row:not(.leaving)')]; }
  function addRow(role, bubble) {
    const row = el('div', `row entering ${role}`);
    const clip = el('div', 'clip'), wrap = el('div', 'bwrap');
    wrap.append(bubble); clip.append(wrap); row.append(clip); convo.append(row);
    requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove('entering')));
    const rows = alive();
    if (rows.length > MAX_ALIVE) { const old = rows[0]; old.classList.add('leaving'); later(() => old.remove(), 460); }
    return row;
  }
  /** The focused Sakhi bubble has an absolutely positioned inner; size the outer box to it (animated). */
  function measure(msg) {
    const inner = msg.querySelector('.inner');
    if (msg.dataset.tier !== 'focus') { msg.style.width = ''; msg.style.height = ''; return; }
    msg.style.width = `${inner.offsetWidth + 4}px`; msg.style.height = `${inner.offsetHeight + 4}px`;
  }
  function demote(msg) {
    if (!msg || msg.dataset.tier === 'history') return;
    msg.dataset.tier = 'history';
    msg.style.width = ''; msg.style.height = '';
  }
  const focusSakhi = () => [...convo.querySelectorAll('.msg.sakhi[data-tier="focus"]')];
  const focusYou = () => [...convo.querySelectorAll('.msg.you[data-tier="focus"]:not(.live)')];

  function sakhiBubble() {
    const msg = el('div', 'msg sakhi');
    msg.dataset.tier = 'focus';
    msg.append(el('span', 'ring'), el('span', 'dash'), el('div', 'inner'));
    return msg;
  }

  /** Show "…" while Sakhi prepares her reply. It becomes her next line in place. */
  function thinking() {
    if (thinkRow) return;
    focusSakhi().forEach(demote);
    const msg = sakhiBubble();
    msg.classList.add('think');
    msg.querySelector('.inner').append(el('span', 'dots', '<i></i><i></i><i></i>'));
    thinkRow = addRow('sakhi', msg);
    requestAnimationFrame(() => measure(msg));
  }

  /**
   * Sakhi starts a line: all its words are laid out at once (invisible), so the bubble has its final size from
   * the first frame; reveal(n) shows the first n words as she says them. → { reveal(n), cut(n), words }
   */
  function sakhiLine(text, voiceLang) {
    const words = text.split(/\s+/).filter(Boolean);
    let msg;
    if (thinkRow) { msg = thinkRow.querySelector('.msg'); msg.classList.remove('think'); thinkRow = null; }
    else { focusSakhi().forEach(demote); msg = sakhiBubble(); addRow('sakhi', msg); }
    focusSakhi().filter((m) => m !== msg).forEach(demote);
    focusYou().forEach(demote); // your sent line becomes history when the reply arrives
    const inner = msg.querySelector('.inner');
    const p = el('p', 'words');
    p.lang = langAttr(voiceLang);
    p.innerHTML = words.map((w) => `<span>${esc(w)}</span>`).join(' ');
    inner.replaceChildren(p);
    requestAnimationFrame(() => measure(msg));
    const spans = [...p.children];
    let shown = 0;
    return {
      words: words.length,
      reveal(n) {
        n = Math.max(0, Math.min(words.length, n));
        if (n === shown) return;
        for (let i = 0; i < spans.length; i++) { spans[i].classList.toggle('on', i < n); spans[i].classList.toggle('hot', i === n - 1); }
        shown = n;
      },
      finish() { this.reveal(words.length); spans.forEach((s) => s.classList.remove('hot')); },
      /** Interrupted after n words: keep what was said, add " —", a dashed edge and a note. */
      cut(n) {
        n = Math.max(1, Math.min(words.length, n));
        spans.slice(n).forEach((s) => s.remove());
        spans[n - 1].textContent += ' —';
        spans.slice(0, n).forEach((s) => { s.classList.add('on'); s.classList.remove('hot'); });
        msg.classList.add('cut');
        inner.append(el('span', 'cut-note', 'You stepped in, so Sakhi paused'));
        requestAnimationFrame(() => measure(msg));
      },
    };
  }

  /** The learner's live bubble: "Listening…" with a fill that grows with what's heard. */
  function youLive() {
    const msg = el('div', 'msg you live');
    msg.dataset.tier = 'focus';
    msg.innerHTML = '<span class="fill"></span><div class="label"><span><span>Listening</span><span class="dots small"><i></i><i></i><i></i></span></span></div><span class="text">…</span>';
    const row = addRow('you', msg);
    const text = msg.querySelector('.text');
    return {
      partial(t) {
        if (!t) return;
        text.textContent = t;
        const n = t.split(/\s+/).length;
        msg.style.setProperty('--fill', `${Math.min(92, (n / Math.max(10, n + 3)) * 100)}%`);
      },
      /** The answer is complete: the fill completes and fades, the label folds away. */
      final(t) {
        if (!t) { row.classList.add('leaving'); later(() => row.remove(), 420); return; }
        text.textContent = t;
        msg.style.setProperty('--fill', '100%');
        later(() => msg.classList.remove('live'), 300);
      },
    };
  }

  /** On send: Sakhi's line becomes history, then "…" while she thinks. */
  function sent() { later(() => { focusSakhi().forEach(demote); thinking(); }, 380); }

  // ---------- task card ----------
  let cardNow = null, swapTimer = null, frontEl = null, cardHindiLock = false;
  function swapLang() {
    clearTimeout(swapTimer); cardHindiLock = false;
    const show = (hi) => {
      app.style.setProperty('--en-o', hi ? '0' : '1'); app.style.setProperty('--hi-o', hi ? '1' : '0');
      app.style.setProperty('--en-d', hi ? '0s' : '.6s'); app.style.setProperty('--hi-d', hi ? '.6s' : '0s');
      swapTimer = later(() => show(!hi), hi ? 7000 : 3500);
    };
    show(false);
  }
  function lockHindi() {
    if (!cardNow) return;
    clearTimeout(swapTimer); cardHindiLock = true;
    app.style.setProperty('--en-o', '0'); app.style.setProperty('--hi-o', '1'); app.style.setProperty('--en-d', '0s'); app.style.setProperty('--hi-d', '.24s');
  }
  function face(c) {
    const f = el('div', 'front');
    const prompt = c.look === 'emoji' ? `<span class="emoji">${esc(c.text)}</span>`
      : c.look === 'word' ? `<span class="word${c.text.length > 14 ? ' long' : ''}">${esc(c.text)}</span>`
      : `<p class="sentence">${esc(c.text)}</p>`;
    f.innerHTML = `<div class="band" aria-live="polite"><span class="en" lang="en">${esc(c.band?.en || '')}</span><span class="hi" lang="hi">${esc(c.band?.hi || '')}</span><span class="done">हो गया · Answered</span></div><div class="prompt">${prompt}</div>`;
    return f;
  }
  /** Show a card (or deal the next one onto the stack). Same card again: nothing moves. */
  function showCard(c) {
    if (cardNow && cardNow.text === c.text) { frontEl?.classList.remove('answered'); card.dataset.step = 'in'; frontEl && (frontEl.dataset.pose = 'in'); return; }
    if (!cardNow) {
      cardNow = c;
      app.classList.add('card-up');
      later(() => {
        card.dataset.kind = c.look; card.classList.toggle('read', c.kind === 'read');
        frontEl?.remove(); frontEl = face(c); frontEl.dataset.pose = 'pre'; card.append(frontEl);
        card.dataset.step = 'pre'; cardRow.classList.add('open');
      }, reduced() ? 0 : 120);
      later(() => { card.dataset.step = 'in'; if (frontEl) frontEl.dataset.pose = 'in'; }, reduced() ? 20 : 180);
      swapLang();
      return;
    }
    // Deal: the outgoing card flicks away left; the new one rises from the middle card's pose.
    cardNow = c;
    const out = frontEl; out.dataset.pose = 'out';
    later(() => out.remove(), 460);
    card.dataset.kind = c.look; card.classList.toggle('read', c.kind === 'read');
    frontEl = face(c); frontEl.dataset.pose = 'dealPre'; card.append(frontEl);
    card.dataset.step = 'dealPre';
    requestAnimationFrame(() => requestAnimationFrame(() => { card.dataset.step = 'deal'; frontEl.dataset.pose = 'deal'; }));
    later(() => { card.dataset.step = 'in'; frontEl.dataset.pose = 'in'; }, 800);
    swapLang();
  }
  function exitCard() {
    if (!cardNow) return;
    cardNow = null; clearTimeout(swapTimer);
    card.dataset.step = 'exiting'; if (frontEl) frontEl.dataset.pose = 'exiting';
    later(() => cardRow.classList.remove('open'), reduced() ? 0 : 240);
    later(() => app.classList.remove('card-up'), reduced() ? 0 : 380);
    later(() => { if (!cardNow) { frontEl?.remove(); frontEl = null; card.dataset.step = 'none'; } }, 900);
  }
  function cardAnswered() { if (cardNow && frontEl) { frontEl.classList.add('answered'); card.dataset.step = 'answered'; } }

  // ---------- notice and microphone ----------
  function notice(on) {
    noticeOn = on;
    app.classList.toggle('notice-on', on);
    if (on) { noticeRow.classList.add('open'); later(() => noticeRow.classList.add('in'), 30); }
    else { noticeRow.classList.remove('in'); later(() => noticeRow.classList.remove('open'), 200); }
    hintKey = null; renderHint();
  }
  function micError(on, onAllow) {
    const box = $('micError');
    box.hidden = !on;
    if (!on) return;
    $('micAllow').onclick = onAllow;
    $('micHow').onclick = () => { $('micHowText').hidden = !$('micHowText').hidden; };
  }

  // ---------- result ----------
  function result(r) {
    exitCard();
    const dims = r.dims || {};
    const skills = SKILLS.filter(([k]) => dims[k] != null).map(([k, label]) => {
      const n = Math.max(0, Math.min(4, Math.round(dims[k])));
      return `<div class="skill"><span class="nm">${label}</span><span class="wd">${SKILL_WORDS[n]}</span><span class="seg">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span></div>`;
    }).join('');
    const list = (xs) => (xs || []).map((x) => `<li>${esc(x)}</li>`).join('');
    const answers = (r.answers || []).filter((a) => a.transcript).map((a) => `<p><b>${esc(a.q.replace(/_/g, ' '))}</b>: ${esc(a.transcript)}</p>`).join('');
    $('result').innerHTML = `
      <span class="r-item r-eyebrow">Your level · Level ${r.level} of 4</span>
      <span class="r-item r-title">${esc(r.name)}</span>
      <span class="r-item r-lines"><span class="r-line">${esc(r.blurb)}</span>${r.hindi ? `<span class="r-hi" lang="hi">${esc(r.hindi)}</span>` : ''}</span>
      <button type="button" class="r-item btn-primary r-start" id="startLearning">Start learning · <span lang="hi">सीखना शुरू करें</span></button>
      ${r.doingWell?.length || r.practise?.length ? `<div class="r-item r-card">${r.doingWell?.length ? `<h3>What went well</h3><ul>${list(r.doingWell)}</ul>` : ''}${r.practise?.length ? `<h3>What we’ll practise next</h3><ul>${list(r.practise)}</ul>` : ''}</div>` : ''}
      ${skills ? `<div class="r-item r-card"><h3>Where you’re growing</h3>${skills}</div>` : ''}
      <details class="r-item r-how"><summary>How we decided</summary><div class="how-body">${r.reasons?.length ? `<ul>${list(r.reasons)}</ul>` : '<p>Your answers to all the questions, put together.</p>'}<div class="ans">${answers}</div></div></details>`;
    $('startLearning').onclick = () => onRestart?.();
    setSession('result'); setState('idle');
    later(() => app.classList.add('result-in'), 60);
  }

  renderHint();
  return { setState, setSession, setLanguage, setWait, thinking, sakhiLine, youLive, sent, showCard, exitCard, cardAnswered, lockHindi, notice, micError, result,
    get cardShown() { return cardNow; }, get hindiLocked() { return cardHindiLock; } };
}
