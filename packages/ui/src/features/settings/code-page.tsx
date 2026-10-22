import { useMemo } from 'react';
import type { TranscriptView, UserPrefs } from '@atelier/protocol';
import { SegmentedControl, Select, TextField, cn, type SegmentedControlItem, type SelectOption } from '../../components/ui/index.ts';
import { CodeLines, useHighlightedLines } from '../chat/code-block.tsx';
import { TRANSCRIPT_VIEWS } from '../chat/parts.tsx';
import { SYNTAX_THEMES, resolveThemes, themeColors } from '../chat/highlighter.ts';
import { ListRow } from './list-row.tsx';
import { RULE_EXAMPLE, ruleError } from './permission-rules.ts';
import { settingEntry } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useDraftText, usePref } from './use-setting.ts';

type InterfaceFont = UserPrefs['appearance']['interfaceFont'];

const INTERFACE_FONTS: SegmentedControlItem<InterfaceFont>[] = [
  { value: 'sans', label: 'Atelier Sans' },
  { value: 'system', label: 'System' },
  { value: 'dyslexic', label: 'OpenDyslexic' },
];

/** The person's own Code settings: how code looks, and the actions they always allow. */
export function CodePage() {
  const font = usePref<string>(['code', 'font']);
  const fontDraft = useDraftText(font);
  const interfaceFont = usePref<InterfaceFont>(['appearance', 'interfaceFont']);
  const transcriptView = usePref<TranscriptView>(['code', 'transcriptView']);
  const allow = usePref<string[]>(['permissions', 'allow']);
  const authorName = usePref<string>(['git', 'authorName']);
  const authorNameDraft = useDraftText(authorName);
  const authorEmail = usePref<string>(['git', 'authorEmail']);
  const authorEmailDraft = useDraftText(authorEmail);
  return (
    <>
      <SettingsSection id="code.syntaxTheme" title={settingEntry('code.syntaxTheme').label}>
        <div className="grid grid-cols-2 gap-4 pb-3">
          <SyntaxThemePicker type="light" />
          <SyntaxThemePicker type="dark" />
        </div>
        <SettingRow id="code.font" setting={font}>
          {(label) => <TextField {...label} {...fontDraft} placeholder="JetBrains Mono" spellCheck={false} autoComplete="off" className="w-[217px]" />}
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Appearance">
        <SettingRow id="appearance.interfaceFont" setting={interfaceFont}>
          {(label) => (
            <SegmentedControl {...label} items={INTERFACE_FONTS} value={interfaceFont.value} onValueChange={(v) => void interfaceFont.set(v)} />
          )}
        </SettingRow>
        <SettingRow id="code.transcriptView" setting={transcriptView}>
          {(label) => (
            <SegmentedControl {...label} items={TRANSCRIPT_VIEWS} value={transcriptView.value} onValueChange={(v) => void transcriptView.set(v)} />
          )}
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Permissions">
        <ListRow
          id="prefs.permissions.allow"
          setting={allow}
          validate={ruleError}
          fieldLabel="New always-allowed rule"
          placeholder={RULE_EXAMPLE}
          empty="None yet. Choosing “Always allow” on a permission prompt adds one here, or add a rule yourself."
        />
      </SettingsSection>
      <SettingsSection title="Git">
        <SettingRow id="git.authorName" setting={authorName}>
          {(label) => <TextField {...label} {...authorNameDraft} placeholder="From git config" autoComplete="name" className="w-[217px]" />}
        </SettingRow>
        <SettingRow id="git.authorEmail" setting={authorEmail}>
          {(label) => <TextField {...label} {...authorEmailDraft} type="email" placeholder="From git config" autoComplete="email" className="w-[217px]" />}
        </SettingRow>
      </SettingsSection>
    </>
  );
}

const themeOptions = (type: 'light' | 'dark'): SelectOption[] =>
  SYNTAX_THEMES.filter((t) => t.type === type).map((t) => ({ value: t.id, label: t.label }));
const THEME_OPTIONS = { light: themeOptions('light'), dark: themeOptions('dark') };

/** One of the pair: a theme of that kind, previewed below on its own background. */
function SyntaxThemePicker({ type }: { type: 'light' | 'dark' }) {
  const setting = usePref<string>(['code', 'syntaxTheme', type]);
  // A theme this build doesn't know shows as the Atelier one of its kind, as code blocks use it.
  const theme = resolveThemes({ light: setting.value, dark: setting.value })[type];
  const name = type === 'light' ? 'Light theme' : 'Dark theme';
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Select aria-label={name} variant="field" options={THEME_OPTIONS[type]} value={theme} onValueChange={(v) => void setting.set(v)} />
      <DiffPreview theme={theme} label={`${name} preview`} />
      {setting.error && (
        <p role="alert" className="text-body text-danger-text">
          {setting.error}
        </p>
      )}
    </div>
  );
}

const SAMPLE = ['function greet(name: string) {', "  return 'Hello, ' + name;", '  return `Hello, ${name}!`;', '}'].join('\n');
const SAMPLE_DIFF = [
  { number: 1, mark: ' ' },
  { number: 2, mark: '-' },
  { number: 2, mark: '+' },
  { number: 3, mark: ' ' },
] as const;

/** A small edit in one theme, whatever the app theme is: mono 13/19, line numbers, +/− rows (InlineDiff). */
function DiffPreview({ theme, label }: { theme: string; label: string }) {
  const pair = useMemo(() => ({ light: theme, dark: theme }), [theme]);
  const lines = useHighlightedLines(SAMPLE, 'ts', true, pair);
  const colors = themeColors(theme);
  return (
    <figure
      aria-label={label}
      className="at-code overflow-hidden rounded-lg border border-line bg-code-background py-2 font-mono text-code text-fg [font-variant-ligatures:none]"
      style={colors ? { backgroundColor: colors.bg, color: colors.fg } : undefined}
    >
      {lines.map((line, i) => {
        const { number, mark } = SAMPLE_DIFF[i]!;
        const tone = mark === '-' ? 'text-diff-removed-text' : mark === '+' ? 'text-diff-added-text' : 'text-fg-muted';
        return (
          <div key={i} className={cn('flex pr-3', mark === '-' && 'bg-diff-removed-bg', mark === '+' && 'bg-diff-added-bg')}>
            <span className={cn('w-[38px] shrink-0 text-right select-none', tone)}>{number}</span>
            <span className={cn('w-6 shrink-0 pl-2.5 select-none', tone)}>{mark}</span>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">
              <CodeLines lines={[line]} />
            </span>
          </div>
        );
      })}
    </figure>
  );
}
