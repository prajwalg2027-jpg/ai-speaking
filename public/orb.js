// The orb: Molten glass with a tint cloud (design 2e). Builds the layers inside #orb and runs the one
// requestAnimationFrame loop that writes every per-frame variable on .app (--lvl, the hand-off spring --hand,
// the cloud's wall angle --cang, Sakhi's level --spk, the fluid jitter --cx/cy/cs/ct, silk turn and thinking).
// No CSS animation speed changes between states: state shows only through these speed and amount variables.
// Ported from the reference logic in the design handoff (tick(), stepFluid()).

const PUFFS = [[4, 6, 50, 0], [30, 0, 54, 6], [52, 8, 46, 7], [18, 24, 48, 8], [42, 26, 44, 9], [64, 22, 34, 3], [0, 30, 32, 12]];

function layers() {
  const puffs = PUFFS.map(([l, t, s, i]) => `<span class="o-abs o-puff" style="left:${l}%;top:${t}%;width:${s}%;height:${s}%;transform:translate(calc(var(--cx${i},0) * 1.6% * (1 - var(--hand) * .7)), calc(var(--cy${i},0) * 1.6% * (1 - var(--hand) * .7))) scale(calc(var(--cs${i},1) * (0.85 + var(--spk) * 0.3)), calc(var(--ct${i},1) * (0.85 + var(--spk) * 0.3)))"></span>`).join('');
  return `
    <span class="o-abs o-glowA"></span>
    <span class="o-abs o-glowT"></span>
    <span class="o-abs o-scale"><span class="o-abs o-spin"><span class="o-abs o-blob" data-anim>
      <span class="o-abs o-silk"><span class="o-abs o-pool p0" data-anim></span><span class="o-abs o-pool p1" data-anim></span><span class="o-abs o-pool p2" data-anim></span><span class="o-abs o-pool p3" data-anim></span></span>
      <span class="o-abs o-folds" data-anim></span>
      <span class="o-abs o-sheen" data-anim></span>
      <span class="o-abs o-edge"><span class="o-abs o-cloud"><span class="o-abs o-region">${puffs}</span></span><span class="o-abs o-wisp"></span></span>
      <span class="o-abs o-fill"><span class="o-abs o-wave w1"><i data-anim></i></span><span class="o-abs o-wave w2"><i data-anim></i></span></span>
      <span class="o-abs o-spec"></span>
    </span></span></span>`;
}

/**
 * createOrb(app, orbButton) → { setLevel(target 0..1), duck(), press() }
 * The phase (idle / speaking / listening / thinking) is read from app.dataset.state each frame.
 */
