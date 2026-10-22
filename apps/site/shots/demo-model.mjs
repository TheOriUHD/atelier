#!/usr/bin/env node
/**
 * A scripted stand-in for an Ollama server that gives the website's screenshots their content: polished replies,
 * a believable model name and speed. Same API subset as e2e/fake-ollama.mjs (the adapter only needs these routes).
 * The scene is picked from what the person typed, so the prompts on screen read naturally.
 *
 * Usage: node demo-model.mjs [port=11590] [repoDir] [workDir]   (repoDir: the folder the Code scene edits; workDir: the Cowork one)
 */
import { createServer } from 'node:http';
import { join } from 'node:path';

const port = Number(process.argv[2] ?? 11590);
const repo = process.argv[3] ?? '/tmp/timeline';
const work = process.argv[4] ?? '/tmp/q3-planning';
const MODEL = 'qwen3:30b';
const TOKENS_PER_SECOND = 58.8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = (text, size) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [];

const SERVER_FILE = join(repo, 'src/server.js');
const TEST_FILE = join(repo, 'src/server.test.js');
const TEST_SOURCE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from './server.js';

function get(url) {
  let body = '';
  const res = { writeHead() { return this; }, end(chunk) { body += chunk ?? ''; } };
  handler({ url }, res);
  return body;
}

test('/health reports status and uptime', () => {
  const health = JSON.parse(get('/health'));
  assert.equal(health.status, 'ok');
  assert.equal(typeof health.uptime, 'number');
});
`;

const PALETTE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --accent: #C6613F; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #FBF8F2; color: #2B2723; font: 14px/1.4 system-ui, sans-serif; }
  main { width: min(640px, 92vw); }
  h1 { margin: 0 0 4px; font: 700 26px/1.2 Georgia, 'Source Serif 4', serif; }
  p { margin: 0 0 20px; color: #5a5249; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  button { all: unset; cursor: pointer; border: 1px solid #e6dfd2; border-radius: 10px; overflow: hidden; background: #fff; }
  button:focus-visible, button[aria-pressed=true] { outline: 2px solid var(--accent); outline-offset: 2px; }
  .sw { height: 64px; }
  .t { padding: 8px 10px 10px; }
  .t b { display: block; font-size: 12px; }
  .t span { font: 11px ui-monospace, monospace; color: #6b6258; }
</style></head><body><main>
  <h1>Warm studio palette</h1>
  <p>Click a swatch to mark it as your accent.</p>
  <div class="grid" id="g"></div>
</main><script>
  const colors = [['Clay','#C6613F'],['Terracotta','#DE8463'],['Sand','#E9DCC7'],['Cream','#FBF8F2'],['Olive','#7A8450'],['Sage','#A9B493'],['Dusk','#4A5A6A'],['Ink','#2B2723']];
  const g = document.getElementById('g');
  for (const [name, hex] of colors) {
    const b = document.createElement('button');
    b.innerHTML = '<div class="sw" style="background:' + hex + '"></div><div class="t"><b>' + name + '</b><span>' + hex + '</span></div>';
    b.onclick = () => { document.documentElement.style.setProperty('--accent', hex); g.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); };
    g.append(b);
  }
</script></body></html>`;

const BRIEF = `# Q3 brief

Revenue grew 12% to $9.5M, led by EMEA (+19%).

## What moved
- **EMEA**: +19% on three new enterprise contracts.
- **Americas**: +10%, steady.
- **APAC**: +6%, flat in practice.

## Risks
- Two enterprise accounts churned in September over pricing.

## Decisions for Q4
1. Revisit enterprise pricing before the renewals.
2. Hire two engineers for the mobile launch.
3. Keep support staffing as it is while the backlog is down.
`;

const todos = (...status) => ({
  todos: [
    { content: 'Read the notes', status: status[0], activeForm: 'Reading the notes' },
    { content: 'Compare revenue by region', status: status[1], activeForm: 'Comparing revenue by region' },
    { content: 'Write the brief', status: status[2], activeForm: 'Writing the brief' },
  ],
});

const BTREE = `Both keep keys sorted for fast lookup, but they make opposite trade-offs between **reads** and **writes**.

| | B-tree | LSM-tree |
| --- | --- | --- |
| Write path | Updates pages in place | Appends to a log, merges later |
| Read path | One walk down the tree | Checks the memtable and several levels |
| Background work | Page splits and rebalancing | Compaction rewrites sorted runs |
| Range scans | Excellent, keys are adjacent | Good once compacted |
| Typical homes | PostgreSQL, MySQL (InnoDB) | RocksDB, Cassandra, LevelDB |

**Rule of thumb:** a read-heavy workload with lots of range scans fits a B-tree; a write-heavy, append-like workload fits an LSM-tree.

Want me to walk through how a point lookup works in each?`;

const CODE_DONE = `Done: \`/health\` now reports uptime, and a test covers it.

- \`src/server.js\`: the response includes \`uptime\`, in whole seconds since the process started.
- \`src/server.test.js\`: a new test that checks \`status\` and that \`uptime\` is a number.

\`node --test\` passes: 1 test, 0 failures. The changes are in the Diff pane if you want to review them.`;

