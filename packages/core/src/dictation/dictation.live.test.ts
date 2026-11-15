/**
 * Dictation against Mistral for real: the realtime service through `DictationService`, and Mistral's
 * /v1/audio/transcriptions (OpenAI's format) through the phrase engine. Skipped unless `MISTRAL_API_KEY` is set (the
 * environment, or `.env.local` as for providers/live.test.ts) and this is a Mac, whose `say` speaks the test sentence.
 * The key is only passed to the service; nothing here prints it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DictationUpdate } from '@atelier/protocol';
import { DictationService } from './service.ts';
import { openPhrases } from './phrases.ts';
import { transcribe } from './transcribe.ts';

function envFile(): Record<string, string> {
  let file = join(import.meta.dirname, '../../../../.env.local');
  if (!existsSync(file)) {
    try {
      const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
      file = join(dirname(common), '.env.local');
    } catch {
      return {};
    }
  }
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2')]),
  );
}

const key = process.env.MISTRAL_API_KEY || envFile().MISTRAL_API_KEY;
const SENTENCE = 'The next important feature is good transcription. Dictation should work with live text while I speak.';

/** The sentence, spoken by macOS, as 16 kHz mono s16le PCM. */
function speech(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-dictation-'));
  execFileSync('say', ['-o', join(dir, 'speech.aiff'), SENTENCE]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, 'speech.aiff'), join(dir, 'speech.wav')]);
  const wav = readFileSync(join(dir, 'speech.wav'));
  // afconvert writes a plain 44-byte header, sometimes with a FLLR chunk: the data starts after "data" and its size.
  const at = wav.indexOf('data') + 8;
  return new Uint8Array(wav.subarray(at));
}

const live = key && process.platform === 'darwin' ? describe : describe.skip;

live('dictation with Mistral, live', () => {
  it('streams words while the audio plays, and ends with the whole sentence (realtime)', async () => {
    const pcm = speech();
    const updates: DictationUpdate[] = [];
    const service = new DictationService<string>({
      settings: () => ({ enabled: true, text: [{ id: 'mistral', type: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai', headers: {}, enabled: true }], media: [] }),
      credentials: async () => ({ apiKey: key!, headers: {} }),
      fetch: (url, init) => fetch(url, init),
    });
    const { id, live: streams } = await service.start('window', 'me', { language: 'en' }, (u) => updates.push(u));
    expect(streams).toBe(true);
    let seq = 0;
    // 100 ms at a time, twice as fast as spoken, then a second of silence.
    for (let at = 0; at < pcm.byteLength; at += 3200) {
      service.audio('window', id, seq++, pcm.slice(at, at + 3200));
      await new Promise((r) => setTimeout(r, 50));
    }
    for (let i = 0; i < 10; i++) service.audio('window', id, seq++, new Uint8Array(3200));
    const before = updates.length;
    const { text } = await service.stop('window', id);
    expect(before).toBeGreaterThan(3);
    expect(updates.every((u) => !u.error)).toBe(true);
    expect(text.toLowerCase()).toContain('transcription');
    expect(text.toLowerCase()).toContain('live text');
  }, 60_000);

  it('hears a phrase at a time through /v1/audio/transcriptions', async () => {
    const pcm = speech();
    const seen: string[] = [];
    const engine = openPhrases({
      onText: (t) => seen.push(t),
      onError: (m) => {
        throw new Error(m);
      },
      transcribe: (wav, before, signal) =>
        transcribe({ dialect: 'openai', baseUrl: 'https://api.mistral.ai', apiKey: key, headers: {}, model: 'voxtral-mini-transcribe-3', name: 'Mistral', wav, language: 'en', before, hints: [], fetch: (u, i) => fetch(u, i), signal }),
    });
    for (let at = 0; at < pcm.byteLength; at += 3200) {
      engine.write(pcm.slice(at, at + 3200));
      await new Promise((r) => setTimeout(r, 100));
    }
    engine.write(new Uint8Array(32_000));
    const text = await engine.finish();
    expect(seen.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain('transcription');
    expect(text.toLowerCase()).toContain('live text');
  }, 90_000);
});
