// Live log panel: what the browser, the Sakhi server and Sarvam are doing, in order, as it happens.
// log(category, message, data?) adds a row; logPartial(text) updates one "partial transcript" row in place.

const MAX_ROWS = 1500;
const t0 = performance.now();
const CATS = {
  app: 'APP', state: 'STATE', tts: 'VOICE', mic: 'MIC', live: 'LIVE', relay: 'RELAY',
  stt: 'STT', turn: 'TURN', llm: 'LLM', score: 'SCORE', cost: 'COST', error: 'ERROR',
};

let listEl = null, countEl = null, filterEl = null, jumpEl = null;
let follow = true, partialRow = null, count = 0, filter = '';
const backlog = []; // rows logged before the panel exists

const stamp = () => {
  const ms = performance.now() - t0;
  const m = Math.floor(ms / 60000), s = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
};

function short(data) {
  if (data == null) return '';
  try { return typeof data === 'string' ? data : JSON.stringify(data); } catch { return String(data); }
}

function render(row) {
  const el = document.createElement('div');
  el.className = `lg lg-${row.cat}`;
  el.dataset.text = `${row.cat} ${row.msg} ${row.dataText}`.toLowerCase();
  const time = document.createElement('time'); time.textContent = row.time;
  const tag = document.createElement('b'); tag.textContent = CATS[row.cat] || row.cat.toUpperCase();
  const body = document.createElement('div'); body.className = 'lg-body';
  const msg = document.createElement('span'); msg.className = 'lg-msg'; msg.textContent = row.msg;
  body.append(msg);
  if (row.dataText) {
    if (row.dataText.length <= 110 && !row.dataText.includes('\n')) {
      const d = document.createElement('code'); d.textContent = row.dataText; body.append(d);
    } else {
      const det = document.createElement('details');
      const sum = document.createElement('summary'); sum.textContent = 'details';
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(row.data, null, 2);
      det.append(sum, pre); body.append(det);
    }
  }
  el.append(time, tag, body);
  if (filter && !el.dataset.text.includes(filter)) el.hidden = true;
  return el;
}

function append(el) {
  listEl.append(el);
  while (listEl.childElementCount > MAX_ROWS) listEl.firstElementChild.remove();
  countEl.textContent = `${count} events`;
  const n = document.getElementById('logsN'); if (n) n.textContent = count;
  if (follow) listEl.scrollTop = listEl.scrollHeight;
}

/** Add a log row. category: one of CATS keys. data: anything JSON-serialisable (shown inline or collapsible). */
export function log(cat, msg, data) {
  count++;
  partialRow = null;
  const row = { cat, msg, data, dataText: short(data), time: stamp() };
  console.debug(`[${row.time}] ${CATS[cat] || cat} ${msg}`, data ?? '');
  if (!listEl) return void backlog.push(row);
  append(render(row));
}

/** Show a streaming partial transcript, updating the same row until something else is logged. */
export function logPartial(text) {
  if (!listEl) return;
  if (!partialRow) {
    count++;
    partialRow = render({ cat: 'stt', msg: '', data: null, dataText: '', time: stamp() });
    partialRow.classList.add('lg-partial');
    append(partialRow);
  }
  partialRow.querySelector('time').textContent = stamp();
  partialRow.querySelector('.lg-msg').textContent = `partial: ${text}`;
  partialRow.dataset.text = `stt partial ${text}`.toLowerCase();
  if (follow) listEl.scrollTop = listEl.scrollHeight;
}

const HIDE_KEY = 'sakhi.logsHidden';
function setHidden(hidden) {
  document.body.classList.toggle('logs-hidden', hidden);
  document.getElementById('logsOpen').hidden = !hidden;
  try { localStorage.setItem(HIDE_KEY, hidden ? '1' : '0'); } catch { /* storage unavailable */ }
}

/** Build the panel inside `root` (an <aside>). */
export function initLogPanel(root) {
  root.innerHTML = `
    <div class="logs-head">
      <strong>Developer log · <span id="logsN">0</span></strong>
      <span class="logs-count" id="logsCount">0 events</span>
      <input id="logsFilter" type="search" placeholder="Filter (e.g. llm, error, v4)" aria-label="Filter logs">
      <div class="logs-actions">
        <a href="/mic-test.html" target="_blank" rel="noopener">Mic test</a>
        <a href="/stt-lab.html" target="_blank" rel="noopener">STT lab</a>
        <a href="/review.html" target="_blank" rel="noopener">Review questions</a>
        <a href="/cutoffs.html" target="_blank" rel="noopener">Level cut-offs</a>
        <button type="button" id="logsCopy">Copy</button>
        <button type="button" id="logsClear">Clear</button>
        <button type="button" id="logsHide">Hide</button>
      </div>
    </div>
    <div class="logs-list" id="logsList" role="log" aria-live="off"></div>
    <button type="button" class="logs-jump" id="logsJump" hidden>↓ Latest</button>`;
  listEl = root.querySelector('#logsList');
  countEl = root.querySelector('#logsCount');
  filterEl = root.querySelector('#logsFilter');
  jumpEl = root.querySelector('#logsJump');

  listEl.addEventListener('scroll', () => {
    follow = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 24;
    jumpEl.hidden = follow;
  });
  jumpEl.addEventListener('click', () => { follow = true; jumpEl.hidden = true; listEl.scrollTop = listEl.scrollHeight; });
  filterEl.addEventListener('input', () => {
    filter = filterEl.value.trim().toLowerCase();
    for (const el of listEl.children) el.hidden = !!filter && !el.dataset.text.includes(filter);
  });
  root.querySelector('#logsClear').addEventListener('click', () => { listEl.textContent = ''; partialRow = null; count = 0; countEl.textContent = '0 events'; });
  root.querySelector('#logsCopy').addEventListener('click', async (e) => {
    const text = [...listEl.children].map((el) => {
      const pre = el.querySelector('pre')?.textContent;
      const code = el.querySelector('code')?.textContent;
      return `${el.querySelector('time').textContent} [${el.querySelector('b').textContent}] ${el.querySelector('.lg-msg').textContent}${code ? ' ' + code : ''}${pre ? '\n' + pre : ''}`;
    }).join('\n');
    const btn = e.currentTarget;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
      ta.remove();
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  });
  root.querySelector('#logsHide').addEventListener('click', () => setHidden(true));
  document.getElementById('logsOpen').addEventListener('click', () => setHidden(false));

  let hidden = false;
  try { hidden = localStorage.getItem(HIDE_KEY) === '1'; } catch { /* storage unavailable */ }
  setHidden(hidden);

  for (const row of backlog.splice(0)) append(render(row));
  window.addEventListener('error', (e) => log('error', `Uncaught: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => log('error', `Unhandled promise rejection: ${e.reason?.message || e.reason}`));
}
