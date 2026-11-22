/**
 * Decision models on the backend (ARCHITECTURE §28): which one to ask, asking it, and how Auto mode's quick check by it
 * compares with Auto mode's reviewer. Keys stay here; a local model waits for its turn on a GPU shared with chat models.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  DECISION_SERVICE_PRESETS,
  type DecideInput,
  type DecideResult,
  type DecisionComparison,
  type DecisionQuestion,
  type DecisionServiceConfig,
  type DecisionServiceTest,
  type DecisionState,
  type DecisionStatus,
  type ProviderConfig,
} from '@atelier/protocol';
import type { RequestScheduler, ServerLimits } from '../providers/scheduler.ts';
import type { ProviderFetch, QueuePriority } from '../providers/types.ts';
import { endpointOf, listService, listTextProvider, namableProviders, pickAutomatic, targetFor, textOffer, type DecisionOwner, type DecisionTarget } from './sources.ts';
import { errorText, openAiBody, parseDecision, systemOneBody, type DecisionDialect } from './wire.ts';

export interface DecisionDeps {
  settings(): { enabled: boolean; source?: string | undefined; services: readonly DecisionServiceConfig[]; text: readonly ProviderConfig[] };
  /** A provider's or service's key and headers, resolved. */
  credentials(owner: DecisionOwner): Promise<{ apiKey?: string | undefined; headers: Record<string, string> }>;
  fetch: ProviderFetch;
  /** The queue a text provider's requests wait in: a local GPU answers chat and decisions in turn. */
  queue?(providerId: string): { server: string; limits: () => ServerLimits } | null;
  scheduler?: RequestScheduler;
  /** Where Auto mode's comparison is kept between restarts. */
  stateFile?: string;
  /** What the backend offers changed (a model found or gone): windows are told. Not called when a new look found the same. */
  onChange?(): void;
  log?(message: string): void;
  now?(): number;
}

export class DecisionError extends Error {
  constructor(
    readonly code: 'unavailable' | 'failed' | 'forbidden',
    message: string,
  ) {
    super(message);
  }
}

/** How long a listing is kept before the providers are asked again. */
const LIST_TTL_MS = 5 * 60_000;
/** One provider's listing may take this long. */
const LIST_TIMEOUT_MS = 6_000;
/** A decision a person waits for (the Decide window, the tool): a cold local model takes seconds to load. */
const DECIDE_TIMEOUT_MS = 60_000;
/** Ollama keeps a decision model loaded this long after its last use, so the next one is quick. */
const KEEP_ALIVE = '30m';
/** A server's words for an address it doesn't have (LM Studio: "Unexpected endpoint or method"). */
const UNKNOWN_ENDPOINT = /unexpected endpoint|unknown (?:endpoint|route|path)|no route|not found|cannot post|unsupported (?:endpoint|path)/i;
/** LM Studio's words for a decision model that isn't loaded. */
const NOT_LOADED = /not loaded|no (?:decision )?model (?:is )?loaded|load (?:a|the) (?:decision )?model|requires a loaded/i;
/** Misses kept for the admin to look at. */
const MISSES_KEPT = 10;

interface Listed {
  key: string;
  at: number;
  targets: DecisionTarget[];
  problems: { provider: string; error: string }[];
}

interface Comparison extends Omit<DecisionComparison, 'medianMs'> {
  times: number[];
}

/** What a list offers, to tell a new look that found the same from one that changed something. */
const signature = (l: Listed) => JSON.stringify([l.targets.map((t) => t.source.id), l.problems]);

