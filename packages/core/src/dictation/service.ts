/**
 * Dictation on the backend (ARCHITECTURE §27): a window streams the person's voice here, this passes it to the
 * speech-to-text service of a provider set up here (the key stays here), and the words go back to that window only.
 */
import { randomUUID } from 'node:crypto';
import { DICTATION_CHUNK_MAX_BYTES, DICTATION_MAX_MS, type DictationStart, type DictationStatus, type DictationUpdate, type ImageProviderConfig, type ProviderConfig } from '@atelier/protocol';
import type { ProviderFetch } from '../providers/types.ts';
import type { BuiltinSpeech, BuiltinState } from './builtin/builtin.ts';
import { SPEECH_MODEL_LANGUAGES } from './builtin/manifest.ts';
import { connectWebSocket, type DictationConnect, type DictationEngine } from './engine.ts';
import { openMistralRealtime } from './mistral-realtime.ts';
import { openPhrases } from './phrases.ts';
import { dictationChoices, pickDictation, type DictationChoice } from './sources.ts';
import { transcribe } from './transcribe.ts';

export interface DictationDeps {
  /** The backend's settings as they are now. */
  settings(): { enabled: boolean; source?: string | undefined; text: readonly ProviderConfig[]; media: readonly ImageProviderConfig[] };
  /** A provider's key and headers, resolved. */
  credentials(provider: DictationChoice['provider']): Promise<{ apiKey?: string | undefined; headers: Record<string, string> }>;
  fetch: ProviderFetch;
  connect?: DictationConnect;
  log?(message: string): void;
  /** Atelier's own model on this backend; none leaves only providers. */
  builtin?: BuiltinSpeech | null;
  /** Where the own model runs, as the settings name it ("on this server"). */
  builtinWhere?: string;
  /** For tests. */
  limits?: { idleMs?: number; maxMs?: number };
}

export class DictationError extends Error {
  constructor(
    readonly code: 'unavailable' | 'not_found' | 'too_many' | 'preparing',
    message: string,
  ) {
    super(message);
  }
}

interface Session<Owner> {
  id: string;
  owner: Owner;
  userId: string;
  engine: DictationEngine | null;
  /** Audio that came before the service was ready, or out of order. */
  early: Uint8Array[];
  next: number;
  waiting: Map<number, Uint8Array>;
  idle: ReturnType<typeof setTimeout> | undefined;
  limit: ReturnType<typeof setTimeout> | undefined;
  /** To its window while it lasts. */
  emit(update: Omit<DictationUpdate, 'id'>): void;
  /** To its window, also after it ended (the last words of one that ran out of time). */
  send(update: Omit<DictationUpdate, 'id'>): void;
  text: string;
  stopped: boolean;
}

/** Sessions one person may have at once (a few windows). */
const PER_PERSON = 4;

export class DictationService<Owner> {
  private sessions = new Map<string, Session<Owner>>();

  constructor(private readonly deps: DictationDeps) {}

  private choices(): DictationChoice[] {
    const s = this.deps.settings();
    const own = this.deps.builtin && this.deps.builtin.state().state !== 'unsupported' ? { label: this.deps.builtin.label, where: this.deps.builtinWhere ?? 'Atelier' } : null;
    return dictationChoices(s.text, s.media, own);
  }

  status(admin: boolean): DictationStatus {
    const s = this.deps.settings();
    const all = this.choices();
    const picked = s.enabled ? pickDictation(all, s.source) : null;
    const builtin = this.deps.builtin ? toStatus(this.deps.builtin.state()) : undefined;
    return { enabled: s.enabled, source: picked?.source ?? null, sources: admin ? all.map((c) => c.source) : [], chosen: admin ? (s.source ?? null) : null, ...(builtin ? { builtin } : {}) };
  }

  /** Gets the own model ready when dictation would use it (fetching it the first time); answers at once. */
  prepare(admin: boolean): DictationStatus {
    const s = this.deps.settings();
    const picked = s.enabled ? pickDictation(this.choices(), s.source) : null;
    // An admin's "Download now" fetches it whatever dictation uses now; anyone's dictation when it would use it.
    if (this.deps.builtin && (admin || picked?.dialect === 'builtin')) void this.deps.builtin.prepare().catch(() => undefined);
    return this.status(admin);
  }

