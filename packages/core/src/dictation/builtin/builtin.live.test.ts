/**
 * Atelier's own speech model for real: fetches the engine (npm) and the model (Hugging Face) into
 * ATELIER_LIVE_SPEECH_DIR (kept between runs, so only the first one downloads ~720 MB), then dictates sentences macOS's
 * `say` speaks, through `DictationService`, as a window would: 100 ms at a time. Runs only with ATELIER_LIVE_SPEECH_DIR
 * set, on a Mac (for `say`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DictationUpdate } from '@atelier/protocol';
import { DictationService } from '../service.ts';
import { BuiltinSpeech } from './builtin.ts';

const dir = process.env.ATELIER_LIVE_SPEECH_DIR;

function speech(voice: string, sentence: string): Uint8Array {
  const tmp = mkdtempSync(join(tmpdir(), 'atelier-speech-'));
  execFileSync('say', ['-v', voice, '-o', join(tmp, 's.aiff'), sentence]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(tmp, 's.aiff'), join(tmp, 's.wav')]);
  const wav = readFileSync(join(tmp, 's.wav'));
  return new Uint8Array(wav.subarray(wav.indexOf('data') + 8));
}

const live = dir && process.platform === 'darwin' ? describe : describe.skip;

live('Atelier’s own speech model, live', () => {
  // Made only when it runs: a skipped suite's body is still read.
  const builtin = dir ? new BuiltinSpeech({ dir, log: (m) => console.log(m) }) : (null as unknown as BuiltinSpeech);
  const service = new DictationService<string>({
    settings: () => ({ enabled: true, text: [], media: [] }),
    credentials: async () => ({ headers: {} }),
    fetch: (url, init) => fetch(url, init),
    builtin,
    builtinWhere: 'Atelier',
  });

  it('downloads and checks the engine and the model, then says it is ready', async () => {
    const states: string[] = [];
    builtin.on('state', (s) => states.push(s.state));
    expect(service.status(true).source?.id).toBe('builtin');
    await builtin.prepare();
    expect(builtin.state()).toEqual({ state: 'ready' });
    expect(service.status(false).builtin).toEqual({ state: 'ready' });
  }, 1_800_000);

  for (const [language, voice, sentence, expected] of [
    ['en', 'Samantha', 'The next important feature is good dictation. It should write while I speak.', ['important feature', 'dictation', 'while I speak']],
    ['de', 'Anna', 'Die nächste wichtige Funktion ist eine gute Diktierfunktion. Sie soll mitschreiben, während ich spreche.', ['nächste wichtige Funktion', 'Diktierfunktion', 'während ich spreche']],
    ['auto', 'Anna', 'Guten Morgen, wie geht es dir heute?', ['Guten Morgen', 'heute']],
  ] as const) {
    it(`streams words while it hears them, and ends with the whole sentence (${language})`, async () => {
      const pcm = speech(voice, sentence);
      const updates: DictationUpdate[] = [];
      const { id, live: streams } = await service.start('window', 'me', { language }, (u) => updates.push(u));
      expect(streams).toBe(true);
      const t0 = Date.now();
      let seq = 0;
      for (let at = 0; at < pcm.byteLength; at += 3200) {
        service.audio('window', id, seq++, pcm.slice(at, at + 3200));
        await new Promise((r) => setTimeout(r, 25));
      }
      const before = updates.length;
      const { text } = await service.stop('window', id);
      console.log(language, `${updates.length} updates, final after ${Date.now() - t0} ms:`, text);
      expect(before).toBeGreaterThan(2);
      expect(updates.every((u) => !u.error)).toBe(true);
      for (const words of expected) expect(text.toLowerCase()).toContain(words.toLowerCase());
    }, 120_000);
  }
});
