// Question bank for the voice placement test. Shared by browser and server.
// Levels: 1 Starter · 2 Word-builder · 3 Conversational · 4 Eloquent

export const LEVELS = {
  1: { name: 'Starter', blurb: "You're taking your first steps in English. We'll start with everyday words and simple phrases." },
  2: { name: 'Word-builder', blurb: "You know lots of words! Next we'll turn them into confident sentences." },
  3: { name: 'Conversational', blurb: "You can hold a real conversation. We'll polish grammar and grow your vocabulary." },
  4: { name: 'Eloquent', blurb: "Impressive range! We'll focus on nuance, idiom and persuasive speaking." },
};

export const QUESTIONS = [
  {
    id: 'q1_intro',
    kind: 'open',
    silenceMs: 1400,
    // One question at a time: the name comes up naturally later, or not at all.
    tutor: { brief: 'Ask what they usually do during the day.', mustInclude: [], mustNotSay: [] },
    variants: {
      any: {
        say: "Hi! I'm Sakhi, your English buddy. What do you usually do during the day? You can answer in English, Hindi, or any language you're comfortable with.",
        simple: 'What do you do every day?',
        hindi: 'आप दिन में आमतौर पर क्या करते हैं?',
        screen: 'Tell me about your day 👋',
      },
    },
  },
  {
    id: 'q2_vocab',
    kind: 'vocab',
    silenceMs: 1200,
    // Two words, asked as two separate questions (never both at once). `expect` has one item per question;
    // `second` is the follow-on question, asked after any reply to the first unless that reply already
    // answered it. Both replies are scored together.
    variants: {
      1: {
        say: 'Look at the picture. What is this called in English?',
        simple: 'What is this? Say it in English.',
        hindi: 'इस तस्वीर को देखिए। इसे अंग्रेज़ी में क्या कहते हैं?',
        screen: '🍎  = ?',
        expect: ['apple', 'water'],
        tutor: {
          brief: 'The learner sees a picture of an apple on screen. Ask what it is called in English.',
          mustInclude: [['picture', 'this', 'screen', 'तस्वीर', 'यह', 'ਤਸਵੀਰ']],
          mustNotSay: ['apple', 'water', 'सेब', 'ऐप्पल', 'एप्पल', 'ऐपल', 'वॉटर', 'वाटर'],
        },
        second: {
          say: "And what do we call 'paani' in English?", simple: "'Paani' in English?", hindi: 'और "पानी" को अंग्रेज़ी में क्या कहते हैं?', screen: '“पानी” = ?',
          tutor: { brief: "Ask what 'paani' is called in English.", mustInclude: [['paani', 'pani', 'पानी', 'ਪਾਣੀ']], mustNotSay: ['water', 'वॉटर', 'वाटर'] },
        },
      },
      2: {
        say: 'Look at the picture. What is this called in English?',
        simple: 'What is this in English?',
        hindi: 'इस तस्वीर को देखिए। इसे अंग्रेज़ी में क्या कहते हैं?',
        screen: '☂️  = ?',
        expect: ['umbrella', ['pustakalay', 'पुस्तकालय', 'library', 'वाचनालय']],
        tutor: {
          brief: 'The learner sees a picture of an umbrella on screen. Ask what it is called in English.',
          mustInclude: [['picture', 'this', 'screen', 'तस्वीर', 'यह', 'इसे', 'ਤਸਵੀਰ']],
          mustNotSay: ['umbrella', 'छाता', 'छतरी', 'अम्ब्रेला', 'अंब्रेला'],
        },
        second: {
          say: "And what's the Hindi word for 'library'?", simple: "'Library' in Hindi?", hindi: 'और "library" को हिंदी में क्या कहते हैं?', screen: '“library” = ? (हिंदी)',
          tutor: { brief: "Ask what the Hindi word for 'library' is.", mustInclude: [['library']], mustNotSay: ['pustakalay', 'पुस्तकालय', 'वाचनालय'] },
        },
      },
      3: {
        say: "How would you say 'zimmedari' in English?",
        simple: "'Zimmedari' in English?",
        hindi: '"ज़िम्मेदारी" को अंग्रेज़ी में कैसे कहेंगे?',
        screen: '“ज़िम्मेदारी” → ?',
        expect: [['responsibility', 'duty'], ['time', 'date', 'finish', 'last', 'submit', 'before']],
        tutor: {
          brief: "Ask how they would say 'zimmedari' in English.",
          mustInclude: [['zimmedari', 'ज़िम्मेदारी', 'जिम्मेदारी', 'ਜ਼ਿੰਮੇਵਾਰੀ']],
          mustNotSay: ['responsibility', 'responsible', 'duty', 'duties', 'ड्यूटी', 'रिस्पॉन्सिबिलिटी'],
        },
        second: {
          say: "And what does 'deadline' mean? Tell me in one sentence.", simple: "What does 'deadline' mean?", hindi: 'और "deadline" का मतलब एक वाक्य में बताइए।', screen: '“deadline” means…',
          tutor: { brief: "Ask them to explain what the word 'deadline' means, in one sentence.", mustInclude: [['deadline', 'डेडलाइन']], mustNotSay: [] },
        },
      },
      4: {
        say: "Give me one English word for 'aatmanirbhar'.",
        simple: "One English word for 'aatmanirbhar'?",
        hindi: '"आत्मनिर्भर" के लिए एक अंग्रेज़ी शब्द बताइए।',
        screen: '“आत्मनिर्भर” → ?',
        expect: [['self-reliant', 'self reliant', 'self-sufficient', 'self sufficient', 'independent'], ['belief', 'action', 'mind', 'agree', 'do something']],
        tutor: {
          brief: "Ask for one English word for 'aatmanirbhar'.",
          mustInclude: [['aatmanirbhar', 'आत्मनिर्भर', 'ਆਤਮਨਿਰਭਰ']],
          mustNotSay: ['self-reliant', 'self reliant', 'self-sufficient', 'self sufficient', 'independent'],
        },
        second: {
          say: "And how are 'persuade' and 'convince' different?", simple: "'Persuade' and 'convince': how are they different?", hindi: 'और "persuade" और "convince" में क्या अंतर है?', screen: 'persuade vs convince',
          tutor: { brief: "Ask how the words 'persuade' and 'convince' are different.", mustInclude: [['persuade'], ['convince']], mustNotSay: [] },
        },
      },
    },
  },
  {
    id: 'q3_read',
    kind: 'read',
    silenceMs: 1300,
    // Read-aloud is always English, so speech-to-text doesn't need to guess the language.
    // Other questions use 'auto' (answers may be in English, Hindi or both).
    language: 'en-IN',
    // Sakhi must never read the sentence out (the learner would copy her pronunciation); the server also
    // rejects any line that contains four or more consecutive words of it.
    tutor: {
      brief: 'Ask them to read the sentence shown on their screen out loud, at their own pace. Do not say the sentence yourself.',
      // "read" in each language Sakhi may be talking in (Hindi, Punjabi, Bengali, Gujarati, Marathi, Tamil, Telugu, Kannada, Malayalam, Odia).
      mustInclude: [['read', 'पढ़', 'ਪੜ੍ਹ', 'পড়', 'વાંચ', 'वाच', 'படி', 'చదువ', 'ಓದ', 'വായി', 'ପଢ']],
      mustNotSay: [],
    },
    variants: {
      1: { say: 'Please read this sentence out loud.', hindi: 'स्क्रीन पर लिखा वाक्य ज़ोर से पढ़िए।', simple: 'Read this, please.', screen: 'My name is Ravi. I like tea.' },
      2: { say: 'Please read this sentence out loud.', hindi: 'स्क्रीन पर लिखा वाक्य ज़ोर से पढ़िए।', simple: 'Read this, please.', screen: 'Every morning I take the bus to work, and it is always crowded.' },
      3: { say: 'Please read this sentence out loud.', hindi: 'स्क्रीन पर लिखा वाक्य ज़ोर से पढ़िए।', simple: 'Read this, please.', screen: 'Although the weather was terrible, we decided to continue our journey to the mountains.' },
      4: { say: 'Please read this sentence out loud.', hindi: 'स्क्रीन पर लिखा वाक्य ज़ोर से पढ़िए।', simple: 'Read this, please.', screen: "The committee's unprecedented decision was, paradoxically, both a vindication of its critics and an indictment of its own procedures." },
    },
  },
  {
    id: 'q4_opinion',
    kind: 'open',
    silenceMs: 1800,
    variants: {
      1: {
        say: "What food do you like? Try saying it in English. Start with 'I like'.",
        simple: "Say: 'I like…' and a food.",
        hindi: 'आपको कौन सा खाना पसंद है? अंग्रेज़ी में बोलिए: "I like…"',
        screen: 'I like ______ 🍛',
        tutor: { brief: "Ask what food they like, and encourage them to answer in English starting with 'I like'.", mustInclude: [['food', 'eat', 'khana', 'खाना'], ['i like']], mustNotSay: [] },
      },
      2: {
        say: 'What did you do last weekend?',
        simple: 'What did you do on Sunday?',
        hindi: 'पिछले वीकेंड आपने क्या किया? अंग्रेज़ी में बताने की कोशिश कीजिए।',
        screen: 'Last weekend, I…',
        tutor: { brief: 'Ask what they did last weekend, so they describe it in the past tense.', mustInclude: [['weekend', 'वीकेंड']], mustNotSay: [] },
      },
      3: {
        say: 'If you could change one thing about your city, what would it be?',
        simple: 'What one thing would you change in your city?',
        hindi: 'अगर आप अपने शहर की एक चीज़ बदल सकते, तो क्या बदलते? अंग्रेज़ी में जवाब दीजिए।',
        screen: 'If I could change one thing about my city…',
        tutor: { brief: 'Ask: if they could change one thing about their city, what would it be? You may connect it to their life (work, commute, family).', mustInclude: [['city', 'town', 'शहर'], ['change', 'बदल']], mustNotSay: [] },
      },
      4: {
        say: "Some people say smartphones have made us more connected, but lonelier. What's your view?",
        simple: 'Do smartphones make us lonely? What do you think?',
        hindi: 'कुछ लोग कहते हैं कि स्मार्टफ़ोन ने हमें जोड़ा है, पर अकेला भी किया है। आपकी क्या राय है? अंग्रेज़ी में जवाब दीजिए।',
        screen: 'Connected… but lonelier? 📱',
        tutor: { brief: "Ask for their view on the idea that smartphones have made us more connected but lonelier. Invite them to argue a position with reasons.", mustInclude: [['smartphone', 'phone', 'फ़ोन', 'फोन'], ['lonely', 'lonelier', 'loneliness', 'अकेला', 'अकेले', 'अकेलापन'], ['connected', 'connect', 'जोड़', 'जुड़']], mustNotSay: [] },
      },
    },
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
  // Played the moment the learner finishes, while Sakhi's real reply is being prepared.
  backchannels: ['Mm-hmm.', 'Okay!', 'Achha.', 'I see.'],
};

/** Pick the variant of a question for a provisional level. */
export function variantFor(question, level) {
  return question.variants.any ?? question.variants[level] ?? question.variants[2];
}
