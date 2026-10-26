/**
 * Test harness: assembles the request a session would send, through the real ChatService with fixed inputs (date
 * 2026-01-15 in Europe/Berlin, fake models, a fixed folder and instruction file), so tests see exactly what a model
 * gets: system blocks, the tools JSON and the notes on the first message.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSettings,
  defaultUserPrefs,
  type ModelInfo,
  type Mode,
  type PermissionMode,
  type PromptTier,
  type SafeguardsOverride,
  type SafeguardsSettings,
  type UserPrefs,
} from '@atelier/protocol';
import { ChatService } from '../../agent/chat-service.ts';
import { ArtifactRepo } from '../../artifacts/artifact-repo.ts';
import { FileRepo } from '../../files/file-repo.ts';
import { ProjectRepo } from '../../projects/project-repo.ts';
import { promptedRequest } from '../../providers/prompted-tools.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent, SystemBlock, ToolDef } from '../../providers/types.ts';
import { SessionRepo } from '../../sessions/session-repo.ts';
import { BlobStore } from '../../store/blobs.ts';
import { openDatabase } from '../../store/db.ts';
import { users } from '../../store/schema.ts';
import { MemoryService } from '../../memory/memory-service.ts';
import type { Tool } from '../../tools/types.ts';
import type { Workspace } from '../../workspaces/workspace.ts';
import type { Overrides } from '../templates.ts';

export interface PromptCase {
  mode: Mode;
  tier?: PromptTier;
  /** Compact tier: tools called through `<tool_call>` text. */
  prompted?: boolean;
  /** The model has effort levels (default: full tier yes, compact no). */
  effort?: boolean;
  webSearch?: boolean;
  webFetch?: boolean;
  /** One installed skill (default on), or this many with long descriptions. */
  skills?: boolean | number;
  /** Connectors with long tool descriptions, 20 tools each unless `connectorTools` says otherwise. */
  connectors?: number;
  connectorTools?: number;
  /** The project's AGENTS.md, in place of the two-line default. */
  agentsMd?: string;
  /** Started with no folder: a scratch folder without a repository or instruction files. */
  scratch?: boolean;
  /** Chat: the conversation can have a sandbox (Bash and Read). */
  sandbox?: boolean;
  project?: boolean;
  personalization?: {
    name?: string;
    style?: UserPrefs['personalization']['responseStyle'];
    instructions?: string;
    personality?: UserPrefs['personalization']['personality'];
  };
  /** A general-purpose sub-agent, or a defined one with its own prompt (whose frontmatter lists Agent). */
  subagent?: 'general-purpose' | 'defined';
  permissionMode?: PermissionMode;
  /** The administrator's instructions for every conversation. */
  organization?: string;
  safeguards?: { system?: Partial<SafeguardsSettings>; person?: SafeguardsOverride };
  overrides?: Overrides;
  /** The person has memory (Settings › Memory) with a few entries; `entries` sets how many topics besides. */
  memory?: { entries?: number; searchChats?: boolean; generate?: boolean };
  /** Computer use is on in the desktop app running the session. */
  computer?: boolean;
}

export interface Assembled {
  system: SystemBlock[];
  tools: ToolDef[];
  /** The context notes on the person's first message, as the model reads them. */
  notes: string[];
}

const FULL: ModelInfo = {
  ref: 'anthropic/claude-sonnet-5-5',
  providerId: 'anthropic',
  modelId: 'claude-sonnet-5-5',
  displayName: 'Claude Sonnet 5.5',
  contextLength: 200_000,
  maxOutput: 32_000,
  capabilities: { tools: 'native', vision: true, pdf: true, reasoning: 'effort', caching: true },
  effortLevels: ['low', 'medium', 'high'],
  tier: 'full',
  source: 'catalog',
  hidden: false,
  favorite: false,
  order: 0,
};

const COMPACT: ModelInfo = {
  ...FULL,
  ref: 'ollama/qwen3:8b',
  providerId: 'ollama',
  modelId: 'qwen3:8b',
  displayName: 'Qwen3 8B',
  contextLength: 32_768,
  maxOutput: 8_192,
  capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'none', caching: false },
  tier: 'compact',
  source: 'detected',
};

