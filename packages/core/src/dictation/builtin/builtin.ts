/**
 * Atelier's own speech-to-text on this backend (ARCHITECTURE §27): the engine runs in a worker thread, so decoding never
 * holds up the backend, and one loaded model serves every dictation here (a stream each). The model is loaded when
 * someone dictates and let go after a quarter of an hour without anyone dictating.
 */
import { EventEmitter } from 'node:events';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DictationEngine, EngineEvents } from '../engine.ts';
import { forgetRuntime, install, installed, installPaths, type Fetch, type InstallPaths } from './install.ts';
import { SPEECH_MODEL, SPEECH_MODEL_LANGUAGES, SPEECH_RUNTIME, speechDownloadBytes, speechPlatform } from './manifest.ts';

export type BuiltinState =
  | { state: 'unsupported' }
  | { state: 'missing'; bytes: number }
  | { state: 'downloading'; received: number; total: number }
  | { state: 'ready' }
  | { state: 'failed'; error: string; bytes: number };

/**
 * The worker, as source (the backend is bundled into one file, and a worker needs a file or a string of its own). It
 * loads the addon by path, creates the recognizer once, and keeps one stream per dictation.
 */
const WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
let addon, recognizer;
try {
  addon = require(workerData.addon);
  const dir = workerData.model;
  recognizer = addon.createOnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 128 },
    modelConfig: {
      transducer: { encoder: dir + '/encoder.int8.onnx', decoder: dir + '/decoder.int8.onnx', joiner: dir + '/joiner.int8.onnx' },
      tokens: dir + '/tokens.txt',
      numThreads: workerData.threads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: 0,
  });
  parentPort.postMessage({ type: 'ready' });
} catch (e) {
  parentPort.postMessage({ type: 'failed', message: String((e && e.message) || e) });
}
const streams = new Map();
// The model ends an automatically recognised language with its tag (<de-DE>) and may double spaces.
const clean = (t) => String(t || '').replace(/<[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*>/g, '').replace(/\s+/g, ' ').trim();
const heard = (stream) => {
  while (addon.isOnlineStreamReady(recognizer, stream)) addon.decodeOnlineStream(recognizer, stream);
  return clean(JSON.parse(addon.getOnlineStreamResultAsJson(recognizer, stream)).text);
};
parentPort.on('message', (m) => {
  try {
    if (m.type === 'open') {
      const stream = addon.createOnlineStream(recognizer);
      if (m.language) addon.onlineStreamSetOption(stream, 'language', m.language);
      // Half a second of quiet first: a word said the moment the microphone opens is heard whole.
      addon.acceptWaveformOnline(stream, { samples: new Float32Array(8000), sampleRate: 16000 });
      streams.set(m.id, { stream, last: '' });
    } else if (m.type === 'audio') {
      const s = streams.get(m.id);
      if (!s) return;
      addon.acceptWaveformOnline(s.stream, { samples: m.samples, sampleRate: 16000 });
      const text = heard(s.stream);
      if (text !== s.last) {
        s.last = text;
        parentPort.postMessage({ type: 'text', id: m.id, text });
      }
    } else if (m.type === 'finish') {
      const s = streams.get(m.id);
      if (!s) return parentPort.postMessage({ type: 'final', id: m.id, text: '' });
      // A little more quiet carries the last words through the model's lookahead.
      addon.acceptWaveformOnline(s.stream, { samples: new Float32Array(19200), sampleRate: 16000 });
      addon.inputFinished(s.stream);
      const text = heard(s.stream);
      streams.delete(m.id);
      parentPort.postMessage({ type: 'final', id: m.id, text });
    } else if (m.type === 'close') {
      streams.delete(m.id);
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', id: m.id, message: String((e && e.message) || e) });
  }
});
`;

interface Waiting {
  /** The worker it runs on: one that goes away ends only its own dictations. */
  worker: Promise<Worker>;
  events: EngineEvents;
  finish?: { resolve(text: string): void; reject(error: Error): void };
  text: string;
}

export interface BuiltinSpeechOptions {
  /** Where the engine and the model are kept (in the backend's data folder). */
  dir: string;
  fetch?: Fetch;
  log?(message: string): void;
  /** For tests: another platform, or no worker at all. */
  platform?: string;
  idleMs?: number;
}

export class BuiltinSpeech extends EventEmitter<{ state: [BuiltinState] }> {
  private current: BuiltinState;
  private installing: Promise<InstallPaths> | null = null;
  private worker: Promise<Worker> | null = null;
  private sessions = new Map<number, Waiting>();
  private nextId = 1;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly platform: string;
  private lastProgress = 0;

  constructor(private readonly options: BuiltinSpeechOptions) {
    super();
    this.platform = options.platform ?? speechPlatform();
    this.current = SPEECH_RUNTIME[this.platform] ? { state: 'missing', bytes: speechDownloadBytes(this.platform) } : { state: 'unsupported' };
    if (this.current.state !== 'unsupported') void installed(options.dir, this.platform).then((ok) => ok && this.set({ state: 'ready' }));
  }

  get label(): string {
    return SPEECH_MODEL.label;
  }

  state(): BuiltinState {
    return this.current;
  }

  private set(state: BuiltinState): void {
    this.current = state;
    this.emit('state', state);
  }

  /** Fetches the engine and the model unless they are here; the same promise for everyone asking meanwhile. */
  prepare(): Promise<InstallPaths> {
    if (this.current.state === 'unsupported') return Promise.reject(new Error(`Atelier’s speech model doesn’t run on ${this.platform}.`));
    this.installing ??= (async () => {
      if (await installed(this.options.dir, this.platform)) {
        this.set({ state: 'ready' });
        return installPaths(this.options.dir, this.platform);
      }
      const bytes = speechDownloadBytes(this.platform);
      this.set({ state: 'downloading', received: 0, total: bytes });
      this.options.log?.(`dictation: downloading ${SPEECH_MODEL.label} (${Math.round(bytes / 1e6)} MB)`);
      try {
        const paths = await install({
          dir: this.options.dir,
          platform: this.platform,
          fetch: this.options.fetch ?? ((url, init) => fetch(url, init)),
          signal: new AbortController().signal,
          onProgress: ({ received, total }) => {
            // Twice a second is plenty for a progress bar.
            const now = Date.now();
            if (now - this.lastProgress < 500 && received < total) return;
            this.lastProgress = now;
            this.set({ state: 'downloading', received, total });
          },
        });
        this.set({ state: 'ready' });
        this.options.log?.('dictation: the speech model is ready');
        return paths;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.set({ state: 'failed', error, bytes });
        this.options.log?.(`dictation: the speech model couldn’t be downloaded: ${error}`);
        throw e;
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  private spawn(paths: InstallPaths): Promise<Worker> {
    if (this.worker) return this.worker;
    const mine: Promise<Worker> = new Promise<Worker>((resolve, reject) => {
      const threads = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
      const worker = new Worker(WORKER, { eval: true, workerData: { addon: join(paths.runtime, 'sherpa-onnx.node'), model: paths.model, threads } });
      worker.unref();
      worker.on('message', (m: { type: string; id?: number; text?: string; message?: string }) => {
        if (m.type === 'ready') return resolve(worker);
        if (m.type === 'failed') {
          // An engine that can't load (damaged, or not for this system): it is fetched again on the next try.
          void worker.terminate();
          const error = `The speech model couldn’t start: ${m.message}`;
          this.options.log?.(`dictation: ${error}`);
          void forgetRuntime(this.options.dir, this.platform).finally(() => this.set({ state: 'failed', error, bytes: speechDownloadBytes(this.platform) }));
          return reject(new Error(error));
        }
        const session = m.id === undefined ? undefined : this.sessions.get(m.id);
        if (!session) return;
        if (m.type === 'text') {
          session.text = m.text ?? '';
          session.events.onText(session.text);
        } else if (m.type === 'final') {
          this.sessions.delete(m.id!);
          session.finish?.resolve((m.text ?? '').trim() || session.text);
          this.release();
        } else if (m.type === 'error') {
          this.sessions.delete(m.id!);
          const message = `The speech model stopped: ${m.message}`;
          if (session.finish) session.finish.reject(new Error(message));
          else session.events.onError(message);
          this.release();
        }
      });
      const gone = (error: Error) => {
        reject(error);
        if (this.worker === mine) this.worker = null;
        for (const [id, session] of this.sessions) {
          if (session.worker !== mine) continue;
          this.sessions.delete(id);
          if (session.finish) session.finish.resolve(session.text);
          else session.events.onError('The speech model stopped unexpectedly.');
        }
      };
      worker.on('error', gone);
      worker.on('exit', (code) => gone(new Error(`The speech model stopped (${code}).`)));
    });
    this.worker = mine;
    mine.catch(() => {
      if (this.worker === mine) this.worker = null;
    });
    return mine;
  }

  /** Lets the model go once nobody has dictated for a while (it holds about 700 MB). */
  private release(): void {
    clearTimeout(this.idle);
    if (this.sessions.size) return;
    this.idle = setTimeout(() => {
      if (this.sessions.size || !this.worker) return;
      const worker = this.worker;
      this.worker = null;
      void worker.then((w) => w.terminate(), () => undefined);
    }, this.options.idleMs ?? 15 * 60_000);
    this.idle.unref?.();
  }

  /** A dictation: the model must be here (`prepare`); `language` null lets it hear which. */
  async open(language: string | null, events: EngineEvents): Promise<DictationEngine> {
    const paths = await this.prepare();
    const pending = this.spawn(paths);
    const worker = await pending;
    clearTimeout(this.idle);
    const id = this.nextId++;
    const session: Waiting = { worker: pending, events, text: '' };
    this.sessions.set(id, session);
    const code = language ? (SPEECH_MODEL_LANGUAGES[language] ?? null) : null;
    worker.postMessage({ type: 'open', id, ...(code ? { language: code } : {}) });
    let done: Promise<string> | null = null;
    return {
      write: (pcm) => {
        if (done || !this.sessions.has(id)) return;
        const samples = new Float32Array(pcm.byteLength >> 1);
        const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        worker.postMessage({ type: 'audio', id, samples }, [samples.buffer]);
      },
      finish: () => {
        done ??= this.sessions.has(id)
          ? new Promise<string>((resolve, reject) => {
              session.finish = { resolve, reject };
              worker.postMessage({ type: 'finish', id });
            })
          : Promise.resolve(session.text);
        return done;
      },
      abort: () => {
        if (!this.sessions.has(id)) return;
        this.sessions.delete(id);
        worker.postMessage({ type: 'close', id });
        session.finish?.resolve(session.text);
        this.release();
      },
    };
  }

  dispose(): void {
    clearTimeout(this.idle);
    const worker = this.worker;
    this.worker = null;
    void worker?.then((w) => w.terminate(), () => undefined);
  }
}