const presetModels = (s: DecisionServiceConfig) => DECISION_SERVICE_PRESETS.find((p) => p.key === s.preset)?.models ?? [];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class DecisionService {
  private listed: Listed | null = null;
  /** The settings or a provider changed: the list in hand is looked at again, and answers meanwhile. */
  private stale = false;
  /** Each provider's and service's models when it last answered. */
  private readonly lastGood = new Map<string, DecisionTarget[]>();
  private listing: { key: string; promise: Promise<Listed> } | null = null;
  /** What `current()` found last, for the places that can't wait (which tools a turn has). */
  private last: DecisionTarget | null = null;
  private stats: Comparison;
  private saving: ReturnType<typeof setTimeout> | undefined;
  /** The format each server answered in, for servers asked in either (`auto`). */
  private readonly formats = new Map<string, DecisionDialect>();
  /** LM Studio models this backend loaded (`root|model`). */
  private readonly loaded = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: DecisionDeps) {
    this.now = deps.now ?? Date.now;
    this.stats = this.fresh();
  }

  /** Reads the comparison kept from before a restart. */
  async load(): Promise<void> {
    if (!this.deps.stateFile) return;
    try {
      const kept = JSON.parse(await readFile(this.deps.stateFile, 'utf8')) as Partial<Comparison>;
      if (typeof kept.checked === 'number' && typeof kept.since === 'number') this.stats = { ...this.fresh(), ...kept, misses: Array.isArray(kept.misses) ? kept.misses.slice(0, MISSES_KEPT) : [], times: Array.isArray(kept.times) ? kept.times.slice(-50) : [] };
    } catch {
      // Nothing kept yet.
    }
  }

  /** The settings changed: the next look lists afresh, and the choice is made again. */
  changed(): void {
    // The list in hand keeps answering until the new one is complete, so nothing flickers away while it is made.
    this.stale = true;
    void this.sources().catch(() => undefined);
  }

  private key(): string {
    const s = this.deps.settings();
    return JSON.stringify({
      text: s.text.filter((p) => p.enabled !== false && textOffer(p)).map((p) => [p.id, p.type, p.baseUrl, p.name]),
      services: s.services.filter((x) => x.enabled !== false).map((x) => [x.id, x.type, x.baseUrl, x.models, x.name]),
    });
  }

  /**
   * Every decision model, best first: the services added for them, then the providers' in their order. A list that is
   * only due again answers at once while the new one is made behind it; a new set of providers is waited for.
   */
  async sources(refresh = false): Promise<Listed> {
    const key = this.key();
    const have = this.listed?.key === key ? this.listed : null;
    if (have && !refresh && !this.stale && this.now() - have.at < LIST_TTL_MS) return have;
    let pending = this.listing?.key === key ? this.listing.promise : null;
    if (!pending) {
      this.stale = false;
      const promise = this.list(key).finally(() => {
        if (this.listing?.promise === promise) this.listing = null;
      });
      this.listing = { key, promise };
      pending = promise;
    }
    return have && !refresh ? have : pending;
  }

  private async list(key: string): Promise<Listed> {
    const s = this.deps.settings();
    const problems: Listed['problems'] = [];
    const listDeps = { fetch: this.deps.fetch, credentials: (owner: DecisionOwner) => this.deps.credentials(owner) };
    // A provider that didn't answer this time (busy loading a model, a computer asleep) keeps what it offered last time:
    // its models don't vanish from the list, and from the windows, until it answers without them.
    const attempt = async (name: string, memory: string, run: (signal: AbortSignal) => Promise<DecisionTarget[]>) => {
      try {
        const found = await run(AbortSignal.timeout(LIST_TIMEOUT_MS));
        this.lastGood.set(memory, found);
        return found;
      } catch (error) {
        problems.push({ provider: name, error: message(error) });
        return this.lastGood.get(memory) ?? [];
      }
    };
    const services = await Promise.all(s.services.filter((x) => x.enabled !== false).map((x) => attempt(x.name, `service|${x.id}|${x.baseUrl}`, (signal) => listService(listDeps, x, signal, presetModels(x)))));
    const text = await Promise.all(s.text.filter((p) => p.enabled !== false && textOffer(p)).map((p) => attempt(p.name, `text|${p.id}|${p.baseUrl}`, (signal) => listTextProvider(listDeps, p, signal))));
    // A provider that has no decision models (an Ollama before 0.35, a chat-only server) isn't a problem; one that
    // couldn't be reached at all was already reported by the provider's own status, so only services' failures show.
    const listed: Listed = { key, at: this.now(), targets: [...services.flat(), ...text.flat()], problems: problems.filter((p) => s.services.some((x) => x.name === p.provider)) };
    if (this.key() === key) {
      const before = this.listed ? signature(this.listed) : null;
      this.listed = listed;
      if (signature(listed) !== before) {
        await this.current().catch(() => null);
        this.deps.onChange?.();
      }
    }
    return listed;
  }

  /** The decision model decisions use now: the admin's choice, else one picked by itself; null when off or none. */
  async current(): Promise<DecisionTarget | null> {
    const s = this.deps.settings();
    if (!s.enabled) return (this.last = null);
    // A choice is used as it is, without listing: a model that went away fails when asked, and says why.
    const chosen = s.source ? targetFor(s.source, s.text, s.services, this.listed?.targets) : null;
    if (chosen) return (this.last = chosen);
    return (this.last = pickAutomatic((await this.sources()).targets));
  }

  /**
   * The decision model now, without waiting on a listing that is due again (a provider that is off takes seconds to
   * fail): the one found last, while it is looked for again behind. Atelier's own uses and the tool ask through this.
   */
  private async now_(): Promise<DecisionTarget | null> {
    const s = this.deps.settings();
    if (!s.enabled) return null;
    if (s.source) return this.current();
    const fresh = this.listed?.key === this.key() && this.now() - this.listed.at < LIST_TTL_MS;
    if (fresh || !this.last) return this.current();
    void this.current().catch(() => undefined);
    return this.last;
  }

  /** What `current()` found last, without asking anything: for tool lists, which are made without waiting. */
  get ready(): DecisionTarget | null {
    const s = this.deps.settings();
    return s.enabled ? this.last : null;
  }

  async status(admin: boolean): Promise<DecisionStatus> {
    const s = this.deps.settings();
    const current = await this.current().catch(() => null);
    const listed = admin ? await this.sources().catch(() => null) : null;
    const sources = listed?.targets.map((t) => t.source) ?? [];
    // The admin's choice stays in the list even when its provider can't be reached now.
    if (admin && current && !sources.some((x) => x.id === current.source.id)) sources.unshift(current.source);
    return {
      enabled: s.enabled,
      source: current?.source ?? null,
      sources,
      chosen: admin ? (s.source ?? null) : null,
      ...(admin ? { comparison: this.comparison(), problems: listed?.problems ?? [], providers: namableProviders(s.text).map((p) => ({ id: p.id, name: p.name })) } : {}),
    };
  }

  /** Asks a decision model and waits for it. A `source` other than the backend's is for admins. */
  async decide(input: DecideInput, options: { admin: boolean; priority?: QueuePriority; signal?: AbortSignal; timeoutMs?: number }): Promise<DecideResult> {
    const s = this.deps.settings();
    if (!s.enabled) throw new DecisionError('unavailable', 'Decision models are turned off on this server.');
    let target: DecisionTarget | null;
    if (input.source) {
      if (!options.admin) throw new DecisionError('forbidden', 'Only an admin can ask another decision model.');
      target = targetFor(input.source, s.text, s.services, this.listed?.targets);
      if (!target) throw new DecisionError('unavailable', 'That decision model isn’t set up here any more.');
    } else target = await this.now_();
    if (!target) throw new DecisionError('unavailable', 'No decision model is set up. Pull nimble or tev1 into Ollama 0.35 or later, or add a service in Settings › Admin › Decision models.');
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DECIDE_TIMEOUT_MS);
    return this.run(target, input.state, input.questions, options.signal ? AbortSignal.any([options.signal, timeout]) : timeout, options.priority ?? 'foreground');
  }

  /**
   * For Atelier's own uses (Auto mode's quick check, small choices): the answers, or null when there is no decision
   * model, it's off, or it didn't answer in time. Never throws: each use has its way without one.
   */
  async ask(state: DecisionState, questions: readonly DecisionQuestion[], options: { purpose: string; priority?: QueuePriority; timeoutMs: number; signal?: AbortSignal }): Promise<DecideResult | null> {
    const target = await this.now_().catch(() => null);
    if (!target) return null;
    const timeout = AbortSignal.timeout(options.timeoutMs);
    try {
      return await this.run(target, state, questions, options.signal ? AbortSignal.any([options.signal, timeout]) : timeout, options.priority ?? 'background');
    } catch (error) {
      if (!options.signal?.aborted) this.deps.log?.(`Decision model (${options.purpose}) didn't answer: ${message(error)}`);
      return null;
    }
  }

  private async run(target: DecisionTarget, state: DecisionState, questions: readonly DecisionQuestion[], signal: AbortSignal, priority: QueuePriority, credentials: DecisionDeps['credentials'] = (owner) => this.deps.credentials(owner)): Promise<DecideResult> {
    // A model on a server someone runs waits for its turn there, like a chat request: the GPU answers one at a time.
    const queue = target.owner.kind === 'text' && target.source.local ? this.deps.queue?.(target.owner.id) : null;
    const release = queue && this.deps.scheduler ? await this.deps.scheduler.hold(queue.server, queue.limits, target.model, signal, { priority }) : null;
    try {
      const { apiKey, headers } = await credentials(target.owner);
      const auth = { ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json' };
      const server = `${target.owner.kind}:${target.owner.id}`;
      // LM Studio answers only with a loaded model: it is loaded the first time, and again when LM Studio let it go.
      const loadKey = `${target.root}|${target.model}`;
      if (target.load && !this.loaded.has(loadKey)) await this.loadModel(target, auth, signal);
      // A server not known yet is asked in System One first, and in OpenAI's format when it doesn't know that.
      const learned = this.formats.get(server);
      const first: DecisionDialect = target.dialect === 'auto' ? (learned ?? 'systemone') : target.dialect;
      let attempt = await this.post(target, first, state, questions, auth, signal);
      if (attempt.kind === 'unknown' && target.dialect === 'auto' && !learned) {
        const other: DecisionDialect = first === 'systemone' ? 'openai-decisions' : 'systemone';
        const second = await this.post(target, other, state, questions, auth, signal);
        if (second.kind !== 'unknown') attempt = second;
      }
      if (attempt.kind === 'unloaded' && target.load) {
        this.loaded.delete(loadKey);
        await this.loadModel(target, auth, signal);
        attempt = await this.post(target, attempt.dialect, state, questions, auth, signal);
      }
      if (attempt.kind === 'answer') {
        if (target.dialect === 'auto') this.formats.set(server, attempt.dialect);
        return { ...attempt.result, source: target.source };
      }
      if (attempt.kind === 'unknown')
        throw new DecisionError(
          'failed',
          `${target.source.provider} doesn’t answer decision requests${attempt.said ? ` (“${attempt.said}”)` : ''}. It needs a version with decision models: Ollama 0.35 or later, a current LM Studio or llama.cpp server.`,
        );
      if (attempt.kind === 'unloaded') throw new DecisionError('failed', `${target.source.label} isn’t loaded in ${target.source.provider}: load it there, or let Atelier find it again (Settings › Admin › Decision models).`);
      throw new DecisionError('failed', attempt.message);
    } finally {
      release?.();
    }
  }

  /** LM Studio: loads the model (a minute at most, or as long as the caller waits). */
  private async loadModel(target: DecisionTarget, headers: Record<string, string>, signal: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await this.deps.fetch(target.load!, { method: 'POST', headers, body: JSON.stringify({ model: target.model }), signal: AbortSignal.any([signal, AbortSignal.timeout(DECIDE_TIMEOUT_MS)]) });
    } catch (error) {
      if (signal.aborted) throw new DecisionError('failed', `${target.source.label} is still loading in ${target.source.provider}.`);
      throw new DecisionError('failed', `${target.source.provider} couldn’t be reached: ${message(error)}`);
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new DecisionError('failed', `${target.source.provider} couldn’t load ${target.source.label}${errorText(json) ? `: ${errorText(json)}` : ` (${res.status})`}.`);
    this.loaded.add(`${target.root}|${target.model}`);
  }

  /** One request in one format: the answer, or why there is none. */
  private async post(target: DecisionTarget, dialect: DecisionDialect, state: DecisionState, questions: readonly DecisionQuestion[], headers: Record<string, string>, signal: AbortSignal): Promise<{ kind: 'answer'; dialect: DecisionDialect; result: Omit<DecideResult, 'source'> } | { kind: 'unknown'; dialect: DecisionDialect; said: string | undefined } | { kind: 'unloaded'; dialect: DecisionDialect } | { kind: 'failed'; dialect: DecisionDialect; message: string }> {
    const body = dialect === 'openai-decisions' ? openAiBody(target.model, state, questions) : systemOneBody(target.model, state, questions, target.ollama ? { keep_alive: KEEP_ALIVE } : {});
    const started = this.now();
    let res: Response;
    try {
      res = await this.deps.fetch(endpointOf(target.root, dialect), { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (error) {
      if (signal.aborted) throw new DecisionError('failed', `${target.source.label} didn’t answer in time.`);
      throw new DecisionError('failed', `${target.source.provider} couldn’t be reached: ${message(error)}`);
    }
    const json: unknown = await res.json().catch(() => null);
    const said = errorText(json);
    const answers = typeof json === 'object' && json !== null && 'answers' in json;
    // An address the server doesn't have: a 404 or 405, or (LM Studio before decision models) a 200 that says so.
    if (res.status === 404 && !said?.match(/model/i)) return { kind: 'unknown', dialect, said };
    if (res.status === 405 || (!answers && said && UNKNOWN_ENDPOINT.test(said))) return { kind: 'unknown', dialect, said };
    if (!answers && said && NOT_LOADED.test(said)) return { kind: 'unloaded', dialect };
    if (!res.ok || !answers) {
      const hint = res.status === 401 || res.status === 403 ? ' Check its key in Settings.' : res.status === 404 ? ` Is ${target.model} still there?` : '';
      return { kind: 'failed', dialect, message: `${target.source.provider} answered ${res.status}${said ? `: ${said}` : res.ok ? ' without answers.' : '.'}${hint}` };
    }
    const parsed = parseDecision(json, questions, dialect);
    return { kind: 'answer', dialect, result: { answers: parsed.answers, model: parsed.model ?? target.model, ms: this.now() - started, usage: parsed.usage } };
  }

  /** Checks a service before it is saved: lists its models and asks one a yes-or-no question. */
  async testService(service: DecisionServiceConfig, apiKey: string | undefined): Promise<DecisionServiceTest> {
    const listDeps = { fetch: this.deps.fetch, credentials: async () => ({ ...(apiKey ? { apiKey } : {}), headers: {} }) };
    try {
      const targets = await listService(listDeps, service, AbortSignal.timeout(LIST_TIMEOUT_MS), presetModels(service));
      const models = targets.map((t) => t.model);
      const first = targets[0];
      if (!first) return { ok: false, models, error: 'The service named no models: type the model’s name.' };
      const result = await this.run(first, 'The sky is blue.', [{ name: 'probe', type: 'yesno', instructions: 'Is this sentence about the sky?' }], AbortSignal.timeout(DECIDE_TIMEOUT_MS), 'foreground', listDeps.credentials);
      return { ok: true, models, ms: result.ms };
    } catch (error) {
      return { ok: false, models: service.models ?? [], error: message(error) };
    }
  }

  // ------------------------------------------------------------------ Auto mode's quick check, measured

  private fresh(): Comparison {
    return { checked: 0, bothAllowed: 0, wronglyAllowed: 0, leftToReviewer: 0, approved: 0, since: this.now(), misses: [], times: [] };
  }

  comparison(): DecisionComparison {
    const { times, ...rest } = this.stats;
    const sorted = [...times].sort((a, b) => a - b);
    return { ...rest, medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null };
  }

  /** The quick check and the reviewer both looked at an action. */
  compared(entry: { wouldAllow: boolean; reviewerAllowed: boolean; reviewerVerdict: string; tool: string; summary: string; ms: number }): void {
    const s = this.stats;
    s.checked++;
    s.times = [...s.times, entry.ms].slice(-50);
    if (!entry.wouldAllow) s.leftToReviewer++;
    else if (entry.reviewerAllowed) s.bothAllowed++;
    else {
      s.wronglyAllowed++;
      s.misses = [{ at: this.now(), tool: entry.tool, summary: entry.summary.slice(0, 300), verdict: entry.reviewerVerdict.slice(0, 300) }, ...s.misses].slice(0, MISSES_KEPT);
    }
    this.save();
  }

  /** The quick check let an action run on its own. */
  approvedOne(ms: number): void {
    this.stats.approved++;
    this.stats.times = [...this.stats.times, ms].slice(-50);
    this.save();
  }

  resetComparison(): void {
    this.stats = this.fresh();
    this.save();
  }

  private save(): void {
    const file = this.deps.stateFile;
    if (!file || this.saving) return;
    this.saving = setTimeout(() => {
      this.saving = undefined;
      writeFile(file, JSON.stringify(this.stats)).catch((error) => this.deps.log?.(`Couldn't keep the decision model's comparison: ${message(error)}`));
    }, 2_000);
    this.saving.unref?.();
  }
}
