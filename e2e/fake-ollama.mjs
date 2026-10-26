#!/usr/bin/env node
/**
 * Scripted stand-in for an Ollama server, for end-to-end tests and manual QA without a GPU.
 * Speaks the subset of the native API the Ollama adapter uses. The reply is picked from keywords in
 * the last user message:
 *   "markdown" → headings, list, table, code, math, mermaid    "think" → thinking, then text
 *   "artifact" → an `artifact` tool call (HTML page)              "slow"  → ~12s stream (stop/reconnect tests)
 *   "fail"     → HTTP 500                                         "context?" → project instructions + document names it was given
 *   "safeguards?" → whether the optional content settings block reached its system prompt
 *   "system has <word>?" → whether that word is in its system prompt (instruction files that reached it)
 *   "long"     → ~2,400 characters over ~8s (live token counts)
 *   "shellblock" → a short reply with one bash code block (`echo from-the-block`)
 *   "request?" → the `think` value it was sent and what the notes in front of the message say about Ultracode (yes: on, off, no: nothing)
 *   lines "call <Tool> <json>" → those tool calls, one per step in order (Code view tests), then the last result;
 *     the "artifact" keyword doesn't apply to such a script, so it can call `artifact` with a `file_path`
 *   only a note that a background sub-agent ended → "Heard back from <task>: <its first words>."
 *   anything else → a short echo
 * `<context-update>` notes in front of the message are ignored (only "request?" and the background note read them), and
 * so is a loop's note after it. Title requests (system prompt asks for a title) get a fixed title, suggested-reply requests
 * "commit it". Compaction requests (a `<transcript>` or
 * `<partial-summaries>` message) get a summary saying how many tool calls are done, so a scripted task carries on
 * after it. Prompt token counts are the request's size at four characters a token.
 *
 * Usage: node e2e/fake-ollama.mjs [port=11500]
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 11500);
const MODELS = [
  { name: 'fake-chat:8b', capabilities: ['completion', 'tools'], ctx: 32768 },
  { name: 'fake-think:14b', capabilities: ['completion', 'tools', 'thinking'], ctx: 65536, think: ['low', 'medium', 'high'] },
  { name: 'fake-vision:4b', capabilities: ['completion', 'vision'], ctx: 8192 },
  // Small enough that a scripted Code task compacts on the way (context.desktop.spec.ts).
  { name: 'fake-tiny:1b', capabilities: ['completion', 'tools'], ctx: 8192 },
];

const MARKDOWN = `## Sorting at a glance

Quicksort is usually fastest in practice; **mergesort** is stable; heapsort needs $O(1)$ extra space.

- Quicksort: average $O(n \\log n)$
- Mergesort: always $O(n \\log n)$

| Algorithm | Average | Stable |
| --- | --- | --- |
| Quicksort | O(n log n) | No |
| Mergesort | O(n log n) | Yes |

\`\`\`ts
export function quicksort(xs: number[]): number[] {
  if (xs.length < 2) return xs;
  const [pivot, ...rest] = xs;
  return [...quicksort(rest.filter((x) => x < pivot)), pivot, ...quicksort(rest.filter((x) => x >= pivot))];
}
\`\`\`

$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$

\`\`\`mermaid
graph LR
  A[Input] --> B{n < 2?}
  B -- yes --> C[Return]
  B -- no --> D[Partition] --> A
\`\`\`
`;

const HTML_PAGE = `<!doctype html><html><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<button id="b" style="font-size:20px;padding:12px 20px">Clicked 0 times</button>
<script>let n=0;b.onclick=()=>b.textContent='Clicked '+(++n)+' times';</script></body></html>`;

const reconnectAttempts = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = (text, size) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

async function chat(req, res) {
  const body = await readBody(req);
  const messages = body.messages ?? [];
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const latest = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  // The notes Atelier puts in front of a message aren't the person's words: the script reacts to what they typed (and
  // still sees what follows it, such as a /command's text).
  const notes = /^(?:<context-update>[\s\S]*?<\/context-update>\s*)*/.exec(latest)[0];
  const lastUser = latest.slice(notes.length).replace(/\s*<context-update>\nThis message comes from a loop[\s\S]*?<\/context-update>/, '');
  const answeredTool = messages.at(-1)?.role === 'tool';
  if (lastUser.startsWith('reconnect-probe ') && !/short title/i.test(system)) {
    const attempts = reconnectAttempts.get(lastUser) ?? 0;
    reconnectAttempts.set(lastUser, attempts + 1);
    if (attempts === 0) {
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'temporarily unavailable' }));
      return;
    }
  }
  if (/fail/i.test(lastUser) && !/short title/i.test(system)) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'scripted failure' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const send = (message, extra = {}) => res.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '', ...message }, done: false, ...extra }) + '\n');
  const promptTokens = Math.ceil(JSON.stringify([messages, body.tools ?? []]).length / 4);
  const done = (evalCount) =>
    res.end(
      JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: promptTokens, eval_count: evalCount, eval_duration: evalCount * 25e6, total_duration: evalCount * 30e6 }) + '\n',
    );

  // Memory updates (Settings › Memory's bar): what the person said becomes their Preferences.
  if (/^You keep the memory /.test(system)) {
    const said = /<document name="what they said">\n([\s\S]*?)\n<\/document>/.exec(lastUser)?.[1];
    // "fill memory" seeds many long entries, for layout checks of a full Memory page.
    if (said === 'fill memory') {
      const lines = (n, what) => Array.from({ length: n }, (_, i) => `- ${what} fact ${i + 1}: a detail long enough to wrap onto a second line in the entry page`);
      const entries = Array.from({ length: 24 }, (_, i) => ({ op: 'create', section: ['topic', 'area', 'person'][i % 3], title: `Entry ${i + 1}`, summary: `Summary of entry ${i + 1}, long enough to be cut off at the row's end`, details: lines(60, `Entry ${i + 1}`) }));
      send({ content: JSON.stringify({ ops: [{ op: 'update', section: 'preferences', details: lines(40, 'Preference') }, ...entries] }) });
      return done(20);
    }
    send({ content: JSON.stringify({ ops: said ? [{ op: 'update', section: 'preferences', details: `- ${said}` }] : [] }) });
    return done(20);
  }
  if (/next message in this conversation/i.test(system)) {
    send({ content: 'commit it' });
    return done(4);
  }
  if (/short title/i.test(system)) {
    send({ content: /markdown/i.test(lastUser) ? 'Sorting algorithms compared' : 'Scripted demo chat' });
    return done(4);
  }
  if (/^<(transcript|partial-summaries)/.test(lastUser)) {
    const earlier = Number(/(\d+) tool calls done/.exec(lastUser)?.[1] ?? 0);
    const calls = lastUser.split('[called ').length - 1;
    send({ content: `Summary: a scripted task is under way, ${earlier + calls} tool calls done.` });
    return done(16);
  }
  // A script that calls the tool itself (`call artifact {…}`) isn't the keyword.
  if (/artifact/i.test(lastUser) && !/^call /m.test(lastUser) && !answeredTool && body.tools?.some((t) => t.function.name === 'artifact')) {
    send({ content: 'Here is a small page.' });
    await sleep(100);
    send({ tool_calls: [{ function: { name: 'artifact', arguments: { command: 'create', identifier: 'counter-page', type: 'html', title: 'Click counter', content: HTML_PAGE } } }] });
    return done(60);
  }
  if (/safeguards\?/i.test(lastUser)) {
    send({ content: `Content settings block: ${system.includes('<workspace_content_settings>') ? 'present' : 'absent'}.` });
    return done(8);
  }
  if (/request\?/i.test(lastUser)) {
    const ultracode = /Ultracode is (?:still )?on/.test(notes) ? 'yes' : /Ultracode is off/.test(notes) ? 'off' : 'no';
    send({ content: `think=${JSON.stringify(body.think ?? null)} ultracode=${ultracode}` });
    return done(8);
  }
  const has = /^system has (\S+)\?$/i.exec(lastUser.trim());
  if (has) {
    send({ content: `System has ${has[1]}: ${system.includes(has[1]) ? 'yes' : 'no'}.` });
    return done(8);
  }
  if (/context\?/i.test(lastUser)) {
    const instructions = /<instructions>\n([\s\S]*?)\n<\/instructions>/.exec(system)?.[1] ?? 'none';
    const documents = [...system.matchAll(/<document name="([^"]+)">/g)].map((m) => m[1]).join(', ') || 'none';
    send({ content: `Instructions: ${instructions}. Documents: ${documents}.` });
    return done(10);
  }
  const ended = /The background sub-agent "([^"]+)" (?:has finished|ended without finishing|was stopped)\.[\s\S]*?\n\n([\s\S]*?)\n<\/context-update>/.exec(notes);
  if (ended && !lastUser.trim()) {
    send({ content: `Heard back from ${ended[1]}: ${ended[2].split(/\s+/).slice(0, 6).join(' ')}.` });
    return done(10);
  }
  const scripted = [...lastUser.matchAll(/^call (\w+) (\{.*\})$/gm)];
  if (scripted.length) {
    const lastUserIndex = messages.findLastIndex((m) => m.role === 'user');
    // After a compaction the request comes back inside the summary, with the calls done so far.
    const before = Number(/(\d+) tool calls done/.exec(lastUser)?.[1] ?? 0);
    const step = before + messages.slice(lastUserIndex + 1).filter((m) => m.role === 'assistant').length;
    const next = scripted[step];
    if (next && body.tools?.some((t) => t.function.name === next[1])) {
      send({ tool_calls: [{ function: { name: next[1], arguments: JSON.parse(next[2]) } }] });
      return done(20);
    }
  }
  const search = /search for (.+)/i.exec(lastUser);
  if (search && !answeredTool && body.tools?.some((t) => t.function.name === 'WebSearch')) {
    send({ tool_calls: [{ function: { name: 'WebSearch', arguments: { query: search[1] } } }] });
    return done(20);
  }
  if (answeredTool) {
    send({ content: `Tool result: ${String(messages.at(-1).content).slice(0, 160)}` });
    return done(12);
  }
  if (/think/i.test(lastUser) && body.think) {
    for (const piece of chunks('The user wants to see reasoning. I will think briefly, then answer in one sentence.', 12)) {
      send({ thinking: piece });
      await sleep(40);
    }
  }
  const long = /\blong\b/i.test(lastUser);
  const text = /markdown/i.test(lastUser)
    ? MARKDOWN
    : /\bshellblock\b/i.test(lastUser)
      ? 'Run this:\n\n```bash\necho from-the-block\n```\n'
    : /slow/i.test(lastUser)
      ? 'Counting slowly: ' + Array.from({ length: 60 }, (_, i) => i + 1).join(', ') + '.'
      : long
        ? 'A long answer, streamed a little at a time. '.repeat(55)
        : `You said: ${lastUser.slice(0, 200)}`;
  const delay = /slow/i.test(lastUser) ? 200 : long ? 80 : 15;
  for (const piece of chunks(text, /slow/i.test(lastUser) ? 4 : long ? 24 : 6)) {
    if (res.destroyed) return;
    send({ content: piece });
    await sleep(delay);
  }
  done(Math.ceil(text.length / 4));
}

