// Minimal stand-in for Sarvam's REST API (chat completions, text-to-speech, speech-to-text) for tests.
import { createServer } from 'node:http';

const tinyWav = Buffer.concat([Buffer.from('RIFF$\0\0\0WAVEfmt ', 'latin1'), Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0]), Buffer.from('data\0\0\0\0', 'latin1')]).toString('base64');

export function startMockRest({ transcript = 'my name is ravi i like tea' } = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    calls.push({ path: req.url, key: req.headers['api-subscription-key'] });
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/v1/chat/completions') {
      const sys = JSON.parse(body).messages[0].content;
      const content = /Classify their reply/.test(sys) ? '{"intent":"answer"}'
        : /examiner/.test(sys) ? '{"comprehension":3,"vocabulary":2,"grammar":2,"fluency":3,"pronunciation":2,"coherence":2,"relevant":true,"note":"ok"}'
        : 'Nice to meet you!';
      return json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
    }
    if (req.url === '/text-to-speech') return json({ request_id: 'mock', audios: [tinyWav] });
    if (req.url === '/speech-to-text') return json({ request_id: 'mock', transcript, language_code: 'en-IN', language_probability: 0.99 });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}
