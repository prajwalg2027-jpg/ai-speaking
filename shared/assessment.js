// Question bank for the voice placement test. Shared by browser and server.
import { BANK } from './bank.js';
// Levels: 1 Beginner · 2 Basic · 3 Good · 4 Very good

// Level names are everyday words a learner understands (no "Word-builder"-style labels).
export const LEVELS = {
  1: { name: 'Beginner', blurb: "You're starting to speak English. We'll begin with everyday words and short sentences." },
  2: { name: 'Basic', blurb: 'You know many English words. Next, we will make full sentences with them.' },
  3: { name: 'Good', blurb: 'You can talk in English about your life. Next, we will make your sentences stronger.' },
  4: { name: 'Very good', blurb: 'You speak English well and easily. Next, we will work on more advanced words and ideas.' },
};

// Everything here tests English only: questions are asked in English (with help in the learner's language if
// they need it), and only English answers count. One question at a time.
// The questions themselves live in bank.js (approved in review). Each type has a pool per level; a
// conversation picks one at random (variantFor), so retakes rarely repeat.
const READ_SAY = { say: 'Please read this sentence out loud.', hindi: 'स्क्रीन पर लिखा वाक्य ज़ोर से पढ़िए।', simple: 'Read this, please.' };

export const QUESTIONS = [
  {
    id: 'q1_intro',
    kind: 'open',
    silenceMs: 1400,
    variants: { any: BANK.open },
  },
  {
    id: 'q2_vocab',
    kind: 'vocab',
    silenceMs: 1200,
    // Two English words, asked as two separate questions: pictures (level 1 things, level 2 actions) or word
    // puzzles with a starting letter (levels 3-4), then a meaning or a difference. `expect` has one list of right
    // answers per question; `second` is asked after any reply to the first, unless that reply already answered it.
    variants: BANK.vocab,
  },
  {
    id: 'q2_listen',
    kind: 'listen',
    silenceMs: 1300,
    // Listening: Sakhi says two short sentences (always these exact words, never shown on screen), then asks
    // one question about them. The tutor only writes the lead-in ("Listen carefully…").
    tutor: {
      brief: "Tell them you'll say two short sentences, and then ask one question about them, so they should listen carefully. Say only that: not the sentences, and not the question.",
      mustInclude: [['listen', 'सुन', 'ਸੁਣ']],
      mustNotSay: [],
    },
    variants: BANK.listen,
  },
  {
    id: 'q3_read',
    kind: 'read',
    silenceMs: 1300,
    // Read-aloud is always English, so speech-to-text doesn't need to guess the language.
    language: 'en-IN',
    // Sakhi must never read the sentence out (the learner would copy her pronunciation); the server also
    // rejects any line that contains four or more consecutive words of it.
    tutor: {
      brief: 'Ask them to read the sentence shown on their screen out loud, at their own pace. Do not say the sentence yourself.',
      // "read" in each language Sakhi may be talking in (Hindi, Punjabi, Bengali, Gujarati, Marathi, Tamil, Telugu, Kannada, Malayalam, Odia).
      mustInclude: [['read', 'पढ़', 'ਪੜ੍ਹ', 'পড়', 'વાંચ', 'वाच', 'படி', 'చదువ', 'ಓದ', 'വായി', 'ପଢ']],
      mustNotSay: [],
    },
    variants: Object.fromEntries(Object.entries(BANK.read).map(([lvl, items]) => [lvl, items.map((v) => ({ ...READ_SAY, ...v }))])),
  },
  {
    // Speaking at length, then one follow-up. Level 1: about you, with a sentence starter on screen. Level 2:
    // past tense, describing, real-life tasks. Levels 3-4: opinions.
    id: 'q4_opinion',
    kind: 'open',
    silenceMs: 1800,
    variants: BANK.speak,
  },
];

export const PHRASES = {
  didntHear: "Sorry, I couldn't hear that clearly. Could you say it again, a little closer to the phone?",
  cutOff: 'Sorry, did I cut you off? Please go on.',
  nudge: "Take your time. Whenever you're ready.",
  moveOn: "No problem at all! Let's try another one.",
  followUp: 'Tell me a little more about that.',
  followUpSimple: 'Tell me more.',
  followUpHindi: 'इसके बारे में थोड़ा और बताइए।',
  // When the learner says they'd like to talk in Hindi (then the task, in Hindi).
  hindiOk: 'ज़रूर! हम हिंदी में बात कर सकते हैं। आप जब चाहें, अंग्रेज़ी में भी बोल सकते हैं।',
  englishOk: "Sure! Let's talk in English.",
  // When an answer comes in another language: asked once per question, then the answer counts as it is.
  tryEnglish: 'Can you try saying that in English? Even a few words is fine.',
  tryEnglishHindi: 'क्या आप यही बात अंग्रेज़ी में बोलने की कोशिश करेंगे? थोड़े शब्द भी ठीक हैं।',
  listenLead: "Now listen carefully. I'll say two short sentences, and then ask you one question.",
  listenAgain: "Okay, I'll say it again. Listen carefully.",
  // Played the moment the learner finishes, while Sakhi's real reply is being prepared.
  backchannels: ['Mm-hmm.', 'Okay!', 'Achha.', 'I see.'],
};

/** Pick a question for a level: one at random from that level's pool (`random` is replaceable in tests). */
export function variantFor(question, level, random = Math.random) {
  const pool = question.variants.any ?? question.variants[level] ?? question.variants[2];
  return Array.isArray(pool) ? pool[Math.floor(random() * pool.length)] : pool;
}
