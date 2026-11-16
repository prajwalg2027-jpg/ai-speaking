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
      },
      2: {
        say: "What is this called in English? And what is the Hindi word for 'library'?",
        simple: 'What is this in English? And library in Hindi?',
        hindi: 'इसे अंग्रेज़ी में क्या कहते हैं? और "library" को हिंदी में क्या कहते हैं?',
        screen: '☂️   +   “library” = ?',
        expect: ['umbrella', ['pustakalay', 'पुस्तकालय', 'library', 'वाचनालय']],
      },
      3: {
        say: "How would you say 'zimmedari' in English? And what does the word 'deadline' mean? Explain in one sentence.",
        simple: "Say 'zimmedari' in English. Then tell me what 'deadline' means.",
        hindi: '"ज़िम्मेदारी" को अंग्रेज़ी में कैसे कहेंगे? और "deadline" का मतलब एक वाक्य में बताइए।',
        screen: '“ज़िम्मेदारी” → ?     “deadline” means…',
        expect: [['responsibility', 'duty'], ['time', 'date', 'finish', 'last', 'submit', 'before']],
      },
      4: {
        say: "Give me one English word for 'aatmanirbhar'. Then tell me the difference between 'persuade' and 'convince'.",
        simple: "One English word for 'aatmanirbhar'? And how are 'persuade' and 'convince' different?",
        hindi: '"आत्मनिर्भर" के लिए एक अंग्रेज़ी शब्द बताइए। फिर "persuade" और "convince" में अंतर बताइए।',
        screen: '“आत्मनिर्भर” → ?     persuade vs convince',
        expect: [['self-reliant', 'self reliant', 'self-sufficient', 'self sufficient', 'independent'], ['belief', 'action', 'mind', 'agree', 'do something']],
      },
    },
  },
  {
    id: 'q3_read',
    kind: 'read',
    silenceMs: 1300,
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
        say: "Last one! What food do you like? Try saying it in English. Start with 'I like'.",
        simple: "Say: 'I like…' and a food.",
        hindi: 'आख़िरी सवाल! आपको कौन सा खाना पसंद है? अंग्रेज़ी में बोलिए: "I like…"',
        screen: 'I like ______ 🍛',
      },
      2: {
        say: 'Last one! What did you do last weekend?',
        simple: 'What did you do on Sunday?',
        hindi: 'आख़िरी सवाल! पिछले वीकेंड आपने क्या किया? अंग्रेज़ी में बताने की कोशिश कीजिए।',
        screen: 'Last weekend, I…',
      },
      3: {
        say: 'Last one! If you could change one thing about your city, what would it be, and why?',
        simple: 'What one thing would you change in your city? Why?',
        hindi: 'आख़िरी सवाल! अगर आप अपने शहर की एक चीज़ बदल सकते, तो क्या बदलते और क्यों? अंग्रेज़ी में जवाब दीजिए।',
        screen: 'If I could change one thing about my city…',
      },
      4: {
        say: "Last one! Some people say smartphones have made us more connected, but lonelier. What's your view?",
        simple: 'Do smartphones make us lonely? What do you think?',
        hindi: 'आख़िरी सवाल! कुछ लोग कहते हैं कि स्मार्टफ़ोन ने हमें जोड़ा है, पर अकेला भी किया है। आपकी क्या राय है? अंग्रेज़ी में जवाब दीजिए।',
        screen: 'Connected… but lonelier? 📱',
      },
    },
  },
];

export const ACKS = ['Nice!', 'Got it, thank you.', 'Lovely.', 'Great, thanks!'];

export const PHRASES = {
  didntHear: "Sorry, I couldn't hear that clearly. Could you say it again, a little closer to the phone?",
  cutOff: 'Sorry, did I cut you off? Please go on.',
  nudge: "Take your time. Whenever you're ready.",
  moveOn: "No problem at all! Let's try another one.",
  done: "That's it, thank you! Give me a second to put your results together.",
};

/** Pick the variant of a question for a provisional level. */
export function variantFor(question, level) {
  return question.variants.any ?? question.variants[level] ?? question.variants[2];
}
