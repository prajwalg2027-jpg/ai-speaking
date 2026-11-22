// The question bank: questions approved in review (docs: public/review/*.json, decided 18 Nov 2026).
// Each conversation picks one question at random per type and level (see variantFor in assessment.js).
// Generated from the review CSVs; Hindi and simpler help lines drafted with Sarvam-105B and checked by hand.
export const BANK = {
 "open": [
  {
   "id": "OPEN-1",
   "say": "Hi! I'm Sakhi, your English buddy. What did you do this morning? Try to answer in English. Even a few words is fine.",
   "simple": "What did you do this morning?",
   "hindi": "आज सुबह आपने क्या किया, कृपया अंग्रेज़ी में बताइए।",
   "screen": "Tell me about your morning ☀️",
   "tutor": {
    "brief": "Ask: What did you do this morning?",
    "mustInclude": [],
    "mustNotSay": []
   }
  },
  {
   "id": "OPEN-2",
   "say": "Hi! I'm Sakhi, your English buddy. Tell me about the place where you live. Try to answer in English. Even a few words is fine.",
   "simple": "Tell me about where you live.",
   "hindi": "आप जहाँ रहते हैं, उस जगह के बारे में बताइए। अंग्रेज़ी में बताने की कोशिश कीजिए।",
   "screen": "Tell me about where you live 🏠",
   "tutor": {
    "brief": "Ask: Tell me about the place where you live.",
    "mustInclude": [],
    "mustNotSay": []
   }
  },
  {
   "id": "OPEN-3",
   "say": "Hi! I'm Sakhi, your English buddy. What do you like to do in your free time? Try to answer in English. Even a few words is fine.",
   "simple": "What do you do in your free time?",
   "hindi": "आपके खाली समय में आप क्या करते हैं, कृपया अंग्रेज़ी में जवाब दीजिए।",
   "screen": "Tell me about your free time 🎈",
   "tutor": {
    "brief": "Ask: What do you like to do in your free time?",
    "mustInclude": [],
    "mustNotSay": []
   }
  }
 ],
 "vocab": {
  "1": [
   {
    "id": "WORD-L1-1",
    "say": "Look at the picture. What is this called in English?",
    "simple": "What is this animal called?",
    "hindi": "चित्र में क्या दिख रहा है, कृपया अंग्रेज़ी में बताइए।",
    "screen": "🐶",
    "expect": [
     [
      "dog"
     ],
     [
      "sun"
     ]
    ],
    "tutor": {
     "brief": "The learner sees a picture (🐶) of a dog. Ask what it is called in English.",
     "mustInclude": [
      [
       "picture",
       "this",
       "screen",
       "doing",
       "तस्वीर",
       "चित्र",
       "ਤਸਵੀਰ"
      ]
     ],
     "mustNotSay": [
      "dog"
     ]
    },
    "second": {
     "say": "And this one? What is it called in English?",
     "simple": "What is this in English?",
     "hindi": "इस चित्र का नाम अंग्रेज़ी में बताइए।",
     "screen": "🌞",
     "tutor": {
      "brief": "The learner sees a picture (🌞) of a sun. Ask what it is called in English.",
      "mustInclude": [
       [
        "picture",
        "this",
        "screen",
        "doing",
        "तस्वीर",
        "चित्र",
        "ਤਸਵੀਰ"
       ]
      ],
      "mustNotSay": [
       "sun"
      ]
     }
    }
   },
   {
    "id": "WORD-L1-2",
    "say": "Look at the picture. What is this called in English?",
    "simple": "What is this called?",
    "hindi": "इस तस्वीर को देखिए। इसे अंग्रेज़ी में क्या कहते हैं? बताइए।",
    "screen": "🏠",
    "expect": [
     [
      "house",
      "home"
     ],
     [
      "car"
     ]
    ],
    "tutor": {
     "brief": "The learner sees a picture (🏠) of a house. Ask what it is called in English.",
     "mustInclude": [
      [
       "picture",
       "this",
       "screen",
       "doing",
       "तस्वीर",
       "चित्र",
       "ਤਸਵੀਰ"
      ]
     ],
     "mustNotSay": [
      "house",
      "home"
     ]
    },
    "second": {
     "say": "And this one? What is it called in English?",
     "simple": "What is this called?",
     "hindi": "और इस तस्वीर को अंग्रेज़ी में क्या कहते हैं? बताइए।",
     "screen": "🚗",
     "tutor": {
      "brief": "The learner sees a picture (🚗) of a car. Ask what it is called in English.",
      "mustInclude": [
       [
        "picture",
        "this",
        "screen",
        "doing",
        "तस्वीर",
        "चित्र",
        "ਤਸਵੀਰ"
       ]
      ],
      "mustNotSay": [
       "car"
      ]
     }
    }
   },
   {
    "id": "WORD-L1-3",
    "say": "Look at the picture. What is this called in English?",
    "simple": "What is this fruit called?",
    "hindi": "इस फल को अंग्रेजी में क्या कहते हैं? अंग्रेज़ी में बताइए।",
    "screen": "🍌",
    "expect": [
     [
      "banana"
     ],
     [
      "shoe",
      "shoes"
     ]
    ],
    "tutor": {
     "brief": "The learner sees a picture (🍌) of a banana. Ask what it is called in English.",
     "mustInclude": [
      [
       "picture",
       "this",
       "screen",
       "doing",
       "तस्वीर",
       "चित्र",
       "ਤਸਵੀਰ"
      ]
     ],
     "mustNotSay": [
      "banana"
     ]
    },
    "second": {
     "say": "And this one? What is it called in English?",
     "simple": "What is this?",
     "hindi": "इस चित्र को देखिए। यह क्या है, अंग्रेजी में बताइए।",
     "screen": "👟",
     "tutor": {
      "brief": "The learner sees a picture (👟) of a shoe. Ask what it is called in English.",
      "mustInclude": [
       [
        "picture",
        "this",
        "screen",
        "doing",
        "तस्वीर",
        "चित्र",
        "ਤਸਵੀਰ"
       ]
      ],
      "mustNotSay": [
       "shoe",
       "shoes"
      ]
     }
    }
   },
   {
    "id": "WORD-L1-4",
    "say": "Look at the picture. What is this called in English?",
    "simple": "What is this?",
    "hindi": "चित्र को देखिए। यह क्या है, अंग्रेजी में बताइए।",
    "screen": "🐟",
    "expect": [
     [
      "fish"
     ],
     [
      "moon"
     ]
    ],
    "tutor": {
     "brief": "The learner sees a picture (🐟) of a fish. Ask what it is called in English.",
     "mustInclude": [
      [
       "picture",
       "this",
       "screen",
       "doing",
       "तस्वीर",
       "चित्र",
       "ਤਸਵੀਰ"
      ]
     ],
     "mustNotSay": [
      "fish"
     ]
    },
    "second": {
     "say": "And this one? What is it called in English?",
     "simple": "What is this?",
     "hindi": "इसे देखिए। यह क्या है, अंग्रेजी में बताइए।",
     "screen": "🌙",
     "tutor": {
      "brief": "The learner sees a picture (🌙) of a moon. Ask what it is called in English.",
      "mustInclude": [
       [
        "picture",
        "this",
        "screen",
        "doing",
        "तस्वीर",
        "चित्र",
        "ਤਸਵੀਰ"
       ]
      ],
      "mustNotSay": [
       "moon"
      ]
     }
    }
   },
   {
    "id": "WORD-L1-6",
    "say": "Look at the picture. What is this called in English?",
    "simple": "What is this?",
    "hindi": "चित्र को देखिए। यह क्या है, अंग्रेजी में बताइए।",
    "screen": "🍞",
    "expect": [
     [
      "bread"
     ],
     [
      "clock",
      "alarm"
     ]
    ],
    "tutor": {
     "brief": "The learner sees a picture (🍞) of a bread. Ask what it is called in English.",
     "mustInclude": [
      [
       "picture",
       "this",
       "screen",
       "doing",
       "तस्वीर",
       "चित्र",
       "ਤਸਵੀਰ"
      ]
     ],
     "mustNotSay": [
      "bread"
     ]
    },
    "second": {
     "say": "And this one? What is it called in English?",
     "simple": "What is this called in English?",
     "hindi": "और इसे अंग्रेज़ी में क्या कहते हैं? बताइए।",
     "screen": "⏰",
     "tutor": {
      "brief": "The learner sees a picture (⏰) of a clock. Ask what it is called in English.",
      "mustInclude": [
       [
        "picture",
        "this",
        "screen",
        "doing",
        "तस्वीर",
        "चित्र",
        "ਤਸਵੀਰ"
       ]
      ],
      "mustNotSay": [
       "clock",
       "alarm"
      ]
     }
    }
   }
  ],
  "3": [
   {
    "id": "WORD-L3-1",
    "say": "Here's a word puzzle. When you make a mistake and say sorry, you… what? It starts with A.",
    "simple": "What word starts with A for saying sorry?",
    "hindi": "गलती होने पर sorry कहने के लिए \"A\" से शुरू होने वाला अंग्रेज़ी शब्द बताइए।",
    "screen": "A _ _ _ ?",
    "expect": [
     [
      "apologise",
      "apologize",
      "apology"
     ],
     [
      "price",
      "less",
      "cheap",
      "offer",
      "sale"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'apologise'; never say it): When you make a mistake and say sorry, you… what? It starts with A.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "apologise",
      "apologize",
      "apology"
     ]
    },
    "second": {
     "say": "And what does 'discount' mean? Tell me in one sentence.",
     "simple": "What is the one-sentence meaning of discount?",
     "hindi": "‘discount’ का एक वाक्य में मतलब समझाइए। अंग्रेज़ी में जवाब दीजिए।",
     "screen": "“discount” means…",
     "tutor": {
      "brief": "Ask them to explain what 'discount' means, in one sentence.",
      "mustInclude": [
       [
        "discount"
       ]
      ],
      "mustNotSay": []
     }
    }
   },
   {
    "id": "WORD-L3-3",
    "say": "Here's a word puzzle. When something costs a lot of money, it's… what? It starts with E.",
    "simple": "What word starts with E for costing a lot?",
    "hindi": "जिस चीज़ में बहुत पैसे लगें, उसके लिए \"E\" से शुरू होने वाला अंग्रेज़ी शब्द बताइए।",
    "screen": "E _ _ _ ?",
    "expect": [
     [
      "expensive",
      "costly"
     ],
     [
      "cook",
      "step",
      "ingredient",
      "make",
      "dish"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'expensive'; never say it): When something costs a lot of money, it's… what? It starts with E.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "expensive",
      "costly"
     ]
    },
    "second": {
     "say": "And what does 'recipe' mean? Tell me in one sentence.",
     "simple": "What is the one-sentence meaning of recipe?",
     "hindi": "‘recipe’ का एक वाक्य में मतलब समझाइए। अंग्रेज़ी में जवाब दीजिए.",
     "screen": "“recipe” means…",
     "tutor": {
      "brief": "Ask them to explain what 'recipe' means, in one sentence.",
      "mustInclude": [
       [
        "recipe"
       ]
      ],
      "mustNotSay": []
     }
    }
   },
   {
    "id": "WORD-L3-4",
    "say": "Here's a word puzzle. A meeting where someone asks you questions for a job is an… what? It starts with I.",
    "simple": "What word starts with I for a job question meeting?",
    "hindi": "नौकरी के लिए सवाल-जवाब वाली मुलाक़ात को \"I\" से शुरू होने वाले किस अंग्रेज़ी शब्द से कहते हैं? बताइए।",
    "screen": "I _ _ _ ?",
    "expect": [
     [
      "interview"
     ],
     [
      "car",
      "road",
      "stuck",
      "slow",
      "vehicle"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'interview'; never say it): A meeting where someone asks you questions for a job is an… what? It starts with I.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "interview"
     ]
    },
    "second": {
     "say": "And what does 'traffic jam' mean? Tell me in one sentence.",
     "simple": "What is the one-sentence meaning of traffic jam?",
     "hindi": "‘traffic jam’ का एक वाक्य में मतलब समझाइए। अंग्रेज़ी में जवाब दीजिए।",
     "screen": "“traffic jam” means…",
     "tutor": {
      "brief": "Ask them to explain what 'traffic jam' means, in one sentence.",
      "mustInclude": [
       [
        "traffic jam"
       ]
      ],
      "mustNotSay": []
     }
    }
   },
   {
    "id": "WORD-L3-5",
    "say": "Here's a word puzzle. The opposite of 'old-fashioned' is… what? It starts with M.",
    "simple": "What word starts with M for the opposite of old-fashioned?",
    "hindi": "\"old-fashioned\" का उल्टा, \"M\" से शुरू होने वाला अंग्रेज़ी शब्द बताइए।",
    "screen": "M _ _ _ ?",
    "expect": [
     [
      "modern"
     ],
     [
      "next",
      "near",
      "live",
      "house",
      "door"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'modern'; never say it): The opposite of 'old-fashioned' is… what? It starts with M.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "modern"
     ]
    },
    "second": {
     "say": "And what does 'neighbour' mean? Tell me in one sentence.",
     "simple": "What is the one-sentence meaning of neighbour?",
     "hindi": "‘neighbour’ का एक वाक्य में मतलब समझाइए। अंग्रेज़ी में जवाब दीजिए।",
     "screen": "“neighbour” means…",
     "tutor": {
      "brief": "Ask them to explain what 'neighbour' means, in one sentence.",
      "mustInclude": [
       [
        "neighbour"
       ]
      ],
      "mustNotSay": []
     }
    }
   },
   {
    "id": "WORD-L3-6",
    "say": "Here's a word puzzle. When you don't understand something at all, you are… what? It starts with C.",
    "simple": "What word starts with C for not understanding at all?",
    "hindi": "जब कोई बात बिल्कुल समझ न आए, तो उसके लिए \"C\" से शुरू होने वाला अंग्रेज़ी शब्द बताइए।",
    "screen": "C _ _ _ ?",
    "expect": [
     [
      "confused"
     ],
     [
      "money",
      "back",
      "return"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'confused'; never say it): When you don't understand something at all, you are… what? It starts with C.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "confused"
     ]
    },
    "second": {
     "say": "And what does 'refund' mean? Tell me in one sentence.",
     "simple": "What is the one-sentence meaning of refund?",
     "hindi": "‘refund’ का एक वाक्य में मतलब समझाइए। अंग्रेज़ी में जवाब दीजिए.",
     "screen": "“refund” means…",
     "tutor": {
      "brief": "Ask them to explain what 'refund' means, in one sentence.",
      "mustInclude": [
       [
        "refund"
       ]
      ],
      "mustNotSay": []
     }
    }
   }
  ],
  "4": [
   {
    "id": "WORD-L4-1",
    "say": "Here's a word puzzle. Someone who always expects good things to happen is… what? It starts with O.",
    "simple": "What word starts with O for always expecting good things?",
    "hindi": "जो इंसान हमेशा अच्छा होने की उम्मीद रखता है, उसके लिए \"O\" से शुरू होने वाला अंग्रेज़ी शब्द बताइए।",
    "screen": "O _ _ _ ?",
    "expect": [
     [
      "optimistic",
      "optimist"
     ],
     [
      "economy",
      "money",
      "saving",
      "cheap",
      "waste",
      "less"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'optimistic'; never say it): Someone who always expects good things to happen is… what? It starts with O.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "optimistic",
      "optimist"
     ]
    },
    "second": {
     "say": "And what's the difference between 'economic' and 'economical'?",
     "simple": "What is the difference between 'economic' and 'economical'?",
     "hindi": "कृपया 'economic' और 'economical' के बीच का अंतर समझाइए। अंग्रेज़ी में जवाब दीजिए।",
     "screen": "economic vs economical",
     "tutor": {
      "brief": "Ask how the words 's the difference between ' and ' and ' are different.",
      "mustInclude": [
       [
        "s the difference between "
       ],
       [
        " and "
       ]
      ],
      "mustNotSay": []
     }
    }
   },
   {
    "id": "WORD-L4-2",
    "say": "Here's a word puzzle. Something that can't be stopped or avoided is… what? It starts with I.",
    "simple": "A word for something you can't stop. It starts with I.",
    "hindi": "जिस चीज़ को रोका या टाला न जा सके, उसके लिए \"I\" से शुरू होने वाला अंग्रेज़ी शब्द बताइए।",
    "screen": "I _ _ _ ?",
    "expect": [
     [
      "inevitable",
      "unavoidable"
     ],
     [
      "verb",
      "noun",
      "result",
      "change",
      "action"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'inevitable'; never say it): Something that can't be stopped or avoided is… what? It starts with I.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "inevitable",
      "unavoidable"
     ]
    },
    "second": {
     "say": "And what's the difference between 'affect' and 'effect'?",
     "simple": "What is the difference between 'affect' and 'effect'?",
     "hindi": "कृपया 'affect' और 'effect' के बीच का अंतर समझाइए। अंग्रेज़ी में जवाब दीजिए।",
     "screen": "affect vs effect",
     "tutor": {
      "brief": "Ask how the words 's the difference between ' and ' and ' are different.",
      "mustInclude": [
       [
        "s the difference between "
       ],
       [
        " and "
       ]
      ],
      "mustNotSay": []
     }
    }
   },
   {
    "id": "WORD-L4-3",
    "say": "Here's a word puzzle. Someone who only thinks about themselves is… what? It starts with S.",
    "simple": "A word for someone who thinks only of themselves. It starts with S.",
    "hindi": "जो इंसान सिर्फ़ अपने बारे में सोचता है, उसके लिए \"S\" से शुरू होने वाला अंग्रेज़ी शब्द बताइए।",
    "screen": "S _ _ _ ?",
    "expect": [
     [
      "selfish",
      "self-centred",
      "self-centered"
     ],
     [
      "noun",
      "verb",
      "give",
      "suggest"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'selfish'; never say it): Someone who only thinks about themselves is… what? It starts with S.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "selfish",
      "self-centred",
      "self-centered"
     ]
    },
    "second": {
     "say": "And what's the difference between 'advice' and 'advise'?",
     "simple": "What's the difference between 'advice' and 'advise'?",
     "hindi": "इन दोनों शब्दों, 'advice' और 'advise' के बीच क्या अंतर है, कृपया अंग्रेज़ी में बताइए।",
     "screen": "advice vs advise",
     "tutor": {
      "brief": "Ask how the words 's the difference between ' and ' and ' are different.",
      "mustInclude": [
       [
        "s the difference between "
       ],
       [
        " and "
       ]
      ],
      "mustNotSay": []
     }
    }
   },
   {
    "id": "WORD-L4-4",
    "say": "Here's a word puzzle. When you keep putting work off until later, you… what? It starts with P.",
    "simple": "What word starts with P when you delay work?",
    "hindi": "जब आप काम को बाद में टालते हैं, तो P से शुरू होने वाला शब्द क्या होता है, अंग्रेज़ी में बताइए।",
    "screen": "P _ _ _ ?",
    "expect": [
     [
      "procrastinate",
      "postpone",
      "procrastinating"
     ],
     [
      "school",
      "head",
      "rule",
      "belief",
      "value"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'procrastinate'; never say it): When you keep putting work off until later, you… what? It starts with P.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "procrastinate",
      "postpone",
      "procrastinating"
     ]
    },
    "second": {
     "say": "And what's the difference between 'principal' and 'principle'?",
     "simple": "What's the difference between 'principal' and 'principle'?",
     "hindi": "इन दोनों शब्दों, 'principal' और 'principle' के बीच क्या अंतर है, कृपया अंग्रेज़ी में जवाब दीजिए।",
     "screen": "principal vs principle",
     "tutor": {
      "brief": "Ask how the words 's the difference between ' and ' and ' are different.",
      "mustInclude": [
       [
        "s the difference between "
       ],
       [
        " and "
       ]
      ],
      "mustNotSay": []
     }
    }
   },
   {
    "id": "WORD-L4-5",
    "say": "Here's a word puzzle. Something very, very old, from long ago, is… what? It starts with A.",
    "simple": "What word starts with A for something very old?",
    "hindi": "जो चीज़ बहुत, बहुत पुरानी हो, उसके लिए \"A\" से शुरू होने वाला अंग्रेज़ी शब्द बताइए।",
    "screen": "A _ _ _ ?",
    "expect": [
     [
      "ancient",
      "antique"
     ],
     [
      "praise",
      "nice",
      "complete",
      "goes with",
      "match"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'ancient'; never say it): Something very, very old, from long ago, is… what? It starts with A.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "ancient",
      "antique"
     ]
    },
    "second": {
     "say": "And what's the difference between 'compliment' and 'complement'?",
     "simple": "What is the difference between \"compliment\" and \"complement\"?",
     "hindi": "इन दोनों शब्दों के बीच का अंतर बताइए। \"compliment\" और \"complement\" के बीच अंतर अंग्रेज़ी में बताइए।",
     "screen": "compliment vs complement",
     "tutor": {
      "brief": "Ask how the words 's the difference between ' and ' and ' are different.",
      "mustInclude": [
       [
        "s the difference between "
       ],
       [
        " and "
       ]
      ],
      "mustNotSay": []
     }
    }
   },
   {
    "id": "WORD-L4-6",
    "say": "Here's a word puzzle. Someone who gets annoyed very easily is… what? It starts with I.",
    "simple": "What is a word starting with I for someone easily annoyed?",
    "hindi": "ऐसे व्यक्ति के लिए 'I' से शुरू होने वाला शब्द बताइए जो आसानी से परेशान हो जाता है। अंग्रेज़ी में जवाब दीजिए।",
    "screen": "I _ _ _ ?",
    "expect": [
     [
      "irritable",
      "impatient"
     ],
     [
      "suggest",
      "hint",
      "conclude",
      "understand",
      "guess"
     ]
    ],
    "tutor": {
     "brief": "Ask this word puzzle in your own words, keeping the clue and the starting letter (the answer is 'irritable'; never say it): Someone who gets annoyed very easily is… what? It starts with I.",
     "mustInclude": [
      [
       "starts with",
       "begins with",
       "starting with",
       "letter"
      ]
     ],
     "mustNotSay": [
      "irritable",
      "impatient"
     ]
    },
    "second": {
     "say": "And what's the difference between 'imply' and 'infer'?",
     "simple": "What is the difference between 'imply' and 'infer'?",
     "hindi": "इन दोनों शब्दों के बीच का अंतर बताइए। \"imply\" और \"infer\" के बीच का अंतर अंग्रेज़ी में बताइए।",
     "screen": "imply vs infer",
     "tutor": {
      "brief": "Ask how the words 's the difference between ' and ' and ' are different.",
      "mustInclude": [
       [
        "s the difference between "
       ],
       [
        " and "
       ]
      ],
      "mustNotSay": []
     }
    }
   }
  ],
  "2": [
   {
    "id": "WORD-L2-ACT-1",
    "say": "Look at the picture. What is the person doing?",
    "simple": "What is the person doing?",
    "hindi": "तस्वीर देखिए। यह व्यक्ति क्या कर रहा है? अंग्रेज़ी में बताइए।",
    "screen": "🏊",
    "expect": [
     [
      "swim",
      "swimming"
     ],
     [
      "dance",
      "dancing"
     ]
    ],
    "tutor": {
     "brief": "The learner sees a picture (🏊) of a person swimming. Ask what the person is doing.",
     "mustInclude": [
      [
       "picture",
       "this",
       "screen",
       "doing",
       "तस्वीर",
       "चित्र",
       "ਤਸਵੀਰ"
      ]
     ],
     "mustNotSay": [
      "swim",
      "swimming"
     ]
    },
    "second": {
     "say": "And in this picture? What is the person doing?",
     "simple": "What is the person doing?",
     "hindi": "इस तस्वीर में व्यक्ति क्या कर रहा है, अंग्रेज़ी में बताइए।",
     "screen": "💃",
     "tutor": {
      "brief": "The learner sees a picture (💃) of a person dancing. Ask what the person is doing.",
      "mustInclude": [
       [
        "picture",
        "this",
        "screen",
        "doing",
        "तस्वीर",
        "चित्र",
        "ਤਸਵੀਰ"
       ]
      ],
      "mustNotSay": [
       "dance",
       "dancing"
      ]
     }
    }
   },
   {
    "id": "WORD-L2-ACT-6",
    "say": "Look at the picture. What is the person doing?",
    "simple": "What is the person doing?",
    "hindi": "तस्वीर देखिए। व्यक्ति क्या कर रहा है, अंग्रेज़ी में बताइए।",
    "screen": "🏃",
    "expect": [
     [
      "run",
      "running",
      "jog",
      "jogging"
     ],
     [
      "walk",
      "walking"
     ]
    ],
    "tutor": {
     "brief": "The learner sees a picture (🏃) of a person running. Ask what the person is doing.",
     "mustInclude": [
      [
       "picture",
       "this",
       "screen",
       "doing",
       "तस्वीर",
       "चित्र",
       "ਤਸਵੀਰ"
      ]
     ],
     "mustNotSay": [
      "run",
      "running",
      "jog",
      "jogging"
     ]
    },
    "second": {
     "say": "And in this picture? What is the person doing?",
     "simple": "What is the person doing?",
     "hindi": "इस तस्वीर में व्यक्ति क्या कर रहा है, अंग्रेज़ी में बताइए।",
     "screen": "🚶",
     "tutor": {
      "brief": "The learner sees a picture (🚶) of a person walking. Ask what the person is doing.",
      "mustInclude": [
       [
        "picture",
        "this",
        "screen",
        "doing",
        "तस्वीर",
        "चित्र",
        "ਤਸਵੀਰ"
       ]
      ],
      "mustNotSay": [
       "walk",
       "walking"
      ]
     }
    }
   }
  ]
 },
 "listen": {
  "1": [
   {
    "id": "LISTEN-L1-1",
    "passage": "Neha has two cats. They are white.",
    "question": "How many cats does Neha have?",
    "hindi": "नेहा के पास कितनी बिल्लियाँ हैं? अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "two",
      "2"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L1-2",
    "passage": "Arjun drinks tea in the morning. He drinks milk at night.",
    "question": "What does Arjun drink at night?",
    "hindi": "रात में अर्जुन क्या पीते हैं, यह अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "milk"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L1-3",
    "passage": "The shop opens at nine. It closes at eight.",
    "question": "When does the shop open?",
    "hindi": "दुकान कब खुलती है, यह अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "nine",
      "9"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L1-4",
    "passage": "Mohan has a green car. His brother has a red car.",
    "question": "What colour is Mohan's car?",
    "hindi": "मोहन की कार का रंग क्या है, यह अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "green"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L1-5",
    "passage": "Lata goes to the market on Monday. She buys vegetables.",
    "question": "What does Lata buy?",
    "hindi": "लता क्या खरीदती हैं, यह अंग्रेज़ी में जवाब दीजिए।",
    "expect": [
     [
      "vegetable"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L1-6",
    "passage": "The baby is sleeping. Please talk softly.",
    "question": "What is the baby doing?",
    "hindi": "बच्चा क्या कर रहा है, यह अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "sleep"
     ]
    ],
    "screen": "👂 Listen"
   }
  ],
  "2": [
   {
    "id": "LISTEN-L2-1",
    "passage": "Ravi missed the bus this morning. So he took an auto to his office.",
    "question": "How did Ravi go to his office?",
    "hindi": "रवि अपने ऑफ़िस कैसे गए, यह अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "auto",
      "rickshaw"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L2-2",
    "passage": "It was very hot today. So Pooja stayed at home and watched TV.",
    "question": "Why did Pooja stay at home?",
    "hindi": "पूजा घर पर क्यों रहीं, यह अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "hot",
      "heat"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L2-3",
    "passage": "Sanjay's phone fell in the water. Now he needs to buy a new one.",
    "question": "What does Sanjay need to buy?",
    "hindi": "संजय को क्या खरीदना है, यह अंग्रेज़ी में जवाब दीजिए।",
    "expect": [
     [
      "phone",
      "mobile"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L2-4",
    "passage": "The teacher was sick on Friday. So there was no class that day.",
    "question": "Why was there no class on Friday?",
    "hindi": "शुक्रवार को क्लास क्यों नहीं थी, यह अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "sick",
      "ill",
      "teacher"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L2-5",
    "passage": "Asha wanted a red dress. But the shop only had blue, so she bought a blue one.",
    "question": "What colour dress did Asha buy?",
    "hindi": "आशा ने किस रंग की ड्रेस खरीदी? अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "blue"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L2-6",
    "passage": "Dinner is at eight. But Grandpa eats early, at seven.",
    "question": "When does Grandpa eat?",
    "hindi": "दादाजी कब खाते हैं, यह अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "seven",
      "7"
     ]
    ],
    "screen": "👂 Listen"
   }
  ],
  "3": [
   {
    "id": "LISTEN-L3-1",
    "passage": "The office party was planned for Saturday. But so many people were travelling that it was moved to next Friday.",
    "question": "Why was the party moved?",
    "hindi": "पार्टी क्यों बदली गई, यह अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "travel",
      "away",
      "out of town"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L3-2",
    "passage": "Kavya felt nervous the night before her exam. Her mother told her to sleep early, and the next day she did very well.",
    "question": "What did Kavya's mother tell her to do?",
    "hindi": "काव्या की माँ ने उससे क्या करने को कहा? अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "sleep"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L3-3",
    "passage": "The new phone has a great camera, but its battery doesn't last long. So Vikram bought the older model.",
    "question": "Why didn't Vikram buy the new phone?",
    "hindi": "विक्रम ने नया फोन क्यों नहीं खरीदा? कृपया इसे अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "battery"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L3-4",
    "passage": "Our neighbour's dog barked every night. After we spoke to them, they started keeping it inside after ten.",
    "question": "What changed after they spoke to the neighbour?",
    "hindi": "पड़ोसी से बात करने के बाद क्या बदला? कृपया इसे अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "inside",
      "stopped",
      "quiet"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L3-5",
    "passage": "The bridge was closed for repairs. So the school bus took a longer road, and the children reached late.",
    "question": "Why did the children reach late?",
    "hindi": "बच्चे देर से क्यों पहुँचे? अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "bridge",
      "longer",
      "road",
      "repair"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L3-6",
    "passage": "Rahul usually takes the metro. Today he drove, because he had to carry a heavy box.",
    "question": "Why did Rahul drive today?",
    "hindi": "राहुल ने आज गाड़ी क्यों चलाई? अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "box",
      "heavy",
      "carry"
     ]
    ],
    "screen": "👂 Listen"
   }
  ],
  "4": [
   {
    "id": "LISTEN-L4-1",
    "passage": "The company's profits rose this year, yet it announced fewer new jobs. Its managers would rather invest in machines than hire more people.",
    "question": "Why will there be fewer new jobs?",
    "hindi": "कम नई नौकरियाँ क्यों होंगी? कृपया इसे अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "machine",
      "invest",
      "automation"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L4-2",
    "passage": "Sunita turned down a much higher salary in Mumbai. She said living near her parents mattered more to her than money.",
    "question": "Why did Sunita turn down the job?",
    "hindi": "सुनीता ने नौकरी क्यों ठुकरा दी? कृपया इसे अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "parent",
      "family"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L4-3",
    "passage": "The film was banned in two states before its release. Ironically, the controversy made far more people want to watch it.",
    "question": "What effect did the ban have?",
    "hindi": "बैन का क्या असर हुआ? कृपया इसे अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "more people",
      "curious",
      "popular",
      "want",
      "interest"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L4-4",
    "passage": "Doctors used to recommend complete rest after a back injury. Now they advise gentle movement, which helps people recover faster.",
    "question": "What do doctors advise now?",
    "hindi": "डॉक्टर अब क्या सलाह देते हैं? कृपया इसे अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "movement",
      "move",
      "exercise",
      "walk"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L4-5",
    "passage": "The village had no bank, so people kept their cash at home. When a bank finally opened, many were slow to trust it.",
    "question": "How did people react when the bank opened?",
    "hindi": "बैंक खुलने पर लोगों ने कैसा व्यवहार किया? कृपया इसे अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "trust",
      "slow",
      "doubt",
      "afraid"
     ]
    ],
    "screen": "👂 Listen"
   },
   {
    "id": "LISTEN-L4-6",
    "passage": "Meera's first company failed within a year. Instead of giving up, she used what she had learned to build a second one, which succeeded.",
    "question": "What did Meera do after her first company failed?",
    "hindi": "मीरा ने अपनी पहली कंपनी फेल होने के बाद क्या किया? कृपया इसे अंग्रेज़ी में बताइए।",
    "expect": [
     [
      "second",
      "again",
      "new company",
      "another",
      "learn"
     ]
    ],
    "screen": "👂 Listen"
   }
  ]
 },
 "read": {
  "1": [
   {
    "id": "READ-L1-1",
    "screen": "I have a brother and a sister."
   },
   {
    "id": "READ-L1-2",
    "screen": "The sun is very hot today."
   },
   {
    "id": "READ-L1-3",
    "screen": "My mother makes good food."
   },
   {
    "id": "READ-L1-4",
    "screen": "I go to work by bus."
   },
   {
    "id": "READ-L1-5",
    "screen": "This is my new phone."
   },
   {
    "id": "READ-L1-6",
    "screen": "We eat dinner at eight."
   }
  ],
  "2": [
   {
    "id": "READ-L2-1",
    "screen": "Yesterday I went to the market and bought some fresh vegetables."
   },
   {
    "id": "READ-L2-2",
    "screen": "My sister works in a hospital and helps sick people every day."
   },
   {
    "id": "READ-L2-3",
    "screen": "Please call me when you reach the station."
   },
   {
    "id": "READ-L2-4",
    "screen": "We are planning a short trip to the hills next month."
   },
   {
    "id": "READ-L2-5",
    "screen": "The children were playing in the park when it started to rain."
   },
   {
    "id": "READ-L2-6",
    "screen": "I usually wake up early, but today I slept until nine."
   }
  ],
  "3": [
   {
    "id": "READ-L3-1",
    "screen": "If the meeting finishes on time, I will be able to catch the evening train home."
   },
   {
    "id": "READ-L3-2",
    "screen": "Even though the restaurant was expensive, the food and the service were worth it."
   },
   {
    "id": "READ-L3-3",
    "screen": "She has been learning the guitar for three years, and she practises every evening."
   },
   {
    "id": "READ-L3-4",
    "screen": "The government announced new rules to reduce air pollution in the city during winter."
   },
   {
    "id": "READ-L3-5",
    "screen": "Unless we leave before six, we will probably get stuck in heavy traffic on the highway."
   },
   {
    "id": "READ-L3-6",
    "screen": "My manager suggested that I take a short course to improve my presentation skills."
   }
  ],
  "4": [
   {
    "id": "READ-L4-1",
    "screen": "Notwithstanding the initial scepticism, the initiative eventually garnered widespread support from local communities."
   },
   {
    "id": "READ-L4-3",
    "screen": "Her meticulous attention to detail, combined with an unwavering commitment, distinguished her from her contemporaries."
   },
   {
    "id": "READ-L4-4",
    "screen": "The archaeologists' discovery fundamentally challenged prevailing assumptions about the region's ancient civilisation."
   },
   {
    "id": "READ-L4-5",
    "screen": "Despite unprecedented rainfall, the city's newly renovated drainage system functioned remarkably well throughout the monsoon."
   },
   {
    "id": "READ-L4-6",
    "screen": "The negotiations, though prolonged and occasionally acrimonious, ultimately culminated in a mutually beneficial agreement."
   }
  ]
 },
 "speak": {
  "3": [
   {
    "id": "SPEAK-L3-1",
    "say": "If you could learn any new skill this year, what would it be?",
    "simple": "What new skill will you learn?",
    "hindi": "अगर आप इस साल कोई नई skill सीख सकें, तो वह क्या होगी? कृपया अपना जवाब अंग्रेज़ी में दीजिए।",
    "tutor": {
     "brief": "Ask: If you could learn any new skill this year, what would it be?",
     "mustInclude": [
      [
       "skill"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L3-2",
    "say": "What is one thing you would change about how people use mobile phones?",
    "simple": "What would you change about phones?",
    "hindi": "लोग मोबाइल फ़ोन जैसे इस्तेमाल करते हैं, उसमें आप कौन सी एक चीज़ बदलना चाहेंगे? अंग्रेज़ी में बताइए।",
    "tutor": {
     "brief": "Ask: What is one thing you would change about how people use mobile phones?",
     "mustInclude": [
      [
       "phone"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L3-3",
    "say": "If you won a lot of money, how would you spend it?",
    "simple": "If you get money, what will you spend it on?",
    "hindi": "अगर आपको बहुत पैसा मिले, तो आप उसे कैसे खर्च करेंगे, इसे अंग्रेज़ी में बताइए।",
    "tutor": {
     "brief": "Ask: If you won a lot of money, how would you spend it?",
     "mustInclude": [
      [
       "money"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L3-4",
    "say": "In your opinion, what is the best way to learn a new language?",
    "simple": "How to learn a new language best?",
    "hindi": "एक नई भाषा सीखने का सबसे अच्छा तरीका क्या है, इस पर अपना जवाब अंग्रेज़ी में दीजिए।",
    "tutor": {
     "brief": "Ask: In your opinion, what is the best way to learn a new language?",
     "mustInclude": [
      [
       "language"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L3-5",
    "say": "Would you rather live in a big city or a small town?",
    "simple": "Big city or small town to live?",
    "hindi": "आप बड़े शहर में रहना पसंद करेंगे या छोटे कस्बे में? अंग्रेज़ी में बताइए।",
    "tutor": {
     "brief": "Ask: Would you rather live in a big city or a small town?",
     "mustInclude": [
      [
       "city"
      ],
      [
       "town"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L3-6",
    "say": "What advice would you give to someone starting their first job?",
    "simple": "What advice for a first job?",
    "hindi": "अपनी पहली नौकरी शुरू करने वाले को आप क्या सलाह देंगे, इसे अंग्रेज़ी में बताइए।",
    "tutor": {
     "brief": "Ask: What advice would you give to someone starting their first job?",
     "mustInclude": [
      [
       "job"
      ],
      [
       "advice"
      ]
     ],
     "mustNotSay": []
    }
   }
  ],
  "4": [
   {
    "id": "SPEAK-L4-1",
    "say": "Some people believe working from home is better than working in an office. What is your view?",
    "simple": "Work from home or office?",
    "hindi": "घर से काम करना कार्यालय में काम करने से बेहतर है, इस पर आपकी क्या राय है, इसे अंग्रेज़ी में बताइए।",
    "tutor": {
     "brief": "Ask: Some people believe working from home is better than working in an office. What is your view? Then invite them to argue a position with reasons.",
     "mustInclude": [
      [
       "home"
      ],
      [
       "office"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L4-2",
    "say": "Should schools teach practical life skills instead of preparing children for more exams? What do you think?",
    "simple": "Schools teach life skills or exams?",
    "hindi": "स्कूलों में व्यावहारिक जीवन कौशल सिखाया जाना चाहिए या बच्चों को अधिक परीक्षाओं के लिए तैयार किया जाना चाहिए, इस पर आपका क्या विचार है, इसे अंग्रेज़ी में बताइए।",
    "tutor": {
     "brief": "Ask: Should schools teach practical life skills instead of preparing children for more exams? What do you think? Then invite them to argue a position with reasons.",
     "mustInclude": [
      [
       "school"
      ],
      [
       "exam"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L4-3",
    "say": "Many people say social media does more harm than good. Do you agree?",
    "simple": "Social media good or bad?",
    "hindi": "बहुत लोग कहते हैं कि सोशल मीडिया से फ़ायदे से ज़्यादा नुकसान होता है। क्या आप सहमत हैं? अंग्रेज़ी में बताइए।",
    "tutor": {
     "brief": "Ask: Many people say social media does more harm than good. Do you agree? Then invite them to argue a position with reasons.",
     "mustInclude": [
      [
       "social media"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L4-4",
    "say": "Is it more important to earn a high salary or to enjoy your work? What is your view?",
    "simple": "High salary or fun work?",
    "hindi": "उच्च वेतन कमाना या अपने काम का आनंद लेना, इनमें से क्या अधिक महत्वपूर्ण है, इस पर अपनी राय अंग्रेज़ी में बताइए।",
    "tutor": {
     "brief": "Ask: Is it more important to earn a high salary or to enjoy your work? What is your view? Then invite them to argue a position with reasons.",
     "mustInclude": [
      [
       "salary",
       "money"
      ],
      [
       "enjoy"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L4-5",
    "say": "Some argue that cities should ban private cars from their centres. What is your opinion?",
    "simple": "Cars banned in cities?",
    "hindi": "शहरों के केंद्रों से निजी कारें बंद की जानी चाहिए, इस पर आपका क्या विचार है, इसे अंग्रेज़ी में बताइए।",
    "tutor": {
     "brief": "Ask: Some argue that cities should ban private cars from their centres. What is your opinion? Then invite them to argue a position with reasons.",
     "mustInclude": [
      [
       "car"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L4-6",
    "say": "Will artificial intelligence create more jobs than it takes away? What do you think?",
    "simple": "AI create or remove jobs?",
    "hindi": "कृत्रिम बुद्धि अधिक नौकरियां पैदा करेगी या छीन लेगी, इस पर आप क्या सोचते हैं, इसे अंग्रेज़ी में बताइए।",
    "tutor": {
     "brief": "Ask: Will artificial intelligence create more jobs than it takes away? What do you think? Then invite them to argue a position with reasons.",
     "mustInclude": [
      [
       "artificial intelligence",
       "ai "
      ],
      [
       "job"
      ]
     ],
     "mustNotSay": []
    }
   }
  ],
  "1": [
   {
    "id": "SPEAK-L1-ME-1",
    "say": "What food do you like? Start with 'I like'…",
    "simple": "What food do you like?",
    "hindi": "आपको कौन सा खाना पसंद है? \"I like\" से शुरू करके अंग्रेज़ी में बताइए।",
    "screen": "I like ______ 🍛",
    "tutor": {
     "brief": "Ask: What food do you like? Encourage them to start with 'I like'.",
     "mustInclude": [
      [
       "food",
       "eat"
      ],
      [
       "i like"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L1-ME-3",
    "say": "Who is in your family? Start with 'In my family, there is'…",
    "simple": "Who is in your family?",
    "hindi": "आपके परिवार में कौन-कौन है? \"In my family, there is\" से शुरू करके अंग्रेज़ी में बताइए।",
    "screen": "In my family, there is ______ 👨‍👩‍👧",
    "tutor": {
     "brief": "Ask: Who is in your family? Encourage them to start with 'In my family, there is'.",
     "mustInclude": [
      [
       "family"
      ],
      [
       "in my family"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L1-ME-4",
    "say": "What is your favourite festival? Start with 'My favourite festival is'…",
    "simple": "What is your favourite festival?",
    "hindi": "आपका सबसे पसंदीदा त्योहार कौन सा है? \"My favourite festival is\" से शुरू करके अंग्रेज़ी में बताइए।",
    "screen": "My favourite festival is ______ 🪔",
    "tutor": {
     "brief": "Ask: What is your favourite festival? Encourage them to start with 'My favourite festival is'.",
     "mustInclude": [
      [
       "festival"
      ],
      [
       "my favourite festival",
       "my favorite festival"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L1-ME-5",
    "say": "Where do you live? Start with 'I live in'…",
    "simple": "Where do you live?",
    "hindi": "आप कहाँ रहते हैं? \"I live in\" से शुरू करके अंग्रेज़ी में बताइए।",
    "screen": "I live in ______ 🏠",
    "tutor": {
     "brief": "Ask: Where do you live? Encourage them to start with 'I live in'.",
     "mustInclude": [
      [
       "live"
      ],
      [
       "i live in"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L1-ME-6",
    "say": "What do you like to drink? Start with 'I like to drink'…",
    "simple": "What do you like to drink?",
    "hindi": "आपको क्या पीना पसंद है? \"I like to drink\" से शुरू करके अंग्रेज़ी में बताइए।",
    "screen": "I like to drink ______ ☕",
    "tutor": {
     "brief": "Ask: What do you like to drink? Encourage them to start with 'I like to drink'.",
     "mustInclude": [
      [
       "drink"
      ],
      [
       "i like to drink"
      ]
     ],
     "mustNotSay": []
    }
   }
  ],
  "2": [
   {
    "id": "SPEAK-L2-NEW-1",
    "say": "What did you do last weekend?",
    "simple": "What did you do last weekend?",
    "hindi": "पिछले weekend पर आपने क्या किया, अंग्रेज़ी में बताइए।",
    "screen": "Last weekend, I… 📅",
    "tutor": {
     "brief": "Ask: What did you do last weekend?",
     "mustInclude": [
      [
       "weekend"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L2-NEW-2",
    "say": "Tell me about your best friend.",
    "simple": "Tell me about your best friend.",
    "hindi": "अपने best friend के बारे में अंग्रेज़ी में बताइए।",
    "screen": "My best friend… 🧑‍🤝‍🧑",
    "tutor": {
     "brief": "Ask: Tell me about your best friend.",
     "mustInclude": [
      [
       "friend"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L2-NEW-3",
    "say": "Your friend is coming to your house. Tell them how to get there from the bus stop.",
    "simple": "Tell your friend how to get to your house from the bus stop.",
    "hindi": "बस stop से आपके घर पहुँचने का रास्ता अपने दोस्त को बताइए, अंग्रेज़ी में बताइए।",
    "screen": "From the bus stop… 🚏",
    "tutor": {
     "brief": "Ask: Your friend is coming to your house. Tell them how to get there from the bus stop.",
     "mustInclude": [
      [
       "bus stop"
      ],
      [
       "house",
       "home"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L2-NEW-4",
    "say": "What did you eat yesterday?",
    "simple": "What did you eat yesterday?",
    "hindi": "कल आपने क्या खाया, अंग्रेज़ी में बताइए।",
    "screen": "Yesterday, I ate… 🍽️",
    "tutor": {
     "brief": "Ask: What did you eat yesterday?",
     "mustInclude": [
      [
       "yesterday"
      ],
      [
       "eat",
       "ate"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L2-NEW-5",
    "say": "Tell me about your home.",
    "simple": "Tell me about your home.",
    "hindi": "अपने घर के बारे में बताइए। अंग्रेज़ी में जवाब दीजिए।",
    "screen": "My home… 🏠",
    "tutor": {
     "brief": "Ask: Tell me about your home.",
     "mustInclude": [
      [
       "home",
       "house"
      ]
     ],
     "mustNotSay": []
    }
   },
   {
    "id": "SPEAK-L2-NEW-6",
    "say": "You left your phone in a shop. What do you say to the shopkeeper?",
    "simple": "Your phone is in a shop. What will you say to the shopkeeper?",
    "hindi": "अगर आपका phone किसी shop में छूट गया है, तो shopkeeper से आप क्या कहेंगे? अंग्रेज़ी में बताइए।",
    "screen": "At the shop… 📱",
    "tutor": {
     "brief": "Ask: You left your phone in a shop. What do you say to the shopkeeper?",
     "mustInclude": [
      [
       "phone"
      ],
      [
       "shop"
      ]
     ],
     "mustNotSay": []
    }
   }
  ]
 }
};
