import { describe, expect, it } from 'vitest';
import colors from '../../../theme/colors.json';
import { atelierDark, atelierLight, buildCodeTheme, type CodePalette } from './code-themes.ts';
import { IncrementalHighlighter, SYNTAX_THEMES, load, resolveThemes, themeColors } from './highlighter.ts';

type Rule = { scope: string[]; settings: { foreground: string; fontStyle?: string } };
const rules = (theme: ReturnType<typeof buildCodeTheme>) => theme.tokenColors as Rule[];
const ruleFor = (theme: ReturnType<typeof buildCodeTheme>, scope: string) =>
  rules(theme).find((r) => r.scope.includes(scope))!.settings;

describe('buildCodeTheme', () => {
  it('builds Atelier Light and Atelier Dark from the token colors only', () => {
    for (const [theme, palette, type] of [
      [atelierLight, colors.light, 'light'],
      [atelierDark, colors.dark, 'dark'],
    ] as const) {
      expect(theme.type).toBe(type);
      const tokenValues = new Set<string>(Object.values(palette));
      const used = [theme.fg!, theme.bg!, ...rules(theme).map((r) => r.settings.foreground)];
      for (const color of used) {
        expect(tokenValues).toContain(color);
        // TextMate only accepts hex colors for token rules.
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
    expect([atelierLight.name, atelierDark.name]).toEqual(['atelier-light', 'atelier-dark']);
    expect([atelierLight.displayName, atelierDark.displayName]).toEqual(['Atelier Light', 'Atelier Dark']);
  });

  it('maps syntax roles to token roles', () => {
    const palette = Object.fromEntries(
      [
        'background',
        'text-primary',
        'text-secondary',
        'interactive-text',
        'warning-text',
        'danger-text',
        'diff-added',
        'diff-removed',
        'diff-modified',
        'code-keyword',
        'code-type',
        'code-string',
        'code-comment',
      ].map((role, i) => [role, `#00000${i.toString(16)}`]),
    ) as CodePalette;
    const theme = buildCodeTheme('test', 'Test', 'dark', palette);
    expect(theme.fg).toBe(palette['text-primary']);
    expect(ruleFor(theme, 'keyword').foreground).toBe(palette['code-keyword']);
    expect(ruleFor(theme, 'string').foreground).toBe(palette['code-string']);
    expect(ruleFor(theme, 'comment')).toEqual({ foreground: palette['code-comment'], fontStyle: 'italic' });
    expect(ruleFor(theme, 'entity.name.function').foreground).toBe(palette['interactive-text']);
    expect(ruleFor(theme, 'constant.numeric').foreground).toBe(palette['warning-text']);
    expect(ruleFor(theme, 'markup.inserted').foreground).toBe(palette['diff-added']);
  });
});

const ATELIER = { light: 'atelier-light', dark: 'atelier-dark' };
const keyword = (line: { content: string; style?: object }[] | undefined) => line!.find((t) => t.content === 'const')!.style;

describe('IncrementalHighlighter', () => {
  it('colors tokens for both themes at once', async () => {
    await load('ts', ATELIER);
    const [line] = new IncrementalHighlighter().highlight('const answer = 42;', 'ts', ATELIER, true);
    expect(keyword(line)).toMatchObject({ '--shiki-light': colors.light['code-keyword'], '--shiki-dark': colors.dark['code-keyword'] });
  });

  it('loads a chosen pair of Shiki themes on demand, with their own colors', async () => {
    const themes = { light: 'github-light', dark: 'one-dark-pro' };
    expect(themeColors('github-light')).toBeNull();
    await load('ts', themes);
    const [line] = new IncrementalHighlighter().highlight('const answer = 42;', 'ts', themes, true);
    expect(keyword(line)).toMatchObject({ '--shiki-light': '#D73A49', '--shiki-dark': '#C678DD' });
    expect(themeColors('one-dark-pro')).toEqual({ fg: expect.any(String), bg: '#282c34' });
  });

  it('lists the Atelier themes first and falls back to them for ids it does not know', () => {
    expect(SYNTAX_THEMES.slice(0, 2)).toEqual([
      { id: 'atelier-light', label: 'Atelier Light', type: 'light' },
      { id: 'atelier-dark', label: 'Atelier Dark', type: 'dark' },
    ]);
    expect(SYNTAX_THEMES.find((t) => t.id === 'solarized-light')?.type).toBe('light');
    expect(resolveThemes({ light: 'retired-theme', dark: 'dracula' })).toEqual({ light: 'atelier-light', dark: 'dracula' });
  });

  it('streams to the same result as highlighting the whole document, keeping finished lines', async () => {
    await load('ts', ATELIER);
    // A template literal spanning lines: the grammar state has to carry across chunks.
    const source = 'const a = `one\n${two}\nthree`;\n\n// done\nlet b = 1;';
    const streaming = new IncrementalHighlighter();
    let lines = streaming.highlight('', 'ts', ATELIER, false);
    let firstLine = undefined as unknown;
    for (let i = 1; i <= source.length; i++) {
      lines = streaming.highlight(source.slice(0, i), 'ts', ATELIER, false);
      if (source[i - 1] === '\n' && !firstLine) firstLine = lines[0];
    }
    expect(lines).toEqual(new IncrementalHighlighter().highlight(source, 'ts', ATELIER, true));
    expect(lines).toHaveLength(6);
    // Completed lines are tokenized once and reused, not re-highlighted on every update.
    expect(lines[0]).toBe(firstLine);
  });
});
