// Languages Sakhi can talk in besides English (Bulbul speaks all of them; Sarvam-105B writes them; Saaras
// hears them). A learner can ask for any of these; the placement itself is still about their English.
export const LANGUAGES = {
  'hi-IN': { name: 'Hindi', native: 'हिंदी', script: 'Devanagari', re: /[ऀ-ॿ]/ },
  'mr-IN': { name: 'Marathi', native: 'मराठी', script: 'Devanagari', re: /[ऀ-ॿ]/ },
  'pa-IN': { name: 'Punjabi', native: 'ਪੰਜਾਬੀ', script: 'Gurmukhi', re: /[਀-੿]/ },
  'bn-IN': { name: 'Bengali', native: 'বাংলা', script: 'Bengali', re: /[ঀ-৿]/ },
  'gu-IN': { name: 'Gujarati', native: 'ગુજરાતી', script: 'Gujarati', re: /[઀-૿]/ },
  'od-IN': { name: 'Odia', native: 'ଓଡ଼ିଆ', script: 'Odia', re: /[଀-୿]/ },
  'ta-IN': { name: 'Tamil', native: 'தமிழ்', script: 'Tamil', re: /[஀-௿]/ },
  'te-IN': { name: 'Telugu', native: 'తెలుగు', script: 'Telugu', re: /[ఀ-౿]/ },
  'kn-IN': { name: 'Kannada', native: 'ಕನ್ನಡ', script: 'Kannada', re: /[ಀ-೿]/ },
  'ml-IN': { name: 'Malayalam', native: 'മലയാളം', script: 'Malayalam', re: /[ഀ-ൿ]/ },
};

/** "Punjabi" / "punjabi" / "pa-IN" / "ਪੰਜਾਬੀ" → "pa-IN"; "English" → "en-IN"; unknown → null. */
export function languageCode(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  if (/^(english|en(-in)?|angrezi|अंग्रेज़ी|अंग्रेजी|इंग्लिश)$/.test(n)) return 'en-IN';
  for (const [code, l] of Object.entries(LANGUAGES)) {
    if (n === code.toLowerCase() || n === code.slice(0, 2) || n === l.name.toLowerCase() || n === l.native) return code;
  }
  if (/^(bangla|bengali)$/.test(n)) return 'bn-IN';
  if (/^(oriya|odia)$/.test(n)) return 'od-IN';
  return null;
}

/**
 * The voice language for a line, from its script. Devanagari is Hindi unless the learner chose Marathi.
 * Mixed lines (English with Punjabi, say) use the Indian language.
 */
export function voiceLanguage(text, preferred = null) {
  for (const [code, l] of Object.entries(LANGUAGES)) {
    if (l.script === 'Devanagari') continue;
    if (l.re.test(text)) return code;
  }
  if (LANGUAGES['hi-IN'].re.test(text)) return preferred === 'mr-IN' ? 'mr-IN' : 'hi-IN';
  return 'en-IN';
}
