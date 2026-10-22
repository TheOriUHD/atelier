/**
 * `pnpm eval --model <provider>/<model> [--task <name>] [--base-url <url>] [--tier full|compact] [--context <tokens>]
 * [--effort <level>] [--label <text>] [--suite core|behaviour|all] [--tools native|prompted]`: runs the eval tasks
 * against one model on a throwaway backend (same code as the app, desktop surface, the runner from runner/bin) and
 * writes a JSON and a Markdown report to packages/core/evals/reports/. `--tier`, `--context` and `--tools` become the
 * model's override (Settings › Admin › Models), `--effort` the sessions' level. The core suite (the default) checks the work;
 * `behaviour` checks conduct: planted instructions, the reply's language, refusals Atelier shouldn't add.
 *
 * The run is hermetic: HOME points at the throwaway folder, so the person's own skills, plugins, CLAUDE.md and
 * Claude Code settings on this computer neither reach the model nor change the results.
 *
 * The provider comes from the model ref: `anthropic/…` and `openai/…` read ANTHROPIC_API_KEY / OPENAI_API_KEY;
 * `ollama/…` and `llamacpp/…` use --base-url (default: their local port); `openai-compatible/…` needs
 * --base-url and reads OPENAI_COMPATIBLE_API_KEY when set. Keys are never written anywhere.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { contract, createMemoryTransportPair, createRpcClient, Effort, PromptTier, ProviderType, type PendingInteraction, type QuestionRequest, type SessionSnapshot } from '@atelier/protocol';
import { createBackend } from '../src/index.ts';
import { setUp, TASKS, type EvalTask, type Observed } from './tasks.ts';

const TASK_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_URLS: Partial<Record<ProviderType, string>> = {
  ollama: 'http://localhost:11434',
  llamacpp: 'http://localhost:8080',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};
const KEY_ENV: Partial<Record<ProviderType, string>> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', 'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY' };

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    task: { type: 'string' },
    'base-url': { type: 'string' },
    tier: { type: 'string' },
    context: { type: 'string' },
    effort: { type: 'string' },
    label: { type: 'string' },
    suite: { type: 'string' },
    tools: { type: 'string' },
  },
});
const ref = values.model;
const type = ProviderType.safeParse(ref?.slice(0, ref.indexOf('/')));
const tier = values.tier === undefined ? undefined : PromptTier.safeParse(values.tier);
const effort = values.effort === undefined ? undefined : Effort.safeParse(values.effort);
const contextLength = values.context === undefined ? undefined : Number(values.context);
const toolCalling = values.tools === undefined ? undefined : values.tools === 'native' || values.tools === 'prompted' ? values.tools : null;
if (!ref || !type.success || tier?.success === false || effort?.success === false || toolCalling === null || (contextLength !== undefined && !(contextLength > 0))) {
  console.error(
    'Usage: pnpm eval --model <provider>/<model> [--task <name>] [--base-url <url>] [--tier full|compact] [--context <tokens>] [--effort <level>] [--label <text>] [--suite core|behaviour|all] [--tools native|prompted]\nProviders: ' +
      ProviderType.options.join(', '),
  );
  process.exit(2);
}
const baseUrl = values['base-url'] ?? DEFAULT_URLS[type.data];
if (!baseUrl) {
  console.error(`--base-url is required for ${type.data}`);
  process.exit(2);
}
const keyEnv = KEY_ENV[type.data];
// The core suite by default; `--suite behaviour` or `--suite all` add the conduct checks.
const suite = values.suite ?? 'core';
const tasks = TASKS.filter((t) => (values.task ? t.name === values.task : suite === 'all' || (t.suite ?? 'core') === suite));

const root = await mkdtemp(join(tmpdir(), 'atelier-eval-'));
// Hermetic: nothing from the person's home folder (skills, plugins, CLAUDE.md, Claude Code settings) joins the run.
await mkdir(join(root, 'home'));
process.env.HOME = join(root, 'home');
const override = { ...(tier?.success ? { promptTier: tier.data } : {}), ...(contextLength ? { contextLength } : {}), ...(toolCalling ? { toolCalling } : {}) };
await writeFile(
  join(root, 'settings.json'),
  JSON.stringify({
    providers: [{ id: type.data, type: type.data, name: 'Eval', baseUrl, ...(keyEnv && process.env[keyEnv] ? { apiKey: `\${${keyEnv}}` } : {}) }],
    models: { defaults: { chat: ref, code: ref, work: ref }, ...(Object.keys(override).length > 0 ? { overrides: { [ref]: override } } : {}) },
  }),
);
const backend = await createBackend({
  surface: 'desktop',
  configDir: root,
  dataDir: join(root, 'data'),
  cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
  env: process.env,
  runnerDir: join(import.meta.dirname, '../../../runner/bin'),
  logger: { info: () => {}, error: (message, error) => console.error(message, error instanceof Error ? error.message : (error ?? '')) },
});
const [clientSide, serverSide] = createMemoryTransportPair();
backend.connect(serverSide, { client: { clientKind: 'desktop' } });
const rpc = createRpcClient(contract, clientSide);
await rpc.call('auth.setup', { username: 'eval', name: 'Eval', password: 'eval-password-1', clientKind: 'desktop' });

interface Result {
  task: string;
  pass: boolean;
  notes: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Output tokens per second of generation, averaged over the run's requests (when the provider reports it). */
  tokensPerSecond: number | null;
  seconds: number;
}

/** Answers what the run asks: permission prompts are allowed (deny rules still apply), questions get their first option. */
function answer(sessionId: string, pending: PendingInteraction): Promise<unknown> {
  if (pending.kind === 'question') {
    const { questions } = pending.payload as QuestionRequest;
    const answers = Object.fromEntries(questions.map((q) => [q.question, q.options[0]!.label]));
    return rpc.call('chat.respond', { sessionId, interactionId: pending.id, answer: { answers } });
  }
  return rpc.call('chat.respond', { sessionId, interactionId: pending.id, answer: { behavior: 'allow' } });
}

