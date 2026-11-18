// The demo model of the App Review server: a tiny OpenAI-compatible server (no dependencies) that answers
// `GET /v1/models` and `POST /v1/chat/completions`. It is the placeholder model the reviewer can always use, and with
// `DEMO_MODEL_SCRIPT` (a JSON file of `{ match, reply, title }`) it answers the scripted questions the demo's
// conversations were made from (scripts/seed.mjs).
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

const port = Number(process.env.DEMO_MODEL_PORT ?? 8099);
const scripted = process.env.DEMO_MODEL_SCRIPT && existsSync(process.env.DEMO_MODEL_SCRIPT) ? JSON.parse(readFileSync(process.env.DEMO_MODEL_SCRIPT, 'utf8')) : [];

const NOTICE =
  "This is the demo model of Atelier's App Review server. It answers with this fixed message instead of thinking about " +
  'your question, so that sending always works.\n\n' +
  '- To chat with a real model here, choose **GPT** in the model picker above the message box.\n' +
  '- In your own Atelier server you choose the models: your computers, hosted ones with your keys, or models on this iPhone.\n' +
  '- The conversations in the list were made with this server, to show how Atelier formats answers.';

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('\n') : '');
const lastUser = (messages) => textOf([...messages].reverse().find((m) => m.role === 'user')?.content);
const firstUser = (messages) => textOf(messages.find((m) => m.role === 'user')?.content);
const find = (text) => scripted.find((s) => text.toLowerCase().includes(String(s.match).toLowerCase()));

/** What to say to this request. Atelier also asks the model for a conversation's title: that gets the scripted one. */
function answer(body) {
  const messages = body.messages ?? [];
  const joined = messages.map((m) => textOf(m.content)).join('\n');
  if (/\b(short|concise)\b[^.]*\btitle\b|\btitle\b[^.]*\b(conversation|chat)\b/i.test(joined) && !find(lastUser(messages))) {
    const entry = find(firstUser(messages));
    if (entry?.title) return entry.title;
    return firstUser(messages).split(/\s+/).slice(0, 5).join(' ') || 'Demo conversation';
  }
  return find(lastUser(messages))?.reply ?? NOTICE;
}

const chunks = (text) => text.match(/\S+\s*|\s+/g) ?? [text];

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const json = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    return json(200, { object: 'list', data: [{ id: 'demo-model', object: 'model', owned_by: 'atelier-demo', context_length: 32768 }] });
  }
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let raw = '';
    for await (const piece of req) raw += piece;
    const body = JSON.parse(raw || '{}');
    const text = answer(body);
    const id = `chatcmpl-demo-${Date.now().toString(36)}`;
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model ?? 'demo-model' };
    const usage = { prompt_tokens: 12, completion_tokens: Math.ceil(text.length / 4), total_tokens: 12 + Math.ceil(text.length / 4) };
    if (!body.stream) {
      return json(200, { id, object: 'chat.completion', created: base.created, model: base.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    for (const piece of chunks(text)) {
      if (res.destroyed) return;
      send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      await new Promise((resolve) => setTimeout(resolve, scripted.length ? 2 : 18));
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ ...base, choices: [], usage });
    res.end('data: [DONE]\n\n');
    return;
  }
  json(404, { error: { message: 'Nothing here: this demo model answers /v1/models and /v1/chat/completions.' } });
}).listen(port, '127.0.0.1', () => console.log(`demo model on 127.0.0.1:${port}`));