/** The model for a case; `ref` and `name` let a test vary the model within a tier. */
export function modelFor(c: PromptCase, variant?: { ref: string; name: string }): ModelInfo {
  const base = c.tier === 'compact' ? COMPACT : FULL;
  const effort = c.effort ?? base.tier === 'full';
  return {
    ...base,
    ...(variant
      ? { ref: variant.ref, modelId: variant.ref.slice(variant.ref.indexOf('/') + 1), displayName: variant.name }
      : {}),
    capabilities: {
      ...base.capabilities,
      tools: c.prompted ? 'prompted' : 'native',
      reasoning: effort ? 'effort' : 'none',
    },
  };
}

const ROOT = '/work/shop';
const SCRATCH = '/home/ada/.atelier/data/scratch-workspaces/u1/scratch-2026-01-15-3fa9c2';

const workspace: Workspace = {
  id: 'w1',
  deviceId: null,
  host: null,
  root: ROOT,
  home: '/home/ada',
  os: 'darwin',
  shell: 'zsh',
  pathSep: '/',
  runner: {
    call: async () => Promise.reject(new Error('no runner in prompt tests')),
    on: () => () => {},
  } as unknown as Workspace['runner'],
  shellFor: async () => 's1',
};

const skill = {
  name: 'pdf',
  description: 'Fill in, merge and extract text from PDF files.',
  dir: '/skills/pdf',
  path: '/skills/pdf/SKILL.md',
  scope: 'global' as const,
  location: 'host' as const,
  disableModelInvocation: false,
  userInvocable: true,
  warnings: [],
};
const reviewer = {
  name: 'reviewer',
  description: 'Reviews a diff for bugs.',
  tools: ['Read', 'Grep', 'Agent'],
  disallowedTools: [],
  model: null,
  maxTurns: null,
  path: '/agents/reviewer.md',
  scope: 'global' as const,
  location: 'host' as const,
};

/** Skills whose descriptions fill most of what the skill list may hold. */
function manySkills(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ...skill,
    name: `report-${i + 1}`,
    description: `Builds report ${i + 1} from the tracker's records: ${'grouping, totals, charts and a short written summary for each team, '.repeat(3)}`,
  }));
}

function connectorTools(count: number, tools = 20): Tool[] {
  return Array.from({ length: count }, (_, s) =>
    Array.from({ length: tools }, (_, t): Tool => ({
      name: `mcp__tracker${s + 1}__action_${String(t + 1).padStart(2, '0')}`,
      description: `Runs action ${t + 1} of tracker ${s + 1} over its records, with filters, pagination and sorting, and returns every field the tracker stores for each match. ${'Filters combine with and, pages hold up to a hundred records, and sorting takes any stored field in either direction. '.repeat(3)}`,
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for.' } } },
      readOnly: true,
      run: async () => ({ content: [] }),
    })),
  ).flat();
}

/** Answers every request with "ok" and records the requests that aren't titles. */
function recorder(seen: ChatRequest[], prompted: boolean): ProviderAdapter {
  return {
    type: 'openai-compatible',
    listModels: async () => [],
    health: async () => ({ ok: true, latencyMs: 1, warnings: [] }),
    async *stream(req): AsyncIterable<StreamEvent> {
      if (!req.system.some((b) => b.text.includes('short title')))
        seen.push(prompted ? { ...req, ...promptedRequest(req) } : req);
      yield { type: 'text', delta: 'ok' };
      yield { type: 'finish', reason: 'end' };
    },
  };
}

