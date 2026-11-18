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
    variants: {
      any: {
        say: "Hi! I'm Sakhi, your English buddy. Tell me a little about yourself: your name, and what you do during the day. You can speak in English or Hindi, whatever feels comfortable.",
        simple: "Tell me your name, and what you do every day.",
        hindi: 'नमस्ते! मैं सखी हूँ। अपने बारे में थोड़ा बताइए: आपका नाम क्या है, और आप दिन में क्या करते हैं?',
        screen: 'Tell me about yourself 👋',
      },
    },
  },
  {
    id: 'q2_vocab',
    kind: 'vocab',
    silenceMs: 1200,
    variants: {
      1: {
        say: "Look at the picture. What is this called in English? And what do we call 'paani' in English?",
        simple: 'What is this? Say it in English.',
        hindi: 'इस तस्वीर को देखिए। इसे अंग्रेज़ी में क्या कहते हैं? और "पानी" को अंग्रेज़ी में क्या कहते हैं?',
        screen: '🍎   +   “पानी” = ?',
        expect: ['apple', 'water'],
        tutor: {
          brief: "The learner sees a picture of an apple on screen. Ask what the thing in the picture is called in English, and what 'paani' is called in English.",
          mustInclude: [['picture', 'this', 'screen'], ['paani', 'pani', 'पानी']],
          mustNotSay: ['apple', 'water', 'सेब'],
        },
      },
      2: {
        say: "What is this called in English? And what is the Hindi word for 'library'?",
        simple: 'What is this in English? And library in Hindi?',
        hindi: 'इसे अंग्रेज़ी में क्या कहते हैं? और "library" को हिंदी में क्या कहते हैं?',
        screen: '☂️   +   “library” = ?',
        expect: ['umbrella', ['pustakalay', 'पुस्तकालय', 'library', 'वाचनालय']],
        tutor: {
          brief: "The learner sees a picture of an umbrella on screen. Ask what the thing in the picture is called in English, and what the Hindi word for 'library' is.",
          mustInclude: [['picture', 'this', 'screen'], ['library']],
          mustNotSay: ['umbrella', 'pustakalay', 'पुस्तकालय', 'वाचनालय', 'छाता', 'छतरी'],
        },
      },
      3: {
        say: "How would you say 'zimmedari' in English? And what does the word 'deadline' mean? Explain in one sentence.",
        simple: "Say 'zimmedari' in English. Then tell me what 'deadline' means.",
        hindi: '"ज़िम्मेदारी" को अंग्रेज़ी में कैसे कहेंगे? और "deadline" का मतलब एक वाक्य में बताइए।',
        screen: '“ज़िम्मेदारी” → ?     “deadline” means…',
        expect: [['responsibility', 'duty'], ['time', 'date', 'finish', 'last', 'submit', 'before']],
        tutor: {
          brief: "Ask how they would say 'zimmedari' in English, and ask them to explain what 'deadline' means in a sentence.",
          mustInclude: [['zimmedari', 'ज़िम्मेदारी', 'जिम्मेदारी'], ['deadline']],
          mustNotSay: ['responsibility', 'responsible', 'duty', 'duties'],
        },
      },
      4: {
        say: "Give me one English word for 'aatmanirbhar'. Then tell me the difference between 'persuade' and 'convince'.",
        simple: "One English word for 'aatmanirbhar'? And how are 'persuade' and 'convince' different?",
        hindi: '"आत्मनिर्भर" के लिए एक अंग्रेज़ी शब्द बताइए। फिर "persuade" और "convince" में अंतर बताइए।',
        screen: '“आत्मनिर्भर” → ?     persuade vs convince',
        expect: [['self-reliant', 'self reliant', 'self-sufficient', 'self sufficient', 'independent'], ['belief', 'action', 'mind', 'agree', 'do something']],
        tutor: {
          brief: "Ask for one English word for 'aatmanirbhar', and ask them to explain the difference between 'persuade' and 'convince'.",
          mustInclude: [['aatmanirbhar', 'आत्मनिर्भर'], ['persuade'], ['convince']],
          mustNotSay: ['self-reliant', 'self reliant', 'self-sufficient', 'self sufficient', 'independent'],
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
      mustInclude: [['read']],
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
        tutor: { brief: 'Ask what they did last weekend, so they describe it in the past tense.', mustInclude: [['weekend']], mustNotSay: [] },
      },
      3: {
        say: 'If you could change one thing about your city, what would it be, and why?',
        simple: 'What one thing would you change in your city? Why?',
        hindi: 'अगर आप अपने शहर की एक चीज़ बदल सकते, तो क्या बदलते और क्यों? अंग्रेज़ी में जवाब दीजिए।',
        screen: 'If I could change one thing about my city…',
        tutor: { brief: 'Ask: if they could change one thing about their city, what would it be, and why? You may connect it to their life (work, commute, family).', mustInclude: [['city', 'town'], ['change'], ['why']], mustNotSay: [] },
      },
      4: {
        say: "Some people say smartphones have made us more connected, but lonelier. What's your view?",
        simple: 'Do smartphones make us lonely? What do you think?',
        hindi: 'कुछ लोग कहते हैं कि स्मार्टफ़ोन ने हमें जोड़ा है, पर अकेला भी किया है। आपकी क्या राय है? अंग्रेज़ी में जवाब दीजिए।',
        screen: 'Connected… but lonelier? 📱',
        tutor: { brief: "Ask for their view on the idea that smartphones have made us more connected but lonelier. Invite them to argue a position with reasons.", mustInclude: [['smartphone', 'phone'], ['lonely', 'lonelier', 'loneliness'], ['connected', 'connect']], mustNotSay: [] },
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
  // Played the moment the learner finishes, while Sakhi's real reply is being prepared.
  backchannels: ['Mm-hmm.', 'Okay!', 'Achha.', 'I see.'],
};

/** Pick the variant of a question for a provisional level. */
export function variantFor(question, level) {
  return question.variants.any ?? question.variants[level] ?? question.variants[2];
}