  /** Starts one for this window (ending one it had), with the service that dictating uses now. */
  async start(owner: Owner, userId: string, input: DictationStart, emit: (update: DictationUpdate) => void): Promise<{ id: string; live: boolean }> {
    const s = this.deps.settings();
    if (!s.enabled) throw new DictationError('unavailable', 'Dictation is turned off on this server. An admin can turn it on in Settings › General › Dictation.');
    const all = this.choices();
    let choice = pickDictation(all, s.source);
    // A language Atelier's model wasn't trained on goes to a provider that may know it, unless an admin chose the model.
    if (choice?.dialect === 'builtin' && !s.source && input.language !== 'auto' && !SPEECH_MODEL_LANGUAGES[input.language]) choice = all.find((c) => c.dialect !== 'builtin') ?? choice;
    if (!choice)
      throw new DictationError(
        'unavailable',
        'Dictation needs a speech-to-text service. An admin adds one in Settings › Providers or Media: Mistral, OpenAI, Groq, ElevenLabs or Deepgram, or a local Whisper server.',
      );
    // One at a time per window: one still running there (another message box) ends, keeping what it heard.
    for (const old of [...this.sessions.values()].filter((x) => x.owner === owner)) {
      old.emit({ text: old.text, error: 'Dictation went on in another message box.' });
      this.drop(old);
    }
    if ([...this.sessions.values()].filter((x) => x.userId === userId).length >= PER_PERSON) throw new DictationError('too_many', 'You are dictating in too many windows at once.');
    const id = randomUUID();
    const session: Session<Owner> = {
      id,
      owner,
      userId,
      engine: null,
      early: [],
      next: 0,
      waiting: new Map(),
      idle: undefined,
      limit: undefined,
      text: '',
      stopped: false,
      emit: (update) => {
        if (this.sessions.get(id) === session) emit({ id, ...update });
      },
      send: (update) => emit({ id, ...update }),
    };
    this.sessions.set(id, session);
    const language = input.language === 'auto' ? null : input.language;
    const hints = (input.hints ?? []).map((h) => h.trim()).filter(Boolean);
    const events = {
      onText: (text: string) => {
        session.text = text;
        session.emit({ text });
      },
      onError: (message: string) => {
        session.emit({ text: session.text, error: message });
        this.drop(session);
      },
    };
    if (choice.dialect === 'builtin') {
      const own = this.deps.builtin;
      if (!own || own.state().state !== 'ready') {
        this.drop(session);
        void own?.prepare().catch(() => undefined);
        throw new DictationError('preparing', 'Dictation is getting ready: its speech model is being downloaded.');
      }
    }
    try {
      const { apiKey, headers } = choice.dialect === 'builtin' ? { apiKey: undefined, headers: {} } : await this.deps.credentials(choice.provider);
      const name = choice.source.provider;
      session.engine = choice.dialect === 'builtin'
        ? await this.deps.builtin!.open(language, events)
        : choice.dialect === 'mistral-realtime'
          ? await openMistralRealtime({ baseUrl: choice.baseUrl, apiKey, headers, model: choice.model, language, hints, name, connect: this.deps.connect ?? connectWebSocket, ...events })
          : openPhrases({
              ...events,
              transcribe: (wav, before, signal) =>
                transcribe({ dialect: choice.dialect as Exclude<DictationChoice['dialect'], 'mistral-realtime'>, baseUrl: choice.baseUrl, apiKey, headers, model: choice.model, name, wav, language, before, hints, fetch: this.deps.fetch, signal }),
            });
    } catch (e) {
      this.drop(session);
      throw new DictationError('unavailable', e instanceof Error ? e.message : 'The speech-to-text service couldn’t be reached.');
    }
    // Stopped or replaced while it connected.
    if (this.sessions.get(id) !== session) {
      session.engine.abort();
      throw new DictationError('not_found', 'That dictation was stopped.');
    }
    for (const chunk of session.early.splice(0)) session.engine.write(chunk);
    this.touch(session);
    session.limit = setTimeout(() => {
      const error = `Dictation stops after ${Math.round(this.maxMs / 60_000)} minutes.`;
      void this.stop(owner, id).then(
        ({ text }) => session.send({ text, error }),
        (e: unknown) => session.send({ text: session.text, error: e instanceof Error ? e.message : error }),
      );
    }, this.maxMs);
    session.limit.unref?.();
    this.deps.log?.(`dictation started (${choice.source.label} via ${choice.source.provider})`);
    return { id, live: choice.source.live };
  }

  private get maxMs(): number {
    return this.deps.limits?.maxMs ?? DICTATION_MAX_MS;
  }

  /** Ends a dictation whose window stopped sending audio (closed, asleep, or the microphone went away). */
  private touch(session: Session<Owner>): void {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      session.emit({ text: session.text, error: 'The microphone stopped sending sound.' });
      this.drop(session);
    }, this.deps.limits?.idleMs ?? 20_000);
    session.idle.unref?.();
  }

  private own(owner: Owner, id: string): Session<Owner> {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new DictationError('not_found', 'That dictation has ended.');
    return session;
  }

  audio(owner: Owner, id: string, seq: number, pcm: Uint8Array): void {
    const session = this.own(owner, id);
    if (session.stopped) return;
    if (pcm.byteLength > DICTATION_CHUNK_MAX_BYTES || pcm.byteLength % 2) throw new DictationError('not_found', 'That isn’t audio dictation can take.');
    if (seq < session.next) return;
    session.waiting.set(seq, pcm);
    if (session.waiting.size > 50) {
      session.emit({ text: session.text, error: 'Sound from the microphone got lost on the way.' });
      this.drop(session);
      return;
    }
    while (session.waiting.has(session.next)) {
      const chunk = session.waiting.get(session.next)!;
      session.waiting.delete(session.next);
      session.next++;
      if (session.engine) session.engine.write(chunk);
      else session.early.push(chunk);
    }
    this.touch(session);
  }

  /** Stops listening and answers with everything said. */
  async stop(owner: Owner, id: string): Promise<{ text: string }> {
    const session = this.own(owner, id);
    session.stopped = true;
    clearTimeout(session.idle);
    clearTimeout(session.limit);
    try {
      const text = session.engine ? await session.engine.finish() : session.text;
      session.text = text;
      return { text };
    } finally {
      this.sessions.delete(id);
    }
  }

  cancel(owner: Owner, id: string): void {
    const session = this.sessions.get(id);
    if (session && session.owner === owner) this.drop(session);
  }

  /** A window went away: its dictations end. */
  dropAll(owner: Owner): void {
    for (const session of [...this.sessions.values()]) if (session.owner === owner) this.drop(session);
  }

  private drop(session: Session<Owner>): void {
    clearTimeout(session.idle);
    clearTimeout(session.limit);
    session.engine?.abort();
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) this.drop(session);
  }
}

function toStatus(state: BuiltinState): DictationStatus['builtin'] {
  switch (state.state) {
    case 'downloading':
      return { state: 'downloading', received: state.received, total: state.total };
    case 'missing':
      return { state: 'missing', bytes: state.bytes };
    case 'failed':
      return { state: 'failed', error: state.error, bytes: state.bytes };
    default:
      return { state: state.state };
  }
}
