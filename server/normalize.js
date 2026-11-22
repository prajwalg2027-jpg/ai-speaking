// Text normalisation for comparing what was expected with what Sarvam heard.
//
// Speech recognition formats the same spoken words in different ways ("seven" / "7",
// "two hundred and fifty rupees" / "₹250", "it is" / "it's", "theatre" / "theater"), and it isn't
// consistent about it. Both texts go through normalizeForCompare() so only real recognition
// differences count. Canonical forms: numbers as digits, ordinals as "<n>ord", contractions
// expanded, American spellings, currency as "<n> rupees".

const SMALL = new Map(Object.entries({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}));
const ORDINAL = new Map(Object.entries({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60,
  seventieth: 70, eightieth: 80, ninetieth: 90,
}));
const SCALE = new Map(Object.entries({ hundred: 100, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, crore: 1e7, crores: 1e7, million: 1e6, billion: 1e9 }));

// British → American (Indian English uses British spellings; recognition may return either).
const SPELLING = new Map(Object.entries({
  theatre: 'theater', centre: 'center', metre: 'meter', litre: 'liter', colour: 'color', colours: 'colors',
  favourite: 'favorite', neighbour: 'neighbor', neighbours: 'neighbors', behaviour: 'behavior', honour: 'honor',
  labour: 'labor', flavour: 'flavor', humour: 'humor', organise: 'organize', organised: 'organized',
  realise: 'realize', realised: 'realized', recognise: 'recognize', apologise: 'apologize', travelling: 'traveling',
  travelled: 'traveled', cancelled: 'canceled', programme: 'program', defence: 'defense', licence: 'license',
  practise: 'practice', analyse: 'analyze', grey: 'gray', jewellery: 'jewelry', tyre: 'tire', tyres: 'tires',
  rupee: 'rupees', ok: 'okay',
}));

const CONTRACTIONS = [
  [/\bwon't\b/g, 'will not'], [/\bcan't\b/g, 'can not'], [/\bcannot\b/g, 'can not'], [/\bshan't\b/g, 'shall not'],
  [/\blet's\b/g, 'let us'], [/\bi'm\b/g, 'i am'],
  [/n't\b/g, ' not'], [/'re\b/g, ' are'], [/'ve\b/g, ' have'], [/'ll\b/g, ' will'], [/'d\b/g, ' would'],
  // "'s" means "is" only after these words; elsewhere it's a possessive ("Vikram's") and stays.
  [/\b(it|that|what|there|here|where|who|he|she|how|this)'s\b/g, '$1 is'],
];

const DEVANAGARI_DIGITS = /[०-९]/g;

/** Text-level clean-up before splitting into words. */
function prepare(text) {
  let t = (text || '').normalize('NFKC').toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(DEVANAGARI_DIGITS, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/(\d),(?=\d)/g, '$1') // 1,50,000 / 1,500 → plain digits
    .replace(/(?:₹|\brs\b\.?|\binr\b)\s*(\d+(?:\.\d+)?)/g, '$1 rupees')
    .replace(/(\d+(?:\.\d+)?)\s*(?:rs\b\.?|inr\b|rupees?\b)/g, '$1 rupees')
    .replace(/\$\s*(\d+(?:\.\d+)?)/g, '$1 dollars')
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\bper cent\b/g, 'percent')
    .replace(/\b(\d{1,2}):(\d{2})\b/g, '$1 $2') // 7:30 → 7 30
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1ord') // 21st → 21ord
    .replace(/[-/–—]/g, ' ');
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  return t;
}

/** Number words → digits ("two hundred and fifty" → "250", "twenty-first" → "21ord"). */
function parseNumber(tokens, i) {
  let total = 0, current = 0, used = 0, last = null, ord = false, j = i;
  if (tokens[j] === 'a' && SCALE.has(tokens[j + 1])) { current = 1; j++; } // "a hundred"
  while (j < tokens.length) {
    const t = tokens[j];
    if (t === 'and' && used && last === 'scale' && (SMALL.has(tokens[j + 1]) || ORDINAL.has(tokens[j + 1]))) { j++; continue; }
    const small = SMALL.get(t), ordv = ORDINAL.get(t);
    if (small != null || ordv != null) {
      const v = small ?? ordv;
      // Only extend the number in valid positions ("twenty five", "hundred fifty"), so "seven thirty" stays two numbers.
      if (used && !(last === 'scale' || (last === 'tens' && v > 0 && v < 10))) break;
      current += v; used++; j++;
      last = v >= 20 && v % 10 === 0 ? 'tens' : 'unit';
      if (ordv != null) { ord = true; break; }
      continue;
    }
    if (SCALE.has(t) && (used || current)) {
      if (SCALE.get(t) === 100) current = (current || 1) * 100;
      else { total += (current || 1) * SCALE.get(t); current = 0; }
      used++; j++; last = 'scale';
      continue;
    }
    break;
  }
  if (!used) return null;
  let value = String(total + current);
  // "two point five" → "2.5"
  const digit = (w) => SMALL.has(w) && SMALL.get(w) < 10;
  if (!ord && tokens[j] === 'point' && digit(tokens[j + 1])) {
    j++; let dec = '';
    while (j < tokens.length && digit(tokens[j])) dec += SMALL.get(tokens[j++]);
    value += `.${dec}`;
  }
  return { token: ord ? `${value}ord` : value, next: j };
}

/** Normalise text into comparable tokens. */
export function normalizeForCompare(text) {
  const raw = prepare(text).match(/\d+(?:\.\d+)?(?:ord)?|[\p{L}\p{M}']+/gu) || [];
  const tokens = raw.map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length;) {
    const t = tokens[i];
    if (/^\d/.test(t)) { out.push(t.replace(/^0+(?=\d)/, '')); i++; continue; }
    const n = parseNumber(tokens, i);
    if (n) { out.push(n.token); i = n.next; continue; }
    out.push(SPELLING.get(t) ?? t);
    i++;
  }
  return out;
}