/** Builds the case's session, sends one message and returns the request it made. */
export async function assemble(c: PromptCase, model = modelFor(c)): Promise<Assembled> {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-prompts-'));
  const db = openDatabase(':memory:');
  try {
    const repo = new SessionRepo(db);
    const blobs = new BlobStore(db, join(dir, 'blobs'));
    const seen: ChatRequest[] = [];
    const settings = defaultSettings();
    settings.providers = [
      {
        id: 'anthropic',
        type: 'anthropic',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        headers: {},
        enabled: true,
      },
      { id: 'ollama', type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', headers: {}, enabled: true },
    ];
    settings.capabilities.webSearch.enabled = c.webSearch ?? true;
    settings.capabilities.webFetch = c.webFetch ?? true;
    settings.safeguards = { ...settings.safeguards, ...c.safeguards?.system };
    settings.prompts.organizationInstructions = c.organization ?? '';
    const prefs = defaultUserPrefs();
    prefs.callMe = c.personalization?.name ?? '';
    prefs.personalization = {
      ...prefs.personalization,
      instructions: c.personalization?.instructions ?? '',
      responseStyle: c.personalization?.style ?? 'default',
      personality: c.personalization?.personality ?? prefs.personalization.personality,
      atelierMd: '',
    };
    const projects = new ProjectRepo(db);
    if (c.memory)
      prefs.memory = {
        searchChats: c.memory.searchChats ?? true,
        generate: c.memory.generate ?? true,
        sensitive: false,
      };
    const memory = c.memory
      ? await seededMemory(
          db,
          repo,
          prefs,
          c.memory.entries ?? 3,
          () => settings,
          () => ({ adapter: recorder(seen, !!c.prompted), info: model }),
        )
      : null;
    const chat = new ChatService({
      ...(memory ? { memory } : {}),
      repo,
      artifacts: new ArtifactRepo(db),
      files: new FileRepo(db, blobs),
      projects,
      blobs,
      settings: () => settings,
      models: {
        resolve: async () => ({ adapter: recorder(seen, !!c.prompted), info: model }),
        firstAvailable: async () => model.ref,
      },
      // A hosted API (the full tier's test model) has a cost to report; a local model has not.
      usage: { offered: (ref) => ref.startsWith('anthropic/'), report: async () => null },
      promptOverrides: () => c.overrides ?? {},
      sessionEvent: () => {},
      sessionChanged: () => {},
      recordUsage: () => {},
      person: async () => ({ prefs, name: '', safeguards: c.safeguards?.person ?? 'inherit' }),
      extensions: async () => ({
        skills: c.skills === false ? [] : typeof c.skills === 'number' ? manySkills(c.skills) : [skill],
        commands: [],
        agents: c.subagent === 'defined' ? [reviewer] : [],
        read: async (item) =>
          item.name === 'reviewer'
            ? '---\nname: reviewer\n---\nYou review diffs. Report each problem as path:line with a one-line reason.'
            : 'Use the pdf scripts.',
        projectDir: c.mode === 'chat' ? '' : ROOT,
      }),
      mcpTools: async () => connectorTools(c.connectors ?? 0, c.connectorTools),
      workspace: async (s) => (s.mode === 'chat' ? null : workspace),
      chatSandboxAvailable: () => c.sandbox === true,
      ...(c.computer
        ? {
            computer: {
              available: async () => true,
              call: async () => {
                throw new Error('Not in a prompt snapshot.');
              },
            },
          }
        : {}),
      chatSandbox: async () => workspace,
      codeContext: async () =>
        c.scratch
          ? {
              workspace: {
                kind: "a folder on the person's computer",
                scratch: true,
                root: SCRATCH,
                additionalDirectories: [],
                git: false,
                platform: 'darwin',
                shell: 'zsh',
              },
              instructions: [],
            }
          : {
              workspace: {
                kind: "a folder on the person's computer",
                scratch: false,
                root: ROOT,
                additionalDirectories: [],
                git: true,
                platform: 'darwin',
                shell: 'zsh',
              },
              instructions: [
                {
                  path: `${ROOT}/AGENTS.md`,
                  kind: 'project',
                  content: c.agentsMd ?? 'Use pnpm for every script. Run `pnpm test` before you report a change.',
                },
              ],
            },
      gitSnapshot: async () =>
        c.scratch
          ? null
          : {
              branch: 'feature/cart',
              defaultBranch: 'main',
              changed: 2,
              subjects: ['Add the cart page', 'Fix rounding in totals'],
            },
      fetch: async () => new Response('offline', { status: 503 }),
      resolveRefs: async (v) => v,
      now: () => new Date('2026-01-15T09:30:00Z'),
      timeZone: 'Europe/Berlin',
    });
    const project = c.project ? await projects.create({ name: 'Garden club', description: '' }) : null;
    if (project) await projects.update(project.id, { instructions: 'Answer as the club secretary would.' });
    const session = await repo.create({
      mode: c.mode,
      model: model.ref,
      title: 'Fix the cart totals',
      ...(memory ? { userId: 'u1' } : {}),
      ...(project ? { projectId: project.id } : {}),
      ...(c.mode === 'chat' ? {} : { workspaceId: workspace.id, permissionMode: c.permissionMode ?? 'default' }),
    });
    const target = c.subagent
      ? await repo.create({
          mode: c.mode,
          model: model.ref,
          workspaceId: workspace.id,
          permissionMode: 'default',
          parentSessionId: session.id,
          title: 'Find the rounding bug',
          ...(c.subagent === 'defined' ? { overrides: { agent: 'reviewer' } } : {}),
        })
      : session;
    await chat.send(target.id, [{ type: 'text', text: 'Hello' }]);
    await chat.settle(target.id);
    const request = seen[0]!;
    const first = request.messages.find((m) => m.role === 'user')!;
    return {
      // Session ids are random; the snapshot keeps where one appears.
      system: request.system.map((b) => ({ ...b, text: b.text.replaceAll(target.id, '<session-id>') })),
      tools: request.tools ?? [],
      notes: first.parts.flatMap((p) => (p.type === 'text' && p.text.startsWith('<context-update>') ? [p.text] : [])),
    };
  } finally {
    db.$client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A person (u1) with Preferences, Profile and `topics` topic entries, behind a memory service that never calls a model. */
async function seededMemory(
  db: ReturnType<typeof openDatabase>,
  repo: SessionRepo,
  prefs: UserPrefs,
  topics: number,
  settings: () => ReturnType<typeof defaultSettings>,
  resolved: () => { adapter: ProviderAdapter; info: ModelInfo },
) {
  await db
    .insert(users)
    .values({ id: 'u1', username: 'ada', name: 'Ada', role: 'admin', passwordHash: '', createdAt: 0, updatedAt: 0 });
  const service = new MemoryService({
    db,
    sessions: repo,
    prefs: async () => prefs,
    name: async () => 'Ada',
    models: { resolve: async () => resolved(), firstAvailable: async () => resolved().info.ref },
    settings,
    promptOverrides: () => ({}),
    changed: () => {},
    now: () => Date.parse('2026-01-10T12:00:00Z'),
    newId: (() => {
      let n = 0;
      return () => `mem-${String(++n).padStart(2, '0')}`;
    })(),
  });
  await service.repo.create('u1', {
    section: 'preferences',
    title: '',
    summary: 'How Ada wants Atelier to respond',
    details: '- Prefers short answers with metric units\n- Writes in British English',
    source: 'settings',
  });
  await service.repo.create('u1', {
    section: 'profile',
    title: '',
    summary: 'Who Ada is',
    details: '- Teaches chemistry at a secondary school in Leeds\n- Has a dog called Beans',
    source: 'settings',
  });
  for (let i = 0; i < topics; i++)
    await service.repo.create('u1', {
      section: 'topic',
      title: `Topic ${i + 1}`,
      summary: `What Ada said about topic ${i + 1}, in one line`,
      details: '- A fact',
      source: 'chat',
    });
  return service;
}

const ALL_CATEGORIES = {
  enabled: true,
  categories: { sexual: true, hate: true, harassment: true, selfHarm: true },
  profile: 'younger' as const,
  crisisResources: 'the 24-hour helpline at 0800 111 0 111',
};

/** The snapshot matrix (docs/PROMPTS.md §10); the neutrality and originality checks read the same cases. */
export const CASES: Record<string, PromptCase> = {
  'chat.full': { mode: 'chat' },
  'chat.full.no-web': { mode: 'chat', webSearch: false, webFetch: false },
  'chat.full.project': { mode: 'chat', project: true },
  'chat.full.organization': {
    mode: 'chat',
    organization: 'Our company is Acme Gardens. Answer in British English and give prices in pounds.',
  },
  'chat.full.personality-technical': {
    mode: 'chat',
    personalization: { personality: { selected: 'technical', customModes: [] } },
  },
  'code.compact.personality-relaxed': {
    mode: 'code',
    tier: 'compact',
    personalization: { personality: { selected: 'relaxed', customModes: [] } },
  },
  'work.full.personality-custom': {
    mode: 'work',
    personalization: {
      style: 'concise',
      personality: {
        selected: 'custom:tutor',
        customModes: [
          { id: 'tutor', name: 'Patient tutor', instructions: 'Ask one guiding question at a time. No emoji.' },
        ],
      },
    },
  },
  'chat.full.personalization': {
    mode: 'chat',
    personalization: { name: 'Ada', style: 'concise', instructions: 'I teach chemistry. Use metric units.' },
  },
  'chat.compact': { mode: 'chat', tier: 'compact' },
  'chat.compact.prompted': { mode: 'chat', tier: 'compact', prompted: true, webSearch: false },
  'chat.full.sandbox': { mode: 'chat', sandbox: true },
  'chat.compact.sandbox': { mode: 'chat', tier: 'compact', sandbox: true },
  'chat.full.memory': { mode: 'chat', memory: {} },
  'chat.full.memory-explicit': { mode: 'chat', memory: { generate: false, searchChats: false } },
  'chat.compact.memory': { mode: 'chat', tier: 'compact', memory: { entries: 30 } },
  'work.full': { mode: 'work' },
  'work.full.no-web': { mode: 'work', webSearch: false, webFetch: false, skills: false },
  'work.compact': { mode: 'work', tier: 'compact' },
  'work.full.memory': { mode: 'work', memory: {} },
  'work.full.computer': { mode: 'work', computer: true },
  'code.compact.computer': { mode: 'code', tier: 'compact', computer: true },
  'code.full': { mode: 'code' },
  'code.full.plan': { mode: 'code', permissionMode: 'plan' },
  'code.full.scratch': { mode: 'code', scratch: true },
  'code.full.no-effort': { mode: 'code', effort: false, webSearch: false },
  'code.full.subagent': { mode: 'code', subagent: 'general-purpose' },
  'code.full.defined-agent': { mode: 'code', subagent: 'defined' },
  'code.compact': { mode: 'code', tier: 'compact' },
  'code.compact.prompted': { mode: 'code', tier: 'compact', prompted: true },
  'code.compact.connectors': { mode: 'code', tier: 'compact', connectors: 3 },
  'code.compact.budget': {
    mode: 'code',
    tier: 'compact',
    webSearch: false,
    webFetch: false,
    skills: 12,
    connectors: 1,
    connectorTools: 7,
    agentsMd: Array.from(
      { length: 60 },
      (_, i) => `- Rule ${i + 1}: keep the shop's cart totals in cents and round only when showing them to people.`,
    ).join('\n'),
  },
  'safeguards.chat.full': { mode: 'chat', safeguards: { system: { enabled: true } } },
  'safeguards.chat.compact': { mode: 'chat', tier: 'compact', safeguards: { system: { enabled: true } } },
  'safeguards.code.full.all': { mode: 'code', safeguards: { system: ALL_CATEGORIES } },
  'safeguards.code.compact.all': { mode: 'code', tier: 'compact', safeguards: { system: ALL_CATEGORIES } },
  'safeguards.work.full.person-on': { mode: 'work', safeguards: { person: 'on' } },
  'safeguards.work.compact': { mode: 'work', tier: 'compact', safeguards: { system: { enabled: true } } },
  'safeguards.code.full.subagent': {
    mode: 'code',
    subagent: 'general-purpose',
    safeguards: {
      system: { enabled: true, categories: { sexual: false, hate: true, harassment: false, selfHarm: false } },
    },
  },
};

/** A case as reviewable text: each system block, the notes and the tools JSON, with sizes. */
export function describeCase(a: Assembled): string {
  const chars = a.system.reduce((n, b) => n + b.text.length, 0);
  const tools = JSON.stringify(a.tools, null, 2);
  return [
    `# System prompt: ${a.system.length} blocks, ${chars} characters`,
    ...a.system.map((b, i) => `\n## Block ${i + 1}${b.cache ? ' (cache breakpoint)' : ''}\n\n${b.text}`),
    `\n# Notes on the first message: ${a.notes.length}`,
    ...a.notes.map((n) => `\n${n}`),
    `\n# Tools: ${a.tools.length}, ${JSON.stringify(a.tools).length} characters of JSON\n`,
    tools,
    '',
  ].join('\n');
}
