/**
 * Shiki, loaded on first use with the JavaScript regex engine (no WASM). Languages and the syntax
 * themes chosen in Settings › Code are fetched lazily. Every token carries the colors of both themes
 * of the pair as CSS variables, so switching the app theme never re-highlights: code-block.css picks
 * `--shiki-light` or `--shiki-dark` from `<html data-theme>`.
 */
import type { CSSProperties } from 'react';
import type { GrammarState, HighlighterCore } from 'shiki/core';
import { bundledLanguages } from 'shiki/langs';
import { bundledThemes, bundledThemesInfo, type BundledTheme } from 'shiki/themes';
import type { SyntaxThemes } from '../../lib/theme.ts';
import { atelierDark, atelierLight } from './code-themes.ts';

export interface Token {
  content: string;
  style?: CSSProperties;
}
export type Line = Token[];

export interface SyntaxThemeInfo {
  id: string;
  label: string;
  type: 'light' | 'dark';
}

/** Our two themes first, then Shiki's bundled ones. */
export const SYNTAX_THEMES: readonly SyntaxThemeInfo[] = [
  { id: atelierLight.name!, label: atelierLight.displayName!, type: 'light' },
  { id: atelierDark.name!, label: atelierDark.displayName!, type: 'dark' },
  ...bundledThemesInfo.map((t) => ({ id: t.id, label: t.displayName, type: t.type })),
];

const known = new Set(SYNTAX_THEMES.map((t) => t.id));

/** The pair to highlight with: ids this build doesn't know fall back to the Atelier themes. */
export function resolveThemes(themes: SyntaxThemes): SyntaxThemes {
  return {
    light: known.has(themes.light) ? themes.light : atelierLight.name!,
    dark: known.has(themes.dark) ? themes.dark : atelierDark.name!,
  };
}

let highlighter: Promise<HighlighterCore> | null = null;
let ready: HighlighterCore | null = null;
/** `lang:<id>` and `theme:<id>` entries `tokenize` can use. The Atelier themes are built in. */
const loaded = new Set<string>([`theme:${atelierLight.name}`, `theme:${atelierDark.name}`]);
const loading = new Map<string, Promise<void>>();

/** The Shiki language id for a fence label, or null when we only show plain text. */
export function resolveLanguage(label: string): string | null {
  const lang = label.trim().toLowerCase();
  return lang && lang in bundledLanguages ? lang : null;
}

/** Whether `tokenize` can run synchronously for this language and theme pair. */
export function isLoaded(lang: string, themes: SyntaxThemes): boolean {
  return ready !== null && [`lang:${lang}`, `theme:${themes.light}`, `theme:${themes.dark}`].every((key) => loaded.has(key));
}

/** Runs one load on the highlighter, once per key; a failed load is tried again next time. */
function once(key: string, run: (h: HighlighterCore) => Promise<void>): Promise<void> {
  if (loaded.has(key)) return Promise.resolve();
  let pending = loading.get(key);
  if (!pending) {
    pending = highlighter!.then(async (h) => {
      await run(h);
      loaded.add(key);
    });
    pending.catch(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/** Loads the highlighter, one language and a resolved theme pair (Shiki's themes come in their own chunks). */
export async function load(lang: string, themes: SyntaxThemes): Promise<void> {
  highlighter ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(([core, engine]) =>
    core.createHighlighterCore({
      themes: [atelierLight, atelierDark],
      langs: [],
      engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
    }),
  );
  await Promise.all([
    once(`lang:${lang}`, (h) => h.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages])),
    ...[themes.light, themes.dark].map((id) => once(`theme:${id}`, (h) => h.loadTheme(bundledThemes[id as BundledTheme]))),
  ]);
  ready = await highlighter;
}

/** A loaded theme's own editor colors, for previews that show it on its background. */
export function themeColors(id: string): { fg: string; bg: string } | null {
  if (!ready || !loaded.has(`theme:${id}`)) return null;
  const { fg, bg } = ready.getTheme(id);
  return { fg, bg };
}

/** Tokenizes `code` (a loaded language) as lines, optionally resuming from a previous grammar state. */
function tokenize(
  code: string,
  lang: string,
  themes: SyntaxThemes,
  grammarState?: GrammarState,
): { lines: Line[]; state: GrammarState | undefined } {
  const result = ready!.codeToTokens(code, {
    lang,
    themes: { light: themes.light, dark: themes.dark },
    defaultColor: false,
    ...(grammarState ? { grammarState } : {}),
  });
  return {
    lines: result.tokens.map((line) =>
      line.map((t) =>
        t.htmlStyle ? { content: t.content, style: t.htmlStyle as CSSProperties } : { content: t.content },
      ),
    ),
    state: result.grammarState,
  };
}

export function plainLines(code: string): Line[] {
  return code.split('\n').map((content) => [{ content }]);
}

const settledCache = new Map<string, Line[]>();
const SETTLED_LIMIT = 200;

/**
 * Highlights a document that may still be growing (a streaming code fence). Complete lines are
 * tokenized once and kept; each update only tokenizes the newly completed lines, resuming from the
 * stored grammar state, plus the trailing partial line. Settled documents are cached across mounts.
 */
export class IncrementalHighlighter {
  private key = '';
  private prefix = '';
  private lines: Line[] = [];
  private state: GrammarState | undefined;

  highlight(code: string, lang: string, themes: SyntaxThemes, settled: boolean): Line[] {
    const key = `${lang}\0${themes.light}\0${themes.dark}`;
    const cached = settledCache.get(`${key}\0${code}`);
    if (cached) return cached;

    if (key !== this.key || !code.startsWith(this.prefix)) {
      this.key = key;
      this.prefix = '';
      this.lines = [];
      this.state = undefined;
    }
    const cut = code.lastIndexOf('\n') + 1;
    if (cut > this.prefix.length) {
      const added = tokenize(code.slice(this.prefix.length, cut - 1), lang, themes, this.state);
      this.lines = [...this.lines, ...added.lines];
      this.state = added.state;
      this.prefix = code.slice(0, cut);
    }
    const tail = code.slice(cut);
    const lines = tail ? [...this.lines, ...tokenize(tail, lang, themes, this.state).lines] : this.lines;
    if (settled) {
      if (settledCache.size >= SETTLED_LIMIT) settledCache.delete(settledCache.keys().next().value!);
      settledCache.set(`${key}\0${code}`, lines);
    }
    return lines;
  }
}
