// Minimal stand-in for Sarvam's REST API (chat completions, streamed text-to-speech, speech-to-text) for tests.
// The tutor replies satisfy the MUST INCLUDE list it's given; set `mock.tutorMode = 'leak'` to make it give
// away an answer instead (the server should then fall back to the scripted line).
import { createServer } from 'node:http';

export function startMockRest({ transcript = 'my name is ravi i like tea' } = {}) {
  const calls = [];
  const state = { tutorMode: 'good' };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    calls.push({ path: req.url, key: req.headers['api-subscription-key'] });
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/v1/chat/completions') {
      const msgs = JSON.parse(body).messages, sys = msgs[0].content, user = msgs[1]?.content || '';
      let content;
      if (/Classify their reply/.test(sys)) content = '{"intent":"answer"}';
      else if (/examiner/.test(sys)) content = '{"comprehension":3,"vocabulary":3,"grammar":3,"fluency":3,"pronunciation":3,"coherence":3,"relevant":true,"note":"ok"}';
      else if (/You are Sakhi/.test(sys)) {
        const must = (user.match(/MUST INCLUDE[^:]*: (.*)/)?.[1] || '').split(';').map((g) => g.match(/"([^"]+)"/)?.[1]).filter(Boolean);
        const never = (user.match(/MUST NOT SAY: (.*)/)?.[1] || '').match(/"([^"]+)"/)?.[1];
        const ask = state.tutorMode === 'leak' && never ? `Is it ${never}? Tell me about ${must.join(' and ')}.`
          : must.length ? `Let's keep going: tell me about ${must.join(' and ')}?` : 'What else can you tell me about that?';
        content = JSON.stringify({ reaction: 'Thanks for sharing that.', ask });
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
