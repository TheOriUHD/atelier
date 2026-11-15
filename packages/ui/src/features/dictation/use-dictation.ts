/**
 * One dictation at a time in a message box (ARCHITECTURE §27): the microphone here, the speech-to-text on the backend,
 * the words back as `dictation.update`. The box shows `heard` while it runs and takes the final words from `stop`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RpcError, RpcErrorCode, type DictationStatus } from '@atelier/protocol';
import { desktop } from '../../lib/platform.ts';
import { describeError, errorCode, rpc } from '../../lib/rpc.ts';
import { MicrophoneError, startCapture, type Capture } from './capture.ts';
import { savedMicrophone } from './microphones.ts';
import { backendTransport, macCanHear, macTransport, MacCantHear, prefersAtelierModel, type DictationTransport, type TransportUpdate } from './transports.ts';

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing';

export interface DictationProblem {
  message: string;
  /** What helps: the system's microphone settings, Atelier's settings (`fix` is the page), or nothing. */
  help: 'microphone-settings' | 'settings' | null;
  fix?: string;
  /** `info`: good news (the speech model is ready), not a failure. */
  tone?: 'info';
}

/** The last few moments' loudness, newest last, for the waveform. */
export interface Levels {
  get(): readonly number[];
  subscribe(listener: () => void): () => void;
}

const LEVELS = 48;

function levelStore() {
  let values: number[] = new Array<number>(LEVELS).fill(0);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    get: () => values,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    push(level: number) {
      values = [...values.slice(1), level];
      notify();
    },
    reset() {
      values = new Array<number>(LEVELS).fill(0);
      notify();
    },
  };
}

/** The waveform's bars, re-rendered only where they are drawn. */
export function useLevels(levels: Levels): readonly number[] {
  return useSyncExternalStore(levels.subscribe, levels.get, levels.get);
}

/** The longest a stop waits for the service's last words before it keeps what came. */
const STOP_WAIT_MS = 5000;

/** 100 ms of audio per call: ten calls a second. */
const SEND_SAMPLES = 1600;
/** A backlog goes a second at a time (a call takes two at most, `DICTATION_CHUNK_MAX_BYTES`). */
const MAX_SEND_SAMPLES = 16_000;