export function createOrb(app) {
  const breathe = app.querySelector('.orb-breathe');
  const press = document.createElement('span');
  press.className = 'orb-press';
  press.innerHTML = layers();
  breathe.append(press);

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let target = 0, lvl = 0, ducked = false, last = 0;
  let tsp = 16, turn = 0, think = 0, aura = 0, bspin = 0;
  let F = null;
  const s = app.style;

  function stepFluid(dt, phase) {
    const L = lvl;
    if (!F) {
      const rnd = () => Math.random() * 2 - 1;
      F = { cells: Array.from({ length: 14 }, () => ({ x: rnd() * 6, y: rnd() * 6, vx: 0, vy: 0, s: 0, vs: 0, a: 0, va: 0 })), reg: { x: 0, vx: 0, y: 0, vy: 0 },
        ang: { a: Math.random() * 360, v: 10 }, hand: 0, hv: 0, prev: 0, spk: 0, wasListening: false };
    }
    const g = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;
    const cl = (v, m) => Math.max(-m, Math.min(m, v));
    const listening = phase === 'listening';
    const onset = Math.max(0, L - F.prev); F.prev = L;
    const energy = (0.35 + L * 1.4) * (1 - F.hand * 0.6);
    const kick = onset > 0.06 ? onset * 260 * (1 - F.hand) : 0;
    F.cells.forEach((c, i) => {
      if (kick) { c.vx += g() * kick; c.vy += g() * kick; c.vs += g() * kick * 0.012; c.va += g() * kick * 0.012; }
      c.vx += (-5 * c.x - 2.2 * c.vx + g() * 170 * energy) * dt; c.x += c.vx * dt;
      c.vy += (-5 * c.y - 2.2 * c.vy + g() * 170 * energy) * dt; c.y += c.vy * dt;
      c.vs += (-9 * c.s - 3 * c.vs + g() * 2.6 * energy) * dt; c.s += c.vs * dt;
      c.va += (-9 * c.a - 3 * c.va + g() * 2.6 * energy) * dt; c.a += c.va * dt;
      s.setProperty(`--cx${i}`, cl(c.x, 26).toFixed(2)); s.setProperty(`--cy${i}`, cl(c.y, 26).toFixed(2));
      s.setProperty(`--cs${i}`, (1 + cl(c.s, 0.32)).toFixed(3)); s.setProperty(`--ct${i}`, (1 + cl(c.a, 0.32)).toFixed(3));
    });
    const r = F.reg;
    r.vx += (-7 * r.x - 3 * r.vx + g() * 1.8 * energy) * dt; r.x += r.vx * dt;
    r.vy += (-7 * r.y - 3 * r.vy + g() * 1.8 * energy) * dt; r.y += r.vy * dt;
    s.setProperty('--rx2', (1 + cl(r.x, 0.22)).toFixed(3)); s.setProperty('--ry2', (1 + cl(r.y, 0.22)).toFixed(3));
    // Hand-off: a slightly under-damped spring, so the liquid overshoots and settles. On hand-back, the cloud
    // travels to a fresh spot on the wall (never the bottom).
    const A = F.ang;
    if (F.wasListening && !listening) { const side = Math.random() < 0.5 ? -1 : 1; A.a = 180 + side * (115 + Math.random() * 110); A.v = side * 14; }
    F.wasListening = listening;
    const k = listening ? 38 : 24, damp = listening ? 8.5 : 7.2;
    F.hv += (((listening ? 1 : 0) - F.hand) * k - F.hv * damp) * dt; F.hand += F.hv * dt;
    const hand = Math.max(0, Math.min(1.08, F.hand));
    if (hand < 0.5) { A.v += (g() * 46 * energy - 0.7 * A.v + (kick ? g() * kick * 0.6 : 0)) * dt; A.v = cl(A.v, 70); A.a += A.v * dt; }
    const d = ((180 - A.a) % 360 + 540) % 360 - 180;
    const e = Math.min(1, hand), ease = e * e * (3 - 2 * e);
    const cang = A.a + d * ease;
    if (listening && hand > 0.97) { A.a = cang; A.v = 0; }
    F.spk += ((phase === 'speaking' ? L : 0) - F.spk) * 0.3;
    s.setProperty('--hand', hand.toFixed(3)); s.setProperty('--cang', cang.toFixed(2)); s.setProperty('--spk', F.spk.toFixed(3));
    s.setProperty('--hpulse', Math.max(0, Math.sin(Math.min(1, hand) * Math.PI)).toFixed(3));
  }

  function tick(t) {
    requestAnimationFrame(tick);
    const phase = app.dataset.state;
    const dt = Math.min(0.05, ((t - (last || t)) / 1000) || 0.016); last = t;
    const rm = mq.matches || app.classList.contains('rm');
    let tgt = phase === 'thinking' ? 0.12 : phase === 'idle' ? 0 : target;
    if (ducked) tgt = 0;
    if (rm) tgt *= 0.2;
    lvl += (tgt - lvl) * (tgt > lvl ? 0.38 : 0.14);
    s.setProperty('--lvl', lvl.toFixed(3));
    if (!rm) {
      const speed = { idle: 16, speaking: 51, listening: 22, thinking: 60 }[phase] ?? 16;
      tsp += (speed - tsp) * Math.min(1, dt * 2.5); turn += tsp * dt;
      think += ((phase === 'thinking' ? 1 : 0) - think) * Math.min(1, dt * 5);
      aura += (30 + think * 120) * dt; bspin += think * 140 * dt;
      stepFluid(dt, phase);
    } else {
      think = phase === 'thinking' ? 1 : 0;
      s.setProperty('--hand', phase === 'listening' ? '1' : '0'); s.setProperty('--cang', phase === 'listening' ? '180' : '0'); s.setProperty('--spk', phase === 'speaking' ? '0.3' : '0');
    }
    s.setProperty('--turn', turn.toFixed(1)); s.setProperty('--think', think.toFixed(3));
    s.setProperty('--aura', aura.toFixed(1)); s.setProperty('--bspin', bspin.toFixed(1));
  }
  requestAnimationFrame(tick);

  return {
    /** The audio level to show (0..1): Sakhi's voice while she speaks, the mic while listening. */
    setLevel(v) { target = Math.max(0, Math.min(1, v)); },
    /** Barge-in: the orb dips and Sakhi's level drops to zero. */
    duck() { ducked = true; press.classList.add('ducked'); setTimeout(() => { ducked = false; press.classList.remove('ducked'); }, 130); },
    /** A tap: a quick press. */
    press() { press.classList.add('pressed'); setTimeout(() => press.classList.remove('pressed'), 140); },
  };
}
