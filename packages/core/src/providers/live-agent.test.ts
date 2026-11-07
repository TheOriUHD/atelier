/**
 * A real Code turn through Mistral, as people run it: a desktop backend, a Mistral provider with the key from
 * `.env.local` (the main checkout's, from a worktree too), a Code session in a scratch folder in Bypass, a prompt, and an
 * outline of what happened (each reply's parts, stop reason, error and usage, what each request asked for, the files).
 * Only on request, as it spends real tokens:
 *   LIVE_AGENT=1 LIVE_AGENT_TYPE=mistral-vibe LIVE_AGENT_MODEL=zai-glm-5-3-flash LIVE_AGENT_EFFORT=medium \
 *     npx vitest run packages/core/src/providers/live-agent.test.ts --disable-console-intercept
 * LIVE_AGENT_PROMPT replaces the prompt; LIVE_AGENT_FOLLOWUP sends more messages after it, separated by `||`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { contract, createMemoryTransportPair, createRpcClient, type Message, type RunEvent } from '@atelier/protocol';
import { createBackend } from '../backend/backend.ts';

function envFile(): Record<string, string> {
  let file = join(import.meta.dirname, '../../../../.env.local');
  if (!existsSync(file)) {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
    file = join(dirname(common), '.env.local');
  }
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2')]),
  );
}

const type = (process.env.LIVE_AGENT_TYPE ?? 'mistral-vibe') as 'mistral' | 'mistral-vibe';
const model = process.env.LIVE_AGENT_MODEL ?? 'zai-glm-5-3-flash';
const effort = (process.env.LIVE_AGENT_EFFORT ?? 'medium') as 'low' | 'medium' | 'high';
const prompt = process.env.LIVE_AGENT_PROMPT ?? 'create a simple minecraft shader. i want shadows based on sun position and wavy, animated water.';
const key = envFile()[type === 'mistral' ? 'MISTRAL_API_KEY' : 'MISTRAL_VIBE_API_KEY'];
const runnerDir = join(import.meta.dirname, '../../../../runner/bin');

it.skipIf(!key || !process.env.LIVE_AGENT)(`a Code turn through ${type} ${model} (${effort})`, { timeout: 15 * 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'atelier-live-agent-'));
  const logs: string[] = [];
  const asked: string[] = [];
  const backend = await createBackend({
    surface: 'desktop',
    configDir: home,
    dataDir: join(home, 'data'),
    runnerDir: existsSync(runnerDir) ? runnerDir : join(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(), '../runner/bin'),
    cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
    env: { ATELIER_COOP_RELAY: '' },
    logger: { info: (m) => logs.push(`info ${m}`), error: (m, e) => logs.push(`error ${m} ${e instanceof Error ? e.message : String(e ?? '')}`) },
    // What each reply request asked for (never the key): its output limit and effort.
    fetch: async (url, init) => {
      if (String(url).endsWith('/v1/chat/completions') && typeof init?.body === 'string') {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        asked.push(`max_tokens=${String(body.max_tokens)} effort=${String(body.reasoning_effort ?? '-')} messages=${(body.messages as unknown[]).length}`);
      }
      return fetch(url, init);
    },
  });
  const started = Date.now();
  try {
    const [clientSide, serverSide] = createMemoryTransportPair();
    backend.connect(serverSide, { client: { clientKind: 'desktop', ip: '127.0.0.1', userAgent: 'live-agent' } });
    const c = createRpcClient(contract, clientSide);
    await c.call('auth.setup', { username: 'tester', name: 'Tester', password: 'correct horse battery', clientKind: 'desktop' });
    await c.call('providers.save', { id: 'mv', type, name: 'Mistral', baseUrl: 'https://api.mistral.ai', apiKey: key!, headers: {}, enabled: true } as never);
    const session = await c.call('sessions.create', { mode: 'code', scratch: {}, model: `mv/${model}`, effort, permissionMode: 'bypassPermissions' } as never);
    const events: RunEvent[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    let running = false;
    c.on('session.event', ({ sessionId, event }) => {
      if (sessionId !== session.id) return;
      events.push(event);
      if (event.type === 'status') {
        if (event.status === 'running') running = true;
        else if (running && event.status !== 'waiting') done();
      }
    });
    await c.call('sessions.subscribe', { id: session.id });
    await c.call('chat.send', { sessionId: session.id, parts: [{ type: 'text', text: prompt }] });
    await Promise.race([finished, new Promise((r) => setTimeout(r, 12 * 60_000))]);
    // A follow-up in the same session: the history (tool calls, their ids, thinking) goes back to Mistral.
    for (const next of (process.env.LIVE_AGENT_FOLLOWUP ?? '').split('||').filter(Boolean)) {
      running = false;
      const again = new Promise<void>((r) => (done = r));
      const sent = Date.now();
      await c.call('chat.send', { sessionId: session.id, parts: [{ type: 'text', text: next }] });
      await Promise.race([again, new Promise((r) => setTimeout(r, 12 * 60_000))]);
      console.log(`follow-up done in ${Math.round((Date.now() - sent) / 1000)} s`);
    }
    const snap = await c.call('sessions.subscribe', { id: session.id });
    const outline = (m: Message) =>
      m.parts
        .map((p) => (p.type === 'text' ? `text(${p.text.length})` : p.type === 'thinking' ? `thinking(${p.text.length})` : p.type === 'tool_call' ? `call:${p.name}` : p.type === 'tool_result' ? `result${p.isError ? '!' : ''}` : p.type))
        .join(' ');
    console.log(`\n=== ${type} ${model} effort=${effort}: ${Math.round((Date.now() - started) / 1000)} s, status ${snap.session.status}`);
    for (const m of snap.messages) {
      const usage = m.usage ? ` usage in=${m.usage.input} out=${m.usage.output}${m.usage.cacheRead ? ` cache=${m.usage.cacheRead}` : ''}` : '';
      console.log(`${m.role.padEnd(9)} ${m.kind !== 'normal' ? `[${m.kind}] ` : ''}${outline(m)}${m.stopReason ? ` stop=${m.stopReason}` : ''}${m.error ? ` ERROR ${m.error.code}: ${m.error.message}` : ''}${usage}`);
    }
    const kinds = new Map<string, number>();
    for (const e of events) kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
    console.log('events', JSON.stringify(Object.fromEntries(kinds)));
    const errors = events.filter((e) => e.type === 'status' && e.status === 'error');
    if (errors.length) console.log('error events', JSON.stringify(errors).slice(0, 2000));
    const ws = (await c.call('workspaces.list', {})).find((w) => w.id === session.workspaceId);
    if (ws) {
      const files = await readdir(ws.root, { recursive: true }).catch(() => [] as string[]);
      const sizes = await Promise.all(files.map(async (f) => `${f} ${(await stat(join(ws.root, f)).catch(() => null))?.size ?? '?'}`));
      console.log('files', sizes.join(', ') || '(none)');
    }
    console.log('asked', [...new Set(asked.map((a) => a.replace(/ messages=\d+/, '')))].join(' | '));
    console.log('log', logs.filter((l) => !/^info (listening|ready)/.test(l)).slice(-30).join('\n    '));
    expect(snap.messages.length).toBeGreaterThan(0);
  } finally {
    await backend.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