function joinSamples(parts: readonly Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function problemOf(error: unknown): DictationProblem {
  if (error instanceof MicrophoneError)
    return error.kind === 'denied' && desktop?.microphone
      ? { message: `${error.message} Allow it in your system’s privacy settings, then try again.`, help: 'microphone-settings' }
      : { message: error.kind === 'denied' ? `${error.message} Allow it in the browser’s site settings, then try again.` : error.message, help: null };
  if (error instanceof RpcError && error.code === RpcErrorCode.MethodNotFound) return { message: 'This Atelier server is older than dictation. Update it to dictate.', help: null };
  const { message, fix } = describeError(error);
  return fix ? { message, help: 'settings', fix } : { message, help: null };
}

interface Run {
  transport: DictationTransport;
  id: string | null;
  capture: Capture | null;
  seq: number;
  pending: Int16Array[];
  pendingSamples: number;
  heard: string;
  over: boolean;
  /** Settles once the microphone and the speech service both answered (or one failed). */
  ready: Promise<boolean>;
  /** The one stop of this run: every caller (the button, Enter, the shortcut, a lost microphone) waits for the same. */
  stopping: Promise<string> | null;
  /** While a stop waits for the last words: stops waiting, keeping what came. */
  giveUp?: () => void;
}

/** Atelier's own speech model is being fetched (the first dictation here): how far, while the box waits. */
export interface GettingReady {
  /** 0 to 1; null before the first progress. */
  fraction: number | null;
  /** Megabytes so far and in all, when the backend says. */
  received?: number;
  total?: number;
  /** Whose: the Mac's recognition for a language, or Atelier's model on the backend. */
  kind: 'mac' | 'backend';
}

export interface DictationOptions {
  /** `auto` or a two-letter code. */
  language: string;
  /** Words to spell as given. */
  hints?: readonly string[];
  /**
   * Dictate with the Mac's own speech recognition (the desktop app on a Mac, unless Settings › Developer says otherwise);
   * undefined while it isn't known yet whether this Mac can: the start waits for main's answer.
   */
  mac?: boolean | undefined;
  /** The dictation ended by itself (the service failed, the microphone went away, time ran out): its words so far. */
  onEnded?(heard: string): void;
}

export interface Dictation {
  phase: DictationPhase;
  /** What was heard so far, while it runs. */
  heard: string;
  /** Words appear while speaking (otherwise a phrase at a time). */
  live: boolean;
  problem: DictationProblem | null;
  /** Atelier's speech model (or the Mac's, for a language) is being fetched. */
  gettingReady: GettingReady | null;
  clearProblem(): void;
  levels: Levels;
  /** Starts listening; false when it couldn't (the problem says why). */
  start(): Promise<boolean>;
  /** Stops listening and resolves with everything said ('' for nothing). */
  stop(): Promise<string>;
  /** Stops listening and keeps nothing. */
  cancel(): void;
}

export function useDictation(options: DictationOptions): Dictation {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [heard, setHeard] = useState('');
  const [live, setLive] = useState(true);
  const [problem, setProblem] = useState<DictationProblem | null>(null);
  const [gettingReady, setGettingReady] = useState<GettingReady | null>(null);
  const [levels] = useState(levelStore);
  const run = useRef<Run | null>(null);
  const opts = useRef(options);
  useLayoutEffect(() => {
    opts.current = options;
  });

  const finish = useCallback(
    (r: Run) => {
      if (r.over) return;
      r.over = true;
      r.capture?.stop();
      if (run.current === r) run.current = null;
      setPhase('idle');
      setHeard('');
      levels.reset();
    },
    [levels],
  );

  /** It ended by itself (the service dropped it): the words so far go to the box, and why it ended shows. */
  const endWith = useCallback(
    (r: Run, why: DictationProblem) => {
      if (r.over) return;
      const words = r.heard;
      finish(r);
      setProblem(why);
      opts.current.onEnded?.(words);
    },
    [finish],
  );

  const send = useCallback(
    (r: Run, all = false) => {
      if (!r.id || r.over) return;
      // A second at most per call: a backlog from a slow start goes in several, each within the call's size limit.
      while (r.pendingSamples >= SEND_SAMPLES || (all && r.pendingSamples > 0)) {
        const samples = joinSamples(r.pending);
        const take = Math.min(samples.length, MAX_SEND_SAMPLES);
        const rest = samples.subarray(take);
        r.pending = rest.length ? [rest] : [];
        r.pendingSamples = rest.length;
        const id = r.id;
        void r.transport.audio(id, r.seq++, samples.subarray(0, take)).catch((e: unknown) => {
          if (run.current !== r || r.over) return;
          // Gone on the backend: it said why in an update, unless the connection itself dropped.
          if (errorCode(e) === 'not_found') endWith(r, { message: 'Dictation stopped: the connection to Atelier was interrupted.', help: null });
          else {
            r.transport.cancel(id);
            endWith(r, problemOf(e));
          }
        });
      }
    },
    [endWith],
  );

  /** Stops the microphone, sends what is left and waits for the final words: once per run, however often it is asked. */
  const finalize = useCallback(
    (r: Run): Promise<string> => {
      r.stopping ??= (async () => {
        const ok = await r.ready;
        if (!ok || r.over || !r.id) return r.heard;
        r.capture?.stop();
        send(r, true);
        try {
          return await r.transport.stop(r.id);
        } catch (e) {
          // What came already is kept; why the rest didn't shows.
          if (!r.over) setProblem(problemOf(e));
          return r.heard;
        }
      })();
      return r.stopping;
    },
    [send],
  );

  // Updates that come before the service has answered the start (one that fails at once) wait for the id.
  const early = useRef(new Map<string, TransportUpdate>());
  const apply = useCallback(
    (r: Run, update: TransportUpdate) => {
      if (r.over) return;
      if (update.text !== undefined) {
        r.heard = update.text;
        setHeard(update.text);
      }
      if (update.error) endWith(r, { message: update.error, help: null });
    },
    [endWith],
  );
  useEffect(() => {
    const transports = [backendTransport, macTransport()].filter((t): t is DictationTransport => !!t);
    const offs = transports.map((t) =>
      t.subscribe((update) => {
        const r = run.current;
        if (!r || r.transport.kind !== t.kind) return;
        if (r.id === update.id) apply(r, update);
        else if (!r.id) {
          // The Mac fetching its model for the language, before it listens.
          if (update.preparing !== undefined) setGettingReady({ fraction: update.preparing, kind: 'mac' });
          else {
            early.current.set(update.id, update);
            if (early.current.size > 20) early.current.delete(early.current.keys().next().value!);
          }
        }
      }),
    );
    return () => offs.forEach((off) => off());
  }, [apply]);

  // Atelier's own model being fetched: its progress, and its being ready (`dictation.changed`, and a look every few
  // seconds, so a missed event or a backend that restarted meanwhile doesn't leave the notice standing).
  const onStatus = useCallback((status: DictationStatus) => {
    const own = status.builtin;
    if (!own) return;
    setGettingReady((now) => {
      if (!now || now.kind !== 'backend') return now;
      if (own.state === 'downloading') return { kind: 'backend', fraction: own.total ? (own.received ?? 0) / own.total : null, received: own.received ?? 0, total: own.total ?? 0 };
      if (own.state === 'ready') {
        queueMicrotask(() => setProblem({ message: 'Dictation is ready. Click the microphone and speak.', help: null, tone: 'info' }));
        return null;
      }
      if (own.state === 'failed' || own.state === 'missing' || own.state === 'unsupported') {
        const why = own.state === 'failed' ? own.error ?? 'unknown error' : own.state === 'missing' ? 'the download stopped' : 'it doesn’t run here';
        queueMicrotask(() => setProblem({ message: `Dictation’s speech model couldn’t be downloaded: ${why}. Click the microphone to try again.`, help: null }));
        return null;
      }
      return now;
    });
  }, []);
  useEffect(() => rpc().on('dictation.changed', onStatus), [onStatus]);
  const waitingForModel = gettingReady?.kind === 'backend';
  useEffect(() => {
    if (!waitingForModel) return;
    const timer = setInterval(() => void rpc().call('dictation.status', {}).then(onStatus, () => undefined), 3000);
    return () => clearInterval(timer);
  }, [waitingForModel, onStatus]);

  // A box that goes away takes its dictation with it (it kept the words: `onEnded` isn't for this).
  useEffect(
    () => () => {
      const r = run.current;
      if (!r) return;
      if (r.id) r.transport.cancel(r.id);
      r.over = true;
      r.capture?.stop();
      run.current = null;
    },
    [],
  );

  const start = useCallback(async (): Promise<boolean> => {
    if (run.current) return false;
    let settle: (ok: boolean) => void = () => {};
    const r: Run = {
      transport: backendTransport,
      id: null,
      capture: null,
      seq: 0,
      pending: [],
      pendingSamples: 0,
      heard: '',
      over: false,
      ready: new Promise((resolve) => (settle = resolve)),
      stopping: null,
    };
    run.current = r;
    early.current.clear();
    setProblem(null);
    setGettingReady(null);
    setHeard('');
    setPhase('starting');
    levels.reset();
    // The Mac's own recognition, or Atelier's backend: a moment after launch main may still be finding out which.
    const wantsMac = opts.current.mac ?? (desktop?.speech && !prefersAtelierModel() ? await macCanHear() : false);
    const mac = wantsMac ? macTransport() : null;
    if (mac) r.transport = mac;
    if (r.over) {
      settle(false);
      return false;
    }
    const fail = (error: unknown) => {
      r.capture?.stop();
      setGettingReady(null);
      if (!r.over) endWith(r, problemOf(error));
      settle(false);
      return false;
    };
    // macOS asks once for the app; the browser asks for the page in getUserMedia.
    if (desktop?.microphone && !(await desktop.microphone.ask().catch(() => true))) return fail(new MicrophoneError('denied', 'Atelier isn’t allowed to use the microphone.'));
    if (r.over) return fail(null);
    // The microphone first: however long the person takes to allow it, no speech service waits idle meanwhile.
    try {
      r.capture = await startCapture({
        deviceId: savedMicrophone(),
        onAudio: (pcm) => {
          if (r.over || r.stopping) return;
          r.pending.push(pcm);
          r.pendingSamples += pcm.length;
          send(r);
        },
        onLevel: (level) => levels.push(level),
        // Unplugged: what was said is transcribed to the end and kept, and the box says why it stopped.
        onEnded: () => {
          setPhase('finishing');
          void finalize(r).then((words) => {
            if (r.over) return;
            finish(r);
            setProblem({ message: 'The microphone was disconnected.', help: null });
            opts.current.onEnded?.(words);
          });
        },
      });
    } catch (e) {
      return fail(e);
    }
    if (r.over) {
      r.capture.stop();
      settle(false);
      return false;
    }
    const { language, hints = [] } = opts.current;
    let answer: { id: string; live: boolean };
    try {
      answer = await r.transport.start(language, hints);
    } catch (e) {
      if (e instanceof MacCantHear && !r.over) {
        // The Mac doesn't know the language: Atelier's backend takes it, with what the microphone heard meanwhile.
        r.transport = backendTransport;
        setGettingReady(null);
        try {
          answer = await r.transport.start(language, hints);
        } catch (again) {
          return startFailed(r, again);
        }
      } else return startFailed(r, e);
    }
    setGettingReady(null);
    r.id = answer.id;
    if (r.over) {
      r.capture.stop();
      r.transport.cancel(r.id);
      settle(false);
      return false;
    }
    setLive(answer.live);
    setPhase('listening');
    // What the microphone heard while the service connected goes first, then whatever it said meanwhile.
    send(r);
    settle(true);
    const waiting = early.current.get(r.id);
    early.current.clear();
    if (waiting) apply(r, waiting);
    return true;

    /** Atelier's own model isn't here yet: it is fetched now and the box says how far; anything else is a problem. */
    function startFailed(at: Run, error: unknown): false {
      if (errorCode(error) !== 'preparing') return fail(error) as false;
      at.capture?.stop();
      finish(at);
      settle(false);
      // The box is the person's again meanwhile.
      opts.current.onEnded?.('');
      setGettingReady({ kind: 'backend', fraction: null });
      void rpc()
        .call('dictation.prepare', {})
        .then((status) => {
          if (status.builtin?.state === 'downloading') setGettingReady({ kind: 'backend', fraction: status.builtin.total ? (status.builtin.received ?? 0) / status.builtin.total : null, received: status.builtin.received ?? 0, total: status.builtin.total ?? 0 });
          if (status.builtin?.state === 'ready') {
            setGettingReady(null);
            setProblem({ message: 'Dictation is ready. Click the microphone and speak.', help: null, tone: 'info' });
          }
        })
        .catch((e: unknown) => {
          setGettingReady(null);
          setProblem(problemOf(e));
        });
      return false;
    }
  }, [apply, endWith, finalize, finish, levels, send]);

  /**
   * Stops listening and resolves with the final words. It never hangs: after STOP_WAIT_MS, or when asked a second time
   * (the button pressed again), it stops waiting and keeps what was heard.
   */
  const stop = useCallback(async (): Promise<string> => {
    const r = run.current;
    if (!r || r.over) return '';
    if (r.giveUp) {
      r.giveUp();
      return r.heard;
    }
    setPhase('finishing');
    let gaveUp = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<string>((resolve) => {
      const keep = () => {
        clearTimeout(timer);
        gaveUp = true;
        resolve(r.heard);
      };
      r.giveUp = keep;
      timer = setTimeout(keep, STOP_WAIT_MS);
    });
    const words = await Promise.race([finalize(r), waited]);
    clearTimeout(timer);
    r.giveUp = undefined;
    if (gaveUp && r.id) r.transport.cancel(r.id);
    finish(r);
    return words;
  }, [finalize, finish]);

  const cancel = useCallback(() => {
    const r = run.current;
    if (!r) return;
    const id = r.id;
    finish(r);
    setGettingReady(null);
    if (id) r.transport.cancel(id);
    // Still starting: the service's answer is cancelled when it comes (`r.over`).
  }, [finish]);

  return { phase, heard, live, problem, gettingReady, clearProblem: useCallback(() => setProblem(null), []), levels, start, stop, cancel };
}
