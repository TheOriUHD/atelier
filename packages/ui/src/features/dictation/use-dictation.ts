/**
 * One dictation at a time in a message box (ARCHITECTURE §27): the microphone here, the speech-to-text on the backend,
 * the words back as `dictation.update`. The box shows `heard` while it runs and takes the final words from `stop`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RpcError, RpcErrorCode } from '@atelier/protocol';
import { desktop } from '../../lib/platform.ts';
import { describeError, errorCode, rpc } from '../../lib/rpc.ts';
import { MicrophoneError, startCapture, type Capture } from './capture.ts';
import { savedMicrophone } from './microphones.ts';

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'finishing';

export interface DictationProblem {
  message: string;
  /** What helps: the system's microphone settings, Atelier's settings (`fix` is the page), or nothing. */
  help: 'microphone-settings' | 'settings' | null;
  fix?: string;
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

/** 100 ms of audio per call: ten calls a second. */
const SEND_SAMPLES = 1600;
/** A backlog goes a second at a time (a call takes two at most, `DICTATION_CHUNK_MAX_BYTES`). */
const MAX_SEND_SAMPLES = 16_000;

function base64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

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
  id: string | null;
  capture: Capture | null;
  seq: number;
  pending: Int16Array[];
  pendingSamples: number;
  heard: string;
  over: boolean;
  /** Settles once the microphone and the backend both answered (or one failed). */
  ready: Promise<boolean>;
  /** The one stop of this run: every caller (the button, Enter, the shortcut, a lost microphone) waits for the same. */
  stopping: Promise<string> | null;
}

export interface DictationOptions {
  /** `auto` or a two-letter code. */
  language: string;
  /** Words to spell as given. */
  hints?: readonly string[];
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

  /** It ended by itself (the backend dropped it): the words so far go to the box, and why it ended shows. */
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
        void rpc()
          .call('dictation.audio', { id, seq: r.seq++, pcm: base64(samples.subarray(0, take)) })
          .catch((e: unknown) => {
            if (run.current !== r || r.over) return;
            // Gone on the backend: it said why in an update, unless the connection itself dropped.
            if (errorCode(e) === 'not_found') endWith(r, { message: 'Dictation stopped: the connection to Atelier was interrupted.', help: null });
            else {
              void rpc().call('dictation.cancel', { id }).catch(() => undefined);
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
          return (await rpc().call('dictation.stop', { id: r.id })).text;
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

  // Updates that come before `dictation.start` has answered (a service that fails at once) wait for the id.
  const early = useRef(new Map<string, { text: string; error?: string | undefined }>());
  const apply = useCallback(
    (r: Run, update: { text: string; error?: string | undefined }) => {
      if (r.over) return;
      r.heard = update.text;
      setHeard(update.text);
      if (update.error) endWith(r, { message: update.error, help: null });
    },
    [endWith],
  );
  useEffect(
    () =>
      rpc().on('dictation.update', (update) => {
        const r = run.current;
        if (r && r.id === update.id) apply(r, update);
        else if (r && !r.id) {
          early.current.set(update.id, update);
          if (early.current.size > 20) early.current.delete(early.current.keys().next().value!);
        }
      }),
    [apply],
  );

  // A box that goes away takes its dictation with it (it kept the words: `onEnded` isn't for this).
  useEffect(
    () => () => {
      const r = run.current;
      if (!r) return;
      if (r.id) void rpc().call('dictation.cancel', { id: r.id }).catch(() => undefined);
      r.over = true;
      r.capture?.stop();
      run.current = null;
    },
    [],
  );

  const start = useCallback(async (): Promise<boolean> => {
    if (run.current) return false;
    let settle: (ok: boolean) => void = () => {};
    const r: Run = { id: null, capture: null, seq: 0, pending: [], pendingSamples: 0, heard: '', over: false, ready: new Promise((resolve) => (settle = resolve)), stopping: null };
    run.current = r;
    early.current.clear();
    setProblem(null);
    setHeard('');
    setPhase('starting');
    levels.reset();
    const fail = (error: unknown) => {
      if (!r.over) endWith(r, problemOf(error));
      settle(false);
      return false;
    };
    // macOS asks once for the app; the browser asks for the page in getUserMedia.
    if (desktop?.microphone && !(await desktop.microphone.ask().catch(() => true))) return fail(new MicrophoneError('denied', 'Atelier isn’t allowed to use the microphone.'));
    if (r.over) return fail(null);
    // The microphone first: however long the person takes to allow it, the backend's session doesn't wait idle meanwhile.
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
      answer = await rpc().call('dictation.start', { language, ...(hints.length ? { hints: [...hints] } : {}) });
    } catch (e) {
      r.capture.stop();
      return fail(e);
    }
    r.id = answer.id;
    if (r.over) {
      r.capture.stop();
      void rpc().call('dictation.cancel', { id: r.id }).catch(() => undefined);
      settle(false);
      return false;
    }
    setLive(answer.live);
    setPhase('listening');
    // What the microphone heard while the backend connected goes first, then whatever the service said meanwhile.
    send(r);
    settle(true);
    const waiting = early.current.get(r.id);
    early.current.clear();
    if (waiting) apply(r, waiting);
    return true;
  }, [apply, endWith, finalize, finish, levels, send]);

  const stop = useCallback(async (): Promise<string> => {
    const r = run.current;
    if (!r || r.over) return '';
    setPhase('finishing');
    const words = await finalize(r);
    finish(r);
    return words;
  }, [finalize, finish]);

  const cancel = useCallback(() => {
    const r = run.current;
    if (!r) return;
    const id = r.id;
    finish(r);
    if (id) void rpc().call('dictation.cancel', { id }).catch(() => undefined);
    // Still starting: the backend's answer is cancelled when it comes (`r.over`).
  }, [finish]);

  return { phase, heard, live, problem, clearProblem: useCallback(() => setProblem(null), []), levels, start, stop, cancel };
}