const readText = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

createServer(async (req, res) => {
  const json = (value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  if (req.url === '/api/version') return json({ version: '0.0.0-fake' });
  if (req.url === '/api/tags') return json({ models: MODELS.map((m) => ({ name: m.name, model: m.name })) });
  if (req.url === '/api/ps') return json({ models: [] });
  if (req.url === '/api/show') {
    const { model } = await readBody(req);
    const m = MODELS.find((x) => x.name === model);
    if (!m) return res.writeHead(404).end();
    return json({ capabilities: m.capabilities, model_info: { 'fake.context_length': m.ctx }, ...(m.think ? { thinking: { values: m.think } } : {}) });
  }
  if (req.url === '/api/chat' && req.method === 'POST') return chat(req, res);
  if (req.url?.startsWith('/search?')) {
    const q = new URL(req.url, 'http://x').searchParams.get('q');
    return json({ results: [{ title: `About ${q}`, url: 'https://example.com/about', content: `Everything about ${q}.` }] });
  }
  // Result pages of the built-in search engines (ATELIER_SEARCH_BASE points the backend here). A query containing
  // "blocked" gets DuckDuckGo's challenge, so the next engine has to answer; "nothing" gets no results anywhere.
  if (req.url?.startsWith('/engines/')) {
    const url = new URL(req.url, 'http://x');
    const form = req.method === 'POST' ? new URLSearchParams(await readText(req)) : url.searchParams;
    const q = form.get('q') ?? '';
    const page = (body) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body>${body}</body></html>`);
    if (url.pathname === '/engines/ddg/html/' || url.pathname === '/engines/ddg/lite/') {
      if (/blocked/.test(q)) return res.writeHead(202, { 'content-type': 'text/html' }).end('<div class="anomaly-modal__mask"></div>');
      if (/nothing/.test(q)) return page('<div id="links"></div>');
      return page(
        `<div class="result"><h2 class="result__title"><a class="result__a" href="https://example.com/about">About ${q}</a></h2><a class="result__snippet">Everything about ${q} from DuckDuckGo.</a></div>` +
          `<div class="result"><h2 class="result__title"><a class="result__a" href="https://docs.example.org/${encodeURIComponent(q)}">${q} documentation</a></h2><a class="result__snippet">The ${q} manual.</a></div>`,
      );
    }
    if (url.pathname === '/engines/brave/search') {
      if (/nothing/.test(q)) return page('<div id="results"></div>');
      return page(
        `<div class="snippet" data-type="web"><a class="l1" href="https://brave.example.net/${encodeURIComponent(q)}"><div class="title">${q} on Brave</div></a><div class="content">Brave knows ${q}.</div></div>`,
      );
    }
    return res.writeHead(404).end();
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`fake ollama on http://127.0.0.1:${port}`));
