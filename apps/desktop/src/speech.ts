/**
 * Dictation with the Mac's own speech recognition (ARCHITECTURE §27): one `atelier-speech` helper per dictation, JSON
 * lines over its stdio (native/computer-macos/Sources/atelier-speech). The window records and sends the sound here;
 * the words go back to that window only. Nothing leaves the Mac.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync } from 'node:fs';

export type SpeechUpdate = { id: number; text: string } | { id: number; preparing: number } | { id: number; error: string; code: string };

interface Running {
  child: ChildProcessByStdio<Writable, Readable, null>;
  owner: number;
  final?: (text: string) => void;
  text: string;
  /** It ended without being asked; its words wait for the window's stop. */
  exited?: boolean;
}

export class MacSpeech {
  private running = new Map<number, Running>();
  private nextId = 1;
  private probe: Promise<{ available: boolean; locales: string[] }> | null = null;

  constructor(
    private readonly helper: string | null,
    private readonly send: (owner: number, update: SpeechUpdate) => void,
  ) {}

  /** Whether this Mac can dictate on its own (macOS 26 or later, the helper there), and in which languages. */
  available(): Promise<{ available: boolean; locales: string[] }> {
    const helper = this.helper;
    if (process.platform !== 'darwin' || !helper || !existsSync(helper)) return Promise.resolve({ available: false, locales: [] });
    this.probe ??= new Promise((resolve) => {
      const child = spawn(helper, ['--probe'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      const timer = setTimeout(() => child.kill(), 10_000);
      child.on('exit', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(out) as { available?: boolean; locales?: string[] };
          resolve({ available: parsed.available === true, locales: parsed.locales ?? [] });
        } catch {
          resolve({ available: false, locales: [] });
        }
      });
      child.on('error', () => resolve({ available: false, locales: [] }));
    });
    return this.probe;
  }

  /**
   * Starts listening for a window (`owner`, its webContents id). Resolves once the helper listens (after the system
   * fetched the language's model, the first time); rejects with the helper's code: `unsupported` means the Mac doesn't
   * know the language, so the window dictates through Atelier's backend instead.
   */
  start(owner: number, language: string): Promise<{ id: number; locale: string }> {
    const helper = this.helper;
    if (!helper) return Promise.reject(Object.assign(new Error('The Mac’s dictation helper is missing.'), { code: 'unavailable' }));
    const id = this.nextId++;
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const run: Running = { child, owner, text: '' };
    this.running.set(id, run);
    return new Promise((resolve, reject) => {
      let started = false;
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        for (let at; (at = buffer.indexOf('\n')) >= 0; ) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          let message: { type?: string; text?: string; fraction?: number; locale?: string; code?: string; message?: string };
          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            continue;
          }
          if (message.type === 'ready') {
            started = true;
            resolve({ id, locale: message.locale ?? '' });
          } else if (message.type === 'preparing') this.send(owner, { id, preparing: message.fraction ?? 0 });
          else if (message.type === 'text') {
            run.text = message.text ?? '';
            this.send(owner, { id, text: run.text });
          } else if (message.type === 'final') run.final?.(message.text ?? run.text);
          else if (message.type === 'error') {
            const error = Object.assign(new Error(message.message ?? 'The Mac’s dictation failed.'), { code: message.code ?? 'failed' });
            if (!started) reject(error);
            else this.send(owner, { id, error: error.message, code: error.code });
          }
        }
      });
      child.on('error', (e) => {
        this.running.delete(id);
        if (!started) reject(Object.assign(e, { code: 'unavailable' }));
      });
      child.on('exit', () => {
        const gone = this.running.get(id);
        if (!started) {
          this.running.delete(id);
          reject(Object.assign(new Error('The Mac’s dictation stopped before it started.'), { code: 'failed' }));
        } else if (gone?.final) {
          this.running.delete(id);
          gone.final(gone.text);
        } else if (gone) {
          // Ended without being asked (it crashed): the window hears why, and its stop gets what was heard.
          gone.exited = true;
          this.send(owner, { id, error: 'The Mac’s speech recognition stopped unexpectedly.', code: 'failed' });
        }
      });
      child.stdin.on('error', () => undefined);
      child.stdin.write(`${JSON.stringify({ type: 'start', language })}\n`);
    });
  }

  audio(owner: number, id: number, pcm: Uint8Array): void {
    const run = this.running.get(id);
    if (!run || run.owner !== owner || run.child.stdin.destroyed) return;
    run.child.stdin.write(`${JSON.stringify({ type: 'audio', pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') })}\n`);
  }

  /** Stops listening and resolves with everything said, once the helper heard the rest. */
  stop(owner: number, id: number): Promise<string> {
    const run = this.running.get(id);
    if (!run || run.owner !== owner) return Promise.resolve('');
    if (run.exited) {
      this.running.delete(id);
      return Promise.resolve(run.text);
    }
    return new Promise((resolve) => {
      // The helper gives the last words within about four seconds; past six it is ended and what came is the answer.
      const timer = setTimeout(() => {
        run.child.kill();
        resolve(run.text);
      }, 6000);
      run.final = (text) => {
        clearTimeout(timer);
        resolve(text);
      };
      run.child.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`);
    });
  }

  cancel(owner: number, id: number): void {
    const run = this.running.get(id);
    if (!run || run.owner !== owner) return;
    this.running.delete(id);
    if (!run.exited) run.child.kill();
  }

  /** A window went away, or the app quits. */
  closeOwner(owner: number): void {
    for (const [id, run] of this.running) if (run.owner === owner) this.cancel(owner, id);
  }

  closeAll(): void {
    for (const [, run] of this.running) run.child.kill();
    this.running.clear();
  }
}
