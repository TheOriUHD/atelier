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
import { listService, listTextProvider, pickAutomatic, targetFor, textOffer, type DecisionOwner, type DecisionTarget } from './sources.ts';
import { errorText, openAiBody, parseDecision, systemOneBody } from './wire.ts';

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

const presetModels = (s: DecisionServiceConfig) => DECISION_SERVICE_PRESETS.find((p) => p.key === s.preset)?.models ?? [];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class DecisionService {
  private listed: Listed | null = null;
  private listing: { key: string; promise: Promise<Listed> } | null = null;
  /** What `current()` found last, for the places that can't wait (which tools a turn has). */
  private last: DecisionTarget | null = null;
  private stats: Comparison;
  private saving: ReturnType<typeof setTimeout> | undefined;
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
    this.listed = null;
    void this.current().catch(() => undefined);
  }

  private key(): string {
    const s = this.deps.settings();
    return JSON.stringify({
      text: s.text.filter((p) => p.enabled !== false && textOffer(p)).map((p) => [p.id, p.type, p.baseUrl, p.name]),
      services: s.services.filter((x) => x.enabled !== false).map((x) => [x.id, x.type, x.baseUrl, x.models, x.name]),
    });
  }

  /** Every decision model, best first: the services added for them, then the providers' in their order. */
  async sources(refresh = false): Promise<Listed> {
    const key = this.key();
    if (!refresh && this.listed?.key === key && this.now() - this.listed.at < LIST_TTL_MS) return this.listed;
    if (this.listing?.key === key) return this.listing.promise;
    const promise = this.list(key).finally(() => {
      if (this.listing?.promise === promise) this.listing = null;
    });
    this.listing = { key, promise };
    return promise;
  }

  private async list(key: string): Promise<Listed> {
    const s = this.deps.settings();
    const problems: Listed['problems'] = [];
    const listDeps = { fetch: this.deps.fetch, credentials: (owner: DecisionOwner) => this.deps.credentials(owner) };
    const attempt = async (name: string, run: (signal: AbortSignal) => Promise<DecisionTarget[]>) => {
      try {
        return await run(AbortSignal.timeout(LIST_TIMEOUT_MS));
      } catch (error) {
        problems.push({ provider: name, error: message(error) });
        return [];
      }
    };
    const services = await Promise.all(s.services.filter((x) => x.enabled !== false).map((x) => attempt(x.name, (signal) => listService(listDeps, x, signal, presetModels(x)))));
    const text = await Promise.all(s.text.filter((p) => p.enabled !== false && textOffer(p)).map((p) => attempt(p.name, (signal) => listTextProvider(listDeps, p, signal))));
    // A provider that has no decision models (an Ollama before 0.35, a chat-only server) isn't a problem; one that
    // couldn't be reached at all was already reported by the provider's own status, so only services' failures show.
    const listed: Listed = { key, at: this.now(), targets: [...services.flat(), ...text.flat()], problems: problems.filter((p) => s.services.some((x) => x.name === p.provider)) };
    if (this.key() === key) this.listed = listed;
    return listed;
  }

  /** The decision model decisions use now: the admin's choice, else one picked by itself; null when off or none. */
  async current(): Promise<DecisionTarget | null> {
    const s = this.deps.settings();
    if (!s.enabled) return (this.last = null);
    // A choice is used as it is, without listing: a model that went away fails when asked, and says why.
    const chosen = s.source ? targetFor(s.source, s.text, s.services) : null;
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
      ...(admin ? { comparison: this.comparison(), problems: listed?.problems ?? [] } : {}),
    };
  }

  /** Asks a decision model and waits for it. A `source` other than the backend's is for admins. */
  async decide(input: DecideInput, options: { admin: boolean; priority?: QueuePriority; signal?: AbortSignal; timeoutMs?: number }): Promise<DecideResult> {
    const s = this.deps.settings();
    if (!s.enabled) throw new DecisionError('unavailable', 'Decision models are turned off on this server.');
    let target: DecisionTarget | null;
    if (input.source) {
      if (!options.admin) throw new DecisionError('forbidden', 'Only an admin can ask another decision model.');
      target = targetFor(input.source, s.text, s.services);
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
      const body = target.dialect === 'openai-decisions' ? openAiBody(target.model, state, questions) : systemOneBody(target.model, state, questions, target.ollama ? { keep_alive: KEEP_ALIVE } : {});
      const started = this.now();
      let res: Response;
      try {
        res = await this.deps.fetch(target.url, {
          method: 'POST',
          headers: { ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw new DecisionError('failed', `${target.source.label} didn’t answer in time.`);
        throw new DecisionError('failed', `${target.source.provider} couldn’t be reached: ${message(error)}`);
      }
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const said = errorText(json);
        const hint = res.status === 401 || res.status === 403 ? ' Check its key in Settings.' : res.status === 404 ? ` Is ${target.model} still there?` : '';
        throw new DecisionError('failed', `${target.source.provider} answered ${res.status}${said ? `: ${said}` : '.'}${hint}`);
      }
      const parsed = parseDecision(json, questions, target.dialect);
      return { answers: parsed.answers, source: target.source, model: parsed.model ?? target.model, ms: this.now() - started, usage: parsed.usage };
    } finally {
      release?.();
    }
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
