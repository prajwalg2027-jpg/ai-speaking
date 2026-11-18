// Question bank for the voice placement test. Shared by browser and server.
// Levels: 1 Starter · 2 Word-builder · 3 Conversational · 4 Eloquent

// Level names are everyday words a learner understands (no "Word-builder"-style labels).
export const LEVELS = {
  1: { name: 'Beginner', blurb: "You're starting to speak English. We'll begin with everyday words and short sentences." },
  2: { name: 'Basic', blurb: 'You know many English words. Next, we will make full sentences with them.' },
  3: { name: 'Good', blurb: 'You can talk in English about your life. Next, we will make your sentences stronger.' },
  4: { name: 'Very good', blurb: 'You speak English well and easily. Next, we will work on more advanced words and ideas.' },
};

// Everything here tests English only: questions are asked in English (with help in the learner's language if
// they need it), and only English answers count. One question at a time.
export const QUESTIONS = [
  {
    id: 'q1_intro',
    kind: 'open',
    silenceMs: 1400,
    tutor: { brief: 'Ask what they usually do during the day.', mustInclude: [], mustNotSay: [] },
    variants: {
      any: {
        say: "Hi! I'm Sakhi, your English buddy. What do you usually do during the day? Try to answer in English. Even a few words is fine.",
        simple: 'What do you do every day? Say it in English.',
        hindi: 'आप दिन में आमतौर पर क्या करते हैं? अंग्रेज़ी में बताने की कोशिश कीजिए।',
        screen: 'Tell me about your day 👋',
      },
    },
  },
  {
    id: 'q2_vocab',
    kind: 'vocab',
    silenceMs: 1200,
    // Two English words, asked as two separate questions, from pictures or English clues (no translation).
    // `expect` has one item per question; `second` is asked after any reply to the first, unless that reply
    // already answered it. Both replies are scored together.
    variants: {
      1: {
        say: 'Look at the picture. What is this called in English?',
        simple: 'What is this? Say it in English.',
        hindi: 'तस्वीर देखिए। इसे अंग्रेज़ी में क्या कहते हैं?',
        screen: '🍎',
        expect: ['apple', 'water'],
        tutor: { brief: 'The learner sees a picture of an apple. Ask what it is called in English.', mustInclude: [['picture', 'this', 'screen', 'तस्वीर', 'ਤਸਵੀਰ']], mustNotSay: ['apple', 'सेब', 'ऐप्पल', 'एप्पल'] },
        second: {
          say: 'And this one? What is it called in English?', simple: 'And this? In English?', hindi: 'और इसे अंग्रेज़ी में क्या कहते हैं?', screen: '💧🥛',
          tutor: { brief: 'The learner now sees a picture of water in a glass. Ask what it is called in English.', mustInclude: [['picture', 'this', 'screen', 'तस्वीर', 'ਤਸਵੀਰ']], mustNotSay: ['water', 'पानी', 'वॉटर', 'वाटर'] },
        },
      },
      2: {
        say: 'Look at the picture. What is this called in English?',
        simple: 'What is this in English?',
        hindi: 'तस्वीर देखिए। इसे अंग्रेज़ी में क्या कहते हैं?',
        screen: '☂️',
        expect: ['umbrella', ['book', 'read', 'borrow', 'study']],
        tutor: { brief: 'The learner sees a picture of an umbrella. Ask what it is called in English.', mustInclude: [['picture', 'this', 'screen', 'तस्वीर', 'ਤਸਵੀਰ']], mustNotSay: ['umbrella', 'छाता', 'छतरी', 'अम्ब्रेला', 'अंब्रेला'] },
        second: {
          say: 'What is a library? Tell me in one sentence.', simple: 'What is a library?', hindi: '"Library" क्या होती है? अंग्रेज़ी में एक वाक्य में बताइए।', screen: '🏛️ library = ?',
          tutor: { brief: "Ask them to explain in one sentence what a library is.", mustInclude: [['library']], mustNotSay: ['book', 'borrow', 'read'] },
        },
      },
      3: {
        say: "Here's a word puzzle. If something is your duty, we say it's your… what? It starts with R.",
        simple: "Your duty is your… R-word?",
        hindi: 'जो काम आपकी ड्यूटी हो, उसे अंग्रेज़ी में "R" से शुरू होने वाला कौन सा शब्द कहते हैं?',
        screen: 'Your duty = your R _ _ _ ?',
        expect: [['responsibility'], ['time', 'date', 'finish', 'last', 'submit', 'before']],
        tutor: { brief: "Ask for the English word for something that is your duty, starting with R (the answer is a noun; don't say it).", mustInclude: [['duty'], ['starts with', 'begins with', 'letter r', 'letter "r"', "letter 'r'"]], mustNotSay: ['responsibility', 'responsible'] },
        second: {
          say: "And what does 'deadline' mean? Tell me in one sentence.", simple: "What does 'deadline' mean?", hindi: '"Deadline" का मतलब अंग्रेज़ी में एक वाक्य में बताइए।', screen: '“deadline” means…',
          tutor: { brief: "Ask them to explain what the word 'deadline' means, in one sentence.", mustInclude: [['deadline']], mustNotSay: [] },
        },
      },
      4: {
        say: "Here's a word puzzle. What do we call a person who doesn't need help from others? It starts with I-N.",
        simple: "A person who needs no help is… IN-word?",
        hindi: 'जिस व्यक्ति को दूसरों की मदद की ज़रूरत नहीं, उसे अंग्रेज़ी में "IN" से शुरू होने वाला कौन सा शब्द कहते हैं?',
        screen: "Needs no one's help = IN _ _ _ ?",
        expect: [['independent', 'self-reliant', 'self reliant', 'self-sufficient'], ['belief', 'action', 'mind', 'agree', 'do something']],
        tutor: { brief: "Ask for the English word for a person who doesn't need help from others, starting with IN (don't say it).", mustInclude: [['help'], ['starts with', 'begins with', 'i-n', '"in"', "'in'"]], mustNotSay: ['independent', 'self-reliant', 'self reliant'] },
        second: {
          say: "And how are 'persuade' and 'convince' different?", simple: "'Persuade' and 'convince': how are they different?", hindi: '"Persuade" और "convince" में क्या अंतर है? अंग्रेज़ी में बताइए।', screen: 'persuade vs convince',
          tutor: { brief: "Ask how the words 'persuade' and 'convince' are different.", mustInclude: [['persuade'], ['convince']], mustNotSay: [] },
        },
      },
    },
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
    variants: {
      1: { passage: 'Ravi has a red bag. He takes it to school every day.', question: "What colour is Ravi's bag?", hindi: 'रवि के बैग का रंग क्या है? अंग्रेज़ी में बताइए।', expect: [['red']], screen: '👂 Listen' },
      2: { passage: 'Meena wakes up at six. She has tea, and then she takes the bus to her office.', question: 'How does Meena go to her office?', hindi: 'मीना अपने ऑफ़िस कैसे जाती है? अंग्रेज़ी में बताइए।', expect: [['bus']], screen: '👂 Listen' },
      3: { passage: "The shop usually closes at nine. But tonight it closed early, because the owner had to go to his sister's wedding.", question: 'Why did the shop close early tonight?', hindi: 'आज रात दुकान जल्दी क्यों बंद हुई? अंग्रेज़ी में बताइए।', expect: [['wedding', 'marriage', 'sister']], screen: '👂 Listen' },
      4: { passage: 'The train was two hours late. Even so, Anil reached his interview on time, because he had left home much earlier than he needed to.', question: 'How did Anil reach his interview on time?', hindi: 'अनिल अपने इंटरव्यू पर समय पर कैसे पहुँचा? अंग्रेज़ी में बताइए।', expect: [['early', 'earlier', 'before time', 'ahead']], screen: '👂 Listen' },
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
    // Speaking at length. Levels 1–2: describe a picture (the best task for these levels). Levels 3–4: give an
    // opinion. Each is followed by one follow-up question.
    id: 'q4_opinion',
    kind: 'open',
    silenceMs: 1800,
    variants: {
      1: {
        say: 'Look at the picture. What is happening in it?',
        simple: 'What do you see in the picture?',
        hindi: 'तस्वीर देखिए। इसमें क्या हो रहा है? अंग्रेज़ी में बताइए।',
        screen: '👩‍🍳 🍳 🥘 🏠',
        scene: 'A woman is cooking in her kitchen at home; there is a frying pan and a pot of food.',
        tutor: { brief: 'The learner sees a picture of a woman cooking in a kitchen. Ask what is happening in the picture.', mustInclude: [['picture', 'तस्वीर', 'ਤਸਵੀਰ']], mustNotSay: ['cook', 'kitchen', 'pan'] },
      },
      2: {
        say: "Look at the picture. Tell me what's happening in it.",
        simple: 'What do you see in the picture?',
        hindi: 'तस्वीर देखिए। इसमें क्या हो रहा है? अंग्रेज़ी में बताइए।',
        screen: '🌳 👦 🏏 👧 ☀️ 🐕',
        scene: 'On a sunny day in a park, a boy and a girl are playing cricket under a tree, and a dog is watching them.',
        tutor: { brief: "The learner sees a picture of children playing cricket in a park on a sunny day, with a dog. Ask them to tell you what's happening in it.", mustInclude: [['picture', 'तस्वीर', 'ਤਸਵੀਰ']], mustNotSay: ['cricket', 'park', 'dog', 'children', 'playing'] },
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
  // When an answer comes in another language: asked once per question, then the answer counts as it is.
  tryEnglish: 'Can you try saying that in English? Even a few words is fine.',
  tryEnglishHindi: 'क्या आप यही बात अंग्रेज़ी में बोलने की कोशिश करेंगे? थोड़े शब्द भी ठीक हैं।',
  listenLead: "Now listen carefully. I'll say two short sentences, and then ask you one question.",
  listenAgain: "Okay, I'll say it again. Listen carefully.",
  // Played the moment the learner finishes, while Sakhi's real reply is being prepared.
  backchannels: ['Mm-hmm.', 'Okay!', 'Achha.', 'I see.'],
};

/** Pick the variant of a question for a provisional level. */
export function variantFor(question, level) {
  return question.variants.any ?? question.variants[level] ?? question.variants[2];
}
