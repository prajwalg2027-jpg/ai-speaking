// Minimal stand-in for Sarvam's REST API (chat completions, streamed text-to-speech, speech-to-text) for tests.
// The tutor replies satisfy the MUST INCLUDE list it's given; set `mock.tutorMode = 'leak'` to make it give
// away an answer instead (the server should then fall back to the scripted line), or 'invent-name' to make it
// call the learner "Riya". Every tutor prompt is kept in `state.tutorPrompts`.
import { createServer } from 'node:http';

// A rough stand-in for the "understand" step, enough for the conversation tests.
function understand(user) {
  const said = user.match(/Learner replied: (.*)/)?.[1] || '';
  const r = { intent: 'answer', english: 'yes', language: null, missing: [], name: null, facts: [] };
  if (/[\u0900-\u097F]/.test(said) || /\b(bahut|maza|kaam|karta|hai)\b/i.test(said)) r.english = 'no';
  const lang = said.match(/(?:speak|talk) in (\w+)/i)?.[1];
  if (/petrol station/.test(said)) Object.assign(r, { language: 'null', name: 'null' }); // the model writing "null" as text
  if (lang) Object.assign(r, { intent: 'language', language: lang });
  else if (/NOTE: the learner talked over/.test(user) && said.split(/\s+/).length < 8) r.intent = 'reply';
  else if (/my name is not|why are you calling me/i.test(said)) r.intent = 'meta';
  const name = said.match(/my name is (?!not)(\w+)/i)?.[1] || said.match(/\bit'?s (\w+)\b/i)?.[1];
  if (name) r.name = name[0].toUpperCase() + name.slice(1);
  if (/teacher/i.test(said)) r.facts.push('works as a teacher');
  // Two-part word tasks: a reply naming only one thing hasn't tried the other part.
  if (/PARTS:/.test(user) && said.trim().split(/\s+/).length <= 5) r.missing = [2];
  return r;
}

export function startMockRest({ transcript = 'my name is ravi i like tea' } = {}) {
  const calls = [];
  const state = { tutorMode: 'good', tutorPrompts: [] };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    calls.push({ path: req.url, key: req.headers['api-subscription-key'] });
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/v1/chat/completions') {
      const msgs = JSON.parse(body).messages, sys = msgs[0].content, user = msgs[1]?.content || '';
      let content;
      if (/understand what a learner just said/.test(sys)) content = JSON.stringify(understand(user));
      else if (/explain an English speaking check/.test(sys)) content = JSON.stringify({ doingWell: ['You talked about your work.', 'You answered every question.'], practise: ['Try to use longer sentences.', 'Say went for last week, not go.'] });
      else if (/talked over the tutor/.test(sys)) content = JSON.stringify({ continues: /Learner then said: (and|also)\b/i.test(user) });
      // The learning module: a tutor turn (corrects "I go" when the learner wrote it), the check, exercise marking.
      else if (/double-checking corrections/.test(sys)) content = JSON.stringify({ decisions: [...user.matchAll(/^(\d+)\. "([^"]+)"/gm)].map((m) => ({ index: Number(m[1]), original: m[2], verdict: 'real_mistake', reason: 'wrong tense' })) });
      else if (/marking one exercise/.test(sys)) content = JSON.stringify({ verdict: 'correct', feedback: 'Well done!', corrections: [] });
      else if (/patient English teacher for adult learners/.test(sys)) {
        const said = user.match(/LAST message[^:]*: (.*)/)?.[1] || '';
        content = JSON.stringify({ reply: 'That sounds nice! What happened next?', encouragement: null, follow_up_question: 'What happened next?', learning_signals: [],
          corrections: /\bI go\b/.test(said) ? [{ original: 'I go', corrected: 'I went', category: 'grammar', concept: 'past_simple', explanation: 'Use went for the past.', severity: 'important' }] : [] });
      }
      // The conversation placement's brain: reads the step and the app's facts from the note (the last message)
      // and answers in the shape the real AI must use.
      else if (/first talk with them/.test(sys)) {
        const note = msgs.at(-1).content, last = msgs.at(-2)?.content || '';
        const said = /^\(.*\)$/.test(last) ? null : last;
        const step = note.match(/STEP: (HELLO|PICTURE|READING|OPEN QUESTION)/)?.[1];
        const words = said ? (said.match(/[A-Za-z']+/g) || []).length : 0;
        const help = said == null || /\b(sorry|repeat|don't understand|did not understand|hindi)\b/i.test(said);
        const stay = help && /- asked_for_help: stay/.test(note);
        const o = { happened: help ? 'asked_for_help' : 'answered', picture: null, reading: null, level: null, evidence: `${words} words`, tip: null, name: null, reply: help ? 'No problem.' : 'That sounds nice.', question: '', finish: false, final: null };
        const final = (level) => ({ level, reason: `Mock: level ${level}.`, doingWell: ['You answered every question in English.', 'You talked about your own life.'], practise: ["Say 'I went' instead of 'I go' for yesterday.", 'Next, we will join two ideas with because.'], closing: 'You talked about your life in English. Next, we will practise talking about yesterday.' });
        if (stay) o.question = 'Let me ask again, more simply. आसान शब्दों में फिर से पूछती हूँ।';
        else if (step === 'HELLO') { o.name = said?.match(/my name is (\w+)/i)?.[1] || null; o.reply = o.name ? `Nice to meet you, ${o.name}!` : 'Hello!'; o.question = 'A picture is on your screen. What is it called in English?'; }
        else if (step === 'PICTURE') { o.picture = !help && /" is in their reply/.test(note) ? 'named' : help ? null : 'not_named'; o.reply = o.picture === 'named' ? 'Yes!' : 'Okay.'; o.question = 'Now please read the line on your screen out loud.'; }
        else if (step === 'READING') {
          const m = note.match(/matched about (\d+) of its (\d+) words/), share = m ? m[1] / m[2] : 0;
          o.reading = help ? null : share >= 0.8 ? 'well' : share >= 0.4 ? 'partly' : 'not';
          if (/Picture: named/.test(note) || ['well', 'partly'].includes(o.reading)) o.question = 'So, what did you do this morning?';
          else { o.finish = true; o.final = final(1); }
        } else {
          o.level = help ? null : words < 4 ? 1 : words < 12 ? 2 : words < 28 ? 3 : 4;
          if (/\bI go\b/.test(said || '')) { o.tip = { said: 'I go', better: 'I went' }; o.reply = 'Oh, you went there!'; }
          const before = [...note.matchAll(/level (\d) \(\d+ English words\)/g)].map((x) => Number(x[1]));
          if (/Finish now/.test(note) || (o.level || 0) <= 2 || before.includes(o.level)) { o.finish = true; o.final = final(Math.max(2, Math.min(o.level || 2, ...(before.length ? [Math.max(...before)] : [4])))); }
          else o.question = 'Here is a harder question: why do you like it?';
        }
        content = JSON.stringify(o);
      }
      else if (/first short talk with a learner/.test(sys)) content = JSON.stringify({ doingWell: ['You answered every question in English.', 'You talked about your own life.'], practise: ["Say 'I went' instead of 'I go' for yesterday.", 'Next, we will join two ideas with because.'], closing: 'You talked about your life in English. Next, we will practise talking about yesterday.' });
      else if (/examiner/.test(sys)) content = '{"comprehension":3,"vocabulary":3,"grammar":3,"fluency":3,"pronunciation":3,"coherence":3,"relevant":true,"note":"ok"}';
      else if (/You are Sakhi/.test(sys)) {
        const must = (user.match(/MUST INCLUDE[^:]*: (.*)/)?.[1] || '').split(';').map((g) => g.match(/"([^"]+)"/)?.[1]).filter(Boolean);
        const never = (user.match(/MUST NOT SAY: (.*)/)?.[1] || '').match(/"([^"]+)"/)?.[1];
        state.tutorPrompts.push(user);
        let ask = state.tutorMode === 'leak' && never ? `Is it ${never}? Tell me about ${must.join(' and ')}.`
          : must[0] === 'listen' ? 'Now listen carefully to two short sentences.'
          : /The sentence is on their screen/.test(user) ? 'Please read the sentence on your screen out loud.'
          : /conversation is ending/.test(user) ? `You're a ${must[0]} speaker. It was lovely talking with you.`
          : must.length ? `Let's keep going: tell me about ${must.join(' and ')}?` : 'What else can you tell me about that?';
        if (/LANGUAGE: The learner asked to talk in Punjabi/.test(user)) ask = `ਚਲੋ! ${ask}`; // writes Punjabi when asked
        content = JSON.stringify({ reaction: state.tutorMode === 'invent-name' ? 'Thanks for sharing that, Riya.' : 'Thanks for sharing that.', ask });
      } else content = 'Nice to meet you!';
      return json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
    }
    if (req.url === '/text-to-speech/stream') {
      res.writeHead(200, { 'content-type': 'audio/pcm' });
      res.write(Buffer.alloc(4800)); setTimeout(() => res.end(Buffer.alloc(4800)), 10);
      return;
    }
    if (req.url === '/speech-to-text') return json({ request_id: 'mock', transcript, language_code: 'en-IN', language_probability: 0.99 });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, calls, state, close: () => server.close() })));
}
