// Minimal stand-in for Sarvam's REST API (chat completions, streamed text-to-speech, speech-to-text) for tests.
// The tutor replies satisfy the MUST INCLUDE list it's given; set `mock.tutorMode = 'leak'` to make it give
// away an answer instead (the server should then fall back to the scripted line), or 'invent-name' to make it
// call the learner "Riya". Every tutor prompt is kept in `state.tutorPrompts`.
import { createServer } from 'node:http';

// A rough stand-in for the "understand" step, enough for the conversation tests.
function understand(user) {
  const said = user.match(/Learner replied: (.*)/)?.[1] || '';
  const r = { intent: 'answer', missing: [], name: null, facts: [], prefersHindi: false };
  if (/speak in hindi|talk in hindi/i.test(said)) Object.assign(r, { intent: 'in_hindi', prefersHindi: true });
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
      else if (/examiner/.test(sys)) content = '{"comprehension":3,"vocabulary":3,"grammar":3,"fluency":3,"pronunciation":3,"coherence":3,"relevant":true,"note":"ok"}';
      else if (/You are Sakhi/.test(sys)) {
        const must = (user.match(/MUST INCLUDE[^:]*: (.*)/)?.[1] || '').split(';').map((g) => g.match(/"([^"]+)"/)?.[1]).filter(Boolean);
        const never = (user.match(/MUST NOT SAY: (.*)/)?.[1] || '').match(/"([^"]+)"/)?.[1];
        state.tutorPrompts.push(user);
        const ask = state.tutorMode === 'leak' && never ? `Is it ${never}? Tell me about ${must.join(' and ')}.`
          : /conversation is ending/.test(user) ? `You're a ${must[0]} speaker. It was lovely talking with you.`
          : must.length ? `Let's keep going: tell me about ${must.join(' and ')}?` : 'What else can you tell me about that?';
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
