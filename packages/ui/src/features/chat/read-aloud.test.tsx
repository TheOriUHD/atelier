import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/index.ts';
import { ReadAloudButton, guessLanguage, pickVoice, speakableText, speechChunks } from './read-aloud.tsx';

const voice = (name: string, lang: string, extra: Partial<SpeechSynthesisVoice> = {}) =>
  ({ name, lang, localService: true, default: false, voiceURI: name, ...extra }) as SpeechSynthesisVoice;

describe('what is read', () => {
  it('reads the words, not the markup, code, links or tables’ rules', () => {
    const md = [
      '## The plan',
      'Use **bold** ideas and a [link](https://example.com) with `inline code` in my_file_name.',
      '',
      '```ts',
      'const secret = 1;',
      '```',
      '- First point',
      '- Second point',
      '',
      '| Name | Size |',
      '| --- | --- |',
      '| a | 1 |',
      'See https://example.com/page for more.',
    ].join('\n');
    const text = speakableText(md);
    expect(text).toContain('The plan.');
    expect(text).toContain('Use bold ideas and a link with inline code in my_file_name.');
    expect(text).toContain('First point. Second point.');
    expect(text).not.toMatch(/secret|```|\*\*|https|---|#/);
    // A code block still open at the end of a streamed reply is left out too.
    expect(speakableText('Here:\n```js\nlet x')).toBe('Here:');
  });

  it('cuts long text after sentences, and a sentence too long for one piece at spaces', () => {
    expect(speechChunks('One. Two. Three.', 10)).toEqual(['One. Two.', 'Three.']);
    const long = `${'word '.repeat(60).trim()}.`;
    const pieces = speechChunks(long, 50);
    expect(pieces.every((p) => p.length <= 50)).toBe(true);
    expect(pieces.join(' ')).toBe(long);
  });

  it('hears a German reply in German on an English computer, and falls back when nothing stands out', () => {
    expect(guessLanguage('Das ist nicht die Antwort, die ich mit dir besprochen habe, und es ist auch nicht schlimm.', 'en-US')).toBe('de');
    expect(guessLanguage('This is the answer that you asked for, and it is not long.', 'de-DE')).toBe('en');
    expect(guessLanguage('OK', 'en-US')).toBe('en-US');
  });

  it("picks a real voice of the language, the region's and better ones first, never a joke or an online voice", () => {
    const voices = [
      voice('Albert', 'en-US', { default: true }),
      voice('Eddy (English (United States))', 'en-US'),
      voice('Daniel', 'en-GB'),
      voice('Samantha', 'en-US'),
      voice('Evan (Enhanced)', 'en-US'),
      voice('Google US English', 'en-US', { localService: false }),
      voice('Anna', 'de-DE'),
    ];
    expect(pickVoice(voices, 'en-US')?.name).toBe('Evan (Enhanced)');
    expect(pickVoice(voices, 'en-GB')?.name).toBe('Daniel');
    expect(pickVoice(voices, 'de')?.name).toBe('Anna');
    expect(pickVoice([voice('Albert', 'en-US'), voice('Google US English', 'en-US', { localService: false })], 'en-US')).toBeNull();
  });
});

describe('Read aloud', () => {
  const speak = vi.fn();
  const cancel = vi.fn();
  let voices: SpeechSynthesisVoice[] = [];
  let changed: (() => void) | undefined;

  beforeEach(() => {
    speak.mockReset();
    cancel.mockReset();
    voices = [voice('Samantha', 'en-US')];
    vi.stubGlobal('speechSynthesis', {
      speak,
      cancel,
      getVoices: () => voices,
      addEventListener: (_: string, l: () => void) => void (changed = l),
      removeEventListener: () => {},
    });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        voice: SpeechSynthesisVoice | null = null;
        lang = '';
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(public text: string) {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const show = () =>
    render(
      <TooltipProvider>
        <ReadAloudButton id="m1" text={'First sentence here. Second one.\n\n```\ncode\n```'} />
      </TooltipProvider>,
    );

  it('reads a reply with a voice of this computer, and stops', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
    expect(speak).toHaveBeenCalledTimes(1);
    const utterance = speak.mock.calls[0]![0] as { text: string; voice: SpeechSynthesisVoice; onend(): void };
    expect(utterance.text).toBe('First sentence here. Second one.');
    expect(utterance.voice.name).toBe('Samantha');

    fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
    expect(cancel).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeTruthy();

    // Read to the end, it offers Read aloud again by itself.
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
    act(() => (speak.mock.calls.at(-1)![0] as { onend(): void }).onend());
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeTruthy();
  });

  it('shows no button until the computer has a voice, and stops reading when the reply leaves the screen', () => {
    voices = [];
    const view = show();
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull();
    voices = [voice('Samantha', 'en-US')];
    act(() => changed?.());
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
    cancel.mockReset();
    view.unmount();
    expect(cancel).toHaveBeenCalled();
  });
});
