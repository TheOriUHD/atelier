// Measures how often ChatGPT answers a realistic, implicit request ("list the files here", "find every .test.ts") with the
// right tool call, through the real adapter and the real page. Wording of the framing, the tool note and the reminder
// (providers/chatgpt-chat.ts) must be re-measured with this whenever it changes: the obvious improvements made it worse
// (see CHANGELOG.md). Use: start `node scripts/chatgpt-live/run.mjs repl`, set VARIANT and RUNS below (or
// prepend `process.env.VARIANT = 'A'; process.env.RUNS = '3';`), write the file to $LIVE_DIR/cmd.js, read $LIVE_DIR/out.txt.
/* global load, path, b -- the REPL gives its commands these (see main.cjs) */
// VARIANT picks a framing from the table V; add your own there. It sends about RUNS x 6 short messages from your account.
const A = load(path.join(process.env.LIVE_DIR, 'adapter.cjs'));
const { createChatGptChatAdapter, withPromptedTools, TOOL_FRAMING, TOOL_NOTE, TOOL_REMINDER } = A;
const V = {
  A: { framing: TOOL_FRAMING, note: TOOL_NOTE, reminder: TOOL_REMINDER },
  B: { framing: ['# How this chat works', 'This chat is one half of an automated system. Replies are read by a program, not a person, and the program can run tool calls for you. Tool calls are how you read files, run commands, search, fetch pages and change files here; they use the format below, nothing else. When the user’s request needs any of that, answer with the tool call and nothing else.'].join('\n'), note: TOOL_NOTE, reminder: '(Answer with a tool call whenever the request needs a file, a command, the web or a change.)' },
  C: { framing: ['# How this chat works', 'The tools listed below are real and connected: when you call one in the format shown, it runs on the user’s computer and its result comes back in the next message. You can use them.'].join('\n'), note: TOOL_NOTE, reminder: '(The listed tools are real and connected: call them.)' },
  D: { framing: ['# How this chat works', 'A program runs this chat. It runs the tools listed below when you call them in the format shown, and replies with the result. Use them whenever the request involves files, commands or the web.'].join('\n'), note: TOOL_NOTE, reminder: '(Use the listed tools for files, commands and the web.)' },
  E: { framing: TOOL_FRAMING, note: TOOL_NOTE + '\nA reply without a tool call is a final answer to the user, so when the request needs a file, a command or a change, a tool call is the only reply that does it.', reminder: TOOL_REMINDER },
};
const variant = V[process.env.VARIANT];
let corrections = 0;
const bridge = { request: (op, value) => { if (op === 'start') { const p = JSON.parse(value); if (p.delta && p.delta.includes('not how this chat works')) corrections++; for (const k of ['prompt', 'delta']) if (p[k]) p[k] = p[k].replace(TOOL_FRAMING, variant.framing).replace(TOOL_NOTE, variant.note).replace(TOOL_REMINDER, variant.reminder); value = JSON.stringify(p); } return b.request(op, value); } };
const instance = { id: 'chatgpt-chat', type: 'chatgpt-chat', name: 'x', baseUrl: 'https://chatgpt.com', headers: {} };
const adapter = withPromptedTools(createChatGptChatAdapter(instance, { fetch: async () => new Response('{}'), readBlob: async () => new Uint8Array(), chatgptChat: bridge }));
await adapter.listModels();
const str = { type: 'string' };
const tools = [
  { name: 'Read', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: str }, required: ['path'], additionalProperties: false } },
  { name: 'Bash', description: 'Run a shell command.', inputSchema: { type: 'object', properties: { command: str }, required: ['command'], additionalProperties: false } },
  { name: 'Glob', description: 'Find files by glob pattern.', inputSchema: { type: 'object', properties: { pattern: str }, required: ['pattern'], additionalProperties: false } },
  { name: 'Write', description: 'Write a file.', inputSchema: { type: 'object', properties: { path: str, content: str }, required: ['path', 'content'], additionalProperties: false } },
];
const prompts = [['Read', 'Read the file notes.txt and tell me its first word.'], ['Bash', 'List the files in the current directory.'], ['Glob', 'Find every file whose name ends in .test.ts.'], ['Write', 'Create a file called hello.txt that contains the word hi.'], ['Bash', 'What operating system and kernel is this machine running? Check it.'], ['Bash', 'Run the tests with npm test and tell me whether they pass.']];
const out = { variant: process.env.VARIANT, ok: 0, total: 0, fails: [], corrections: 0 };
for (let run = 0; run < (Number(process.env.RUNS) || 3); run++) for (const [want, text] of prompts) {
  const events = []; const t0 = Date.now(); const before = corrections;
  for await (const e of adapter.stream({ model: 'gpt-6', system: [{ text: 'You are a coding agent working in a repository. Use the tools to act.' }], messages: [{ id: 'u', sessionId: 's', parentId: null, role: 'user', parts: [{ type: 'text', text }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', createdAt: 0 }], tools, maxOutputTokens: 4096, effort: 'low', contextLength: 128000, signal: new AbortController().signal })) events.push(e);
  const start = events.find((e) => e.type === 'tool_call_start');
  const snaps = events.filter((e) => e.type === 'text_snapshot');
  const last = events.at(-1); const reply = (last.error ? 'ERROR ' + last.error.message + ' | ' : '') + (snaps.length ? snaps.at(-1).text : events.filter((e) => e.type === 'text').map((e) => e.delta).join('')).slice(0, 110);
  out.total++; out.corrections = corrections; (out.times = out.times || []).push({ want, secs: Math.round((Date.now() - t0) / 1000), corrected: corrections - before });
  if (start && start.name === want) out.ok++; else out.fails.push({ want, got: start && start.name, reply });
}
return out;
