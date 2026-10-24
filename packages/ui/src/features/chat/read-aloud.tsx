/**
 * Read aloud: a reply spoken by the computer's own voices (the browser's speech synthesis). Only voices on this
 * computer are used, so the text goes nowhere; a browser that has none (or only online ones) shows no button.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { Square, Volume2 } from 'lucide-react';
import { IconButton } from '../../components/ui/index.ts';

const synth = (): SpeechSynthesis | null => (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null);

/** The text of a Markdown reply as it should be heard: no code blocks, link targets, tables' rules or markup. */
export function speakableText(markdown: string): string {
  return (
    markdown
      // A code block, closed or still open at the end.
      .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, '')
      .replace(/\$\$[\s\S]*?\$\$/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<https?:[^>]+>|https?:\/\/\S+/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
      .replace(/\|/g, ', ')
      .replace(/(^|[^\p{L}\p{N}])(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\2(?![\p{L}\p{N}])/gu, '$1$3')
      .replace(/<[^>]+>/g, '')
      // Paragraphs and list items end where a line ends: a pause between them.
      .replace(/([^.!?:;,\s])\s*\n+/g, '$1.\n')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Pieces of at most about 200 characters, cut after a sentence where possible: long utterances stall in some engines. */
export function speechChunks(text: string, max = 200): string[] {
  const sentences = text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    for (const piece of sentence.length > max ? (sentence.match(new RegExp(`.{1,${max}}(?:\\s|$)`, 'g')) ?? [sentence]) : [sentence]) {
      if (current && current.length + piece.length > max) {
        chunks.push(current.trim());
        current = '';
      }
      current += piece;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Common short words of a few languages, to hear a German reply in a German voice on an English computer. */
const WORDS: Record<string, string[]> = {
  de: ['und', 'der', 'die', 'das', 'ist', 'nicht', 'ich', 'mit', 'ein', 'eine', 'auf', 'für', 'auch', 'sie', 'es'],
  fr: ['le', 'la', 'les', 'et', 'est', 'une', 'des', 'pas', 'pour', 'que', 'dans', 'avec', 'vous', 'je', 'il'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'una', 'que', 'para', 'con', 'por', 'pero', 'como', 'del', 'se'],
  it: ['il', 'la', 'che', 'di', 'è', 'una', 'per', 'non', 'con', 'sono', 'gli', 'della', 'anche', 'come', 'ma'],
  nl: ['de', 'het', 'een', 'en', 'is', 'niet', 'van', 'dat', 'met', 'voor', 'ook', 'zijn', 'je', 'ik', 'maar'],
  pt: ['o', 'a', 'os', 'que', 'é', 'um', 'uma', 'para', 'com', 'não', 'por', 'mais', 'como', 'mas', 'se'],
  en: ['the', 'and', 'is', 'of', 'to', 'in', 'that', 'it', 'for', 'with', 'you', 'this', 'are', 'not', 'on'],
};

/** The language a text is most likely in, by its common words; `fallback` when nothing stands out. */
export function guessLanguage(text: string, fallback: string): string {
  const words = text.toLowerCase().match(/\p{L}+/gu)?.slice(0, 400) ?? [];
  let best = '';
  let bestScore = 0;
  for (const [lang, common] of Object.entries(WORDS)) {
    const set = new Set(common);
    const score = words.filter((w) => set.has(w)).length;
    if (score > bestScore) [best, bestScore] = [lang, score];
  }
  return bestScore >= 3 && bestScore >= words.length * 0.05 ? best : fallback;
}

/** macOS's joke voices, and the robotic ones that come after any real voice. */
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Grandma|Grandpa)\b/;
const ROBOTIC = /^(Eddy|Flo|Reed|Rocko|Sandy|Shelley)\b/;

/** The best voice on this computer for a language ("de", "en-US"): its own region first, the better voices first. */
export function pickVoice(voices: readonly Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService' | 'default'>[], lang: string) {
  const base = lang.split('-')[0]!.toLowerCase();
  const score = (v: (typeof voices)[number]) => {
    const vl = v.lang.replace('_', '-').toLowerCase();
    if (!v.localService || NOVELTY.test(v.name) || vl.split('-')[0] !== base) return -1;
    return (vl === lang.toLowerCase() ? 4 : 0) + (/premium/i.test(v.name) ? 3 : /enhanced|natural|neural/i.test(v.name) ? 2 : 0) + (ROBOTIC.test(v.name) ? -3 : 1) + (v.default ? 1 : 0);
  };
  let best: (typeof voices)[number] | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const s = score(v);
    if (s > bestScore) [best, bestScore] = [v, s];
  }
  return best;
}

// One reply is read at a time, across the app.
let speaking: string | null = null;
const listeners = new Set<() => void>();
const setSpeaking = (key: string | null) => {
  speaking = key;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Voices load late in some browsers: whether any local one exists yet. */
function useHasVoices(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const s = synth();
      s?.addEventListener('voiceschanged', onChange);
      return () => s?.removeEventListener('voiceschanged', onChange);
    },
    () => !!synth()?.getVoices().some((v) => v.localService),
    () => false,
  );
}

export function stopReading(): void {
  synth()?.cancel();
  setSpeaking(null);
}

export function readAloud(key: string, markdown: string): void {
  const s = synth();
  if (!s) return;
  s.cancel();
  const text = speakableText(markdown);
  const lang = guessLanguage(text, navigator.language || 'en-US');
  const voice = pickVoice(s.getVoices(), lang) ?? pickVoice(s.getVoices(), navigator.language || 'en-US');
  const chunks = speechChunks(text);
  if (!voice || chunks.length === 0) return;
  setSpeaking(key);
  chunks.forEach((chunk, i) => {
    const u = new SpeechSynthesisUtterance(chunk);
    u.voice = voice as SpeechSynthesisVoice;
    u.lang = voice.lang;
    // Only the last piece (or a failure) ends it; a cancel for the next reply ends the earlier one's pieces with an error.
    if (i === chunks.length - 1) u.onend = () => speaking === key && setSpeaking(null);
    u.onerror = () => speaking === key && setSpeaking(null);
    s.speak(u);
  });
}

/** A reply's Read aloud button, Stop while it reads; nothing where the computer has no voice to read with. */
export function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const hasVoices = useHasVoices();
  const reading = useSyncExternalStore(subscribe, () => speaking === id, () => false);
  // A reply that leaves the screen (another conversation opened) stops being read.
  useEffect(() => () => void (speaking === id && stopReading()), [id]);
  if (!hasVoices || !text.trim()) return null;
  return reading ? (
    <IconButton icon={Square} label="Stop reading" size="xs" onClick={stopReading} />
  ) : (
    <IconButton icon={Volume2} label="Read aloud" size="xs" onClick={() => readAloud(id, text)} />
  );
}