async function runTask(task: EvalTask): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), `atelier-eval-${task.name}-`));
  const started = Date.now();
  try {
    setUp(task, dir);
    await rpc.call('settings.set', { layer: 'global', path: ['permissions', 'deny'], value: task.deny ?? [] });
    await rpc.call('settings.set', { layer: 'global', path: ['mcpServers'], value: task.mcpServers ?? {} });
    const workspace = task.mode === 'chat' ? null : await rpc.call('workspaces.addLocal', { path: dir });
    const session = await rpc.call('sessions.create', {
      mode: task.mode,
      model: ref!,
      permissionMode: task.permissionMode ?? 'acceptEdits',
      ...(workspace ? { workspaceId: workspace.id } : {}),
      ...(effort?.success ? { effort: effort.data } : {}),
    });
    const asked: string[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), TASK_TIMEOUT_MS);
      let running = false;
      rpc.on('session.event', ({ sessionId, event }) => {
        if (sessionId !== session.id) return;
        if (event.type === 'pending' && event.pending) {
          asked.push(event.pending.kind);
          void answer(session.id, event.pending).catch(() => undefined);
        }
        if (event.type === 'status') {
          if (event.status === 'running') running = true;
          else if (running && (event.status === 'idle' || event.status === 'error')) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    await rpc.call('sessions.subscribe', { id: session.id });
    await rpc.call('chat.send', { sessionId: session.id, parts: [{ type: 'text', text: task.prompt }] });
    await finished;
    const snapshot: SessionSnapshot = await rpc.call('sessions.subscribe', { id: session.id });
    const assistant = snapshot.messages.filter((m) => m.role === 'assistant');
    const observed: Observed = {
      dir,
      replies: assistant.map((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('')),
      toolCalls: assistant.flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool_call' ? [{ name: p.name, input: p.input }] : []))),
      asked,
      artifacts: (await rpc.call('artifacts.list', { sessionId: session.id })).map((a) => ({ type: a.type, title: a.title })),
    };
    const errors = assistant.flatMap((m) => (m.error ? [m.error.message] : []));
    const verdict = task.check(observed);
    const timed = assistant.flatMap((m) => (m.usage?.tokensPerSecond && m.usage.output > 0 ? [{ output: m.usage.output, rate: m.usage.tokensPerSecond }] : []));
    const generated = timed.reduce((n, t) => n + t.output, 0);
    const generating = timed.reduce((s, t) => s + t.output / t.rate, 0);
    return {
      task: task.name,
      pass: verdict.pass,
      notes: [verdict.notes, ...errors].join('; '),
      turns: assistant.length,
      inputTokens: assistant.reduce((n, m) => n + (m.usage?.input ?? 0), 0),
      outputTokens: assistant.reduce((n, m) => n + (m.usage?.output ?? 0), 0),
      tokensPerSecond: generating > 0 ? Math.round((generated / generating) * 10) / 10 : null,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  } catch (error) {
    return { task: task.name, pass: false, notes: error instanceof Error ? error.message : String(error), turns: 0, inputTokens: 0, outputTokens: 0, tokensPerSecond: null, seconds: Math.round((Date.now() - started) / 100) / 10 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const results: Result[] = [];
for (const task of tasks) {
  process.stdout.write(`${task.name} … `);
  const result = await runTask(task);
  results.push(result);
  console.log(`${result.pass ? 'pass' : 'FAIL'} (${result.seconds}s) ${result.notes}`);
}
await backend.dispose();
await rm(root, { recursive: true, force: true });

const date = new Date().toISOString().slice(0, 10);
const reports = join(import.meta.dirname, 'reports');
const variant = [suite === 'core' || values.task ? '' : suite, tier?.success ? tier.data : '', contextLength ? `ctx${contextLength}` : '', effort?.success ? effort.data : '', toolCalling ?? '', values.label ?? ''].filter(Boolean);
const stem = join(reports, [date, ref.replace(/[^\w.-]+/g, '_'), ...variant.map((v) => v.replace(/[^\w.-]+/g, '_'))].join('-'));
// Runs of the same configuration on one day keep their own reports.
let base = stem;
for (let n = 2; existsSync(`${base}.json`); n++) base = `${stem}-${n}`;
const settingsLine = [tier?.success ? `tier ${tier.data}` : 'tier by model', contextLength ? `context ${contextLength}` : '', effort?.success ? `effort ${effort.data}` : '', toolCalling ? `${toolCalling} tool calls` : ''].filter(Boolean).join(', ');
await mkdir(reports, { recursive: true });
await writeFile(`${base}.json`, `${JSON.stringify({ model: ref, date, settings: { tier: tier?.success ? tier.data : null, contextLength: contextLength ?? null, effort: effort?.success ? effort.data : null, toolCalling: toolCalling ?? null, label: values.label ?? null }, results }, null, 2)}\n`);
await writeFile(
  `${base}.md`,
  [
    `# Evals: ${ref} (${date})`,
    '',
    `${settingsLine}${values.label ? ` · ${values.label}` : ''}. ${results.filter((r) => r.pass).length} of ${results.length} passed.`,
    '',
    '| task | result | turns | tokens in / out | tok/s | time | notes |',
    '|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.task} | ${r.pass ? 'pass' : '**fail**'} | ${r.turns} | ${r.inputTokens} / ${r.outputTokens} | ${r.tokensPerSecond ?? '–'} | ${r.seconds}s | ${r.notes.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
    ),
    '',
  ].join('\n'),
);
console.log(`report: ${base}.md`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