/** Each scene: a pattern on the person's message, a chat title, and the steps (say = text to stream, tool = a call). */
const SCENES = [
  {
    match: /uptime/i,
    title: 'Add uptime to /health',
    steps: [
      { tool: 'Read', args: { file_path: SERVER_FILE } },
      {
        tool: 'Edit',
        args: {
          file_path: SERVER_FILE,
          old_string: "res.end(JSON.stringify({ status: 'ok' }));",
          new_string: "res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()) }));",
        },
      },
      { tool: 'Write', args: { file_path: TEST_FILE, content: TEST_SOURCE } },
      { tool: 'Bash', args: { command: 'node --test', description: 'Run the tests' } },
      { say: CODE_DONE },
    ],
  },
  {
    match: /commit/i,
    title: 'Add uptime to /health',
    steps: [
      {
        tool: 'Bash',
        args: { command: 'git add -A && git commit -m "Report uptime from /health"', description: 'Commit the change' },
      },
      { say: 'Committed: "Report uptime from /health".' },
    ],
  },
  {
    match: /quarter/i,
    title: 'Q3 brief for the team',
    steps: [
      { tool: 'TodoWrite', args: todos('in_progress', 'pending', 'pending') },
      { tool: 'Read', args: { file_path: join(work, 'notes.md') } },
      { tool: 'Read', args: { file_path: join(work, 'revenue.csv') } },
      { tool: 'TodoWrite', args: todos('completed', 'completed', 'in_progress') },
      { tool: 'Write', args: { file_path: join(work, 'brief.md'), content: BRIEF } },
      { tool: 'TodoWrite', args: todos('completed', 'completed', 'completed') },
      {
        say: 'Done. I read the planning notes and the revenue table and wrote a one-page brief for the team.\n\n- `brief.md`: the quarter in a line, what moved by region, the main risk and three decisions for Q4.\n\nRevenue grew 12% quarter over quarter, led by EMEA. The notes flag two enterprise accounts that churned over pricing as the main risk.',
      },
    ],
  },
  { match: /b-tree/i, title: 'B-tree vs LSM-tree', steps: [{ say: BTREE }] },
  {
    match: /palette/i,
    title: 'Warm studio palette',
    steps: [
      {
        say: 'Let me put together a small page.',
        tool: 'artifact',
        args: {
          command: 'create',
          identifier: 'warm-studio-palette',
          type: 'html',
          title: 'Warm studio palette',
          content: PALETTE_PAGE,
        },
      },
      { say: 'Here is the palette as a small page. Click a swatch to pick your accent.' },
    ],
  },
  {
    match: /cron/i,
    title: 'Cron schedule for backups',
    steps: [
      {
        say: 'Use a crontab entry. For a nightly backup at 02:30:\n\n```\n30 2 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1\n```\n\nThe five fields are minute, hour, day of month, month and day of week. Redirect the output so a failed run leaves a trace you can read.',
      },
    ],
  },
  {
    match: /email/i,
    title: 'Validating email addresses',
    steps: [
      {
        say: 'Keep the check loose and let a confirmation message do the real validation. A pattern like `^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$` catches typos without rejecting valid but unusual addresses. Send a link to the address and treat a click as proof it works.',
      },
    ],
  },
  {
    match: /rate.?limit/i,
    title: 'Rate limiting a public API',
    steps: [
      {
        say: 'A token bucket per API key is the usual choice: each key refills at a steady rate and can burst up to the bucket size. Return `429` with a `Retry-After` header when it is empty, and keep the counters in Redis so every instance sees the same numbers.',
      },
    ],
  },
];

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });

async function chat(req, res) {
  const body = await readBody(req);
  const messages = body.messages ?? [];
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const latest = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  // The notes Atelier puts in front of a message aren't the person's words.
  const notes = /^(?:<context-update>[\s\S]*?<\/context-update>\s*)*/.exec(latest)[0];
  const typed = latest.slice(notes.length);
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const send = (message) =>
    res.write(
      JSON.stringify({
        model: body.model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: '', ...message },
        done: false,
      }) + '\n',
    );
  const done = (count) =>
    res.end(
      JSON.stringify({
        model: body.model,
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: Math.ceil(JSON.stringify(messages).length / 4),
        eval_count: count,
        eval_duration: Math.round((count / TOKENS_PER_SECOND) * 1e9),
        total_duration: Math.round((count / TOKENS_PER_SECOND) * 1.2e9),
      }) + '\n',
    );

  const scene = SCENES.find((s) => s.match.test(typed)) ?? SCENES.find((s) => s.match.test(latest));
  if (/short title/i.test(system)) {
    send({ content: SCENES.find((s) => s.match.test(latest))?.title ?? 'New chat' });
    return done(5);
  }
  if (!scene) {
    send({ content: 'Tell me a little more about what you need.' });
    return done(10);
  }
  // Which step of the scene this request is: one per assistant turn since the person's message.
  const lastUserIndex = messages.findLastIndex((m) => m.role === 'user');
  const step =
    scene.steps[messages.slice(lastUserIndex + 1).filter((m) => m.role === 'assistant').length] ?? scene.steps.at(-1);
  if (step.say) {
    for (const piece of chunks(step.say, 6)) {
      if (res.destroyed) return;
      send({ content: piece });
      await sleep(8);
    }
    if (step.tool) await sleep(120);
  }
  if (step.tool) send({ tool_calls: [{ function: { name: step.tool, arguments: step.args } }] });
  done(Math.ceil((step.say?.length ?? 0) / 4) + (step.tool ? 40 : 0));
}

createServer(async (req, res) => {
  const json = (value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  if (req.url === '/api/version') return json({ version: '0.12.0' });
  if (req.url === '/api/tags') return json({ models: [{ name: MODEL, model: MODEL }] });
  if (req.url === '/api/ps') return json({ models: [] });
  if (req.url === '/api/show')
    return json({ capabilities: ['completion', 'tools'], model_info: { 'qwen3moe.context_length': 262144 } });
  if (req.url === '/api/chat' && req.method === 'POST') return chat(req, res);
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => console.log(`demo model on http://127.0.0.1:${port}`));
