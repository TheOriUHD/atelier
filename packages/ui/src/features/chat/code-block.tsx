import { Fragment, memo, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { Play } from 'lucide-react';
import { IconButton, cn } from '../../components/ui/index.ts';
import { useSyntaxThemes, type SyntaxThemes } from '../../lib/theme.ts';
import { CopyButton } from './copy-button.tsx';
import { IncrementalHighlighter, isLoaded, load, plainLines, resolveLanguage, resolveThemes, type Line } from './highlighter.ts';
import { RunInTerminal, isShellLanguage } from './run-in-terminal.ts';
import './code-block.css';

/**
 * Highlighted lines of `code` in the person's syntax themes (or `themes`); plain lines until the
 * language and themes have loaded. While `settled` is false the code is still streaming, and only
 * newly completed lines are tokenized on each update.
 */
export function useHighlightedLines(code: string, language: string, settled: boolean, themes?: SyntaxThemes): Line[] {
  const lang = resolveLanguage(language);
  const chosen = useSyntaxThemes();
  const { light, dark } = resolveThemes(themes ?? chosen);
  const [highlighter] = useState(() => new IncrementalHighlighter());
  const [, loaded] = useReducer((n: number) => n + 1, 0);
  const ready = lang !== null && isLoaded(lang, { light, dark });
  useEffect(() => {
    if (lang && !ready) load(lang, { light, dark }).then(loaded, () => {});
  }, [lang, light, dark, ready]);
  return useMemo(
    () => (ready ? highlighter.highlight(code, lang, { light, dark }, settled) : plainLines(code)),
    [highlighter, code, lang, light, dark, ready, settled],
  );
}

/** One highlighted line; token colors come from code-block.css (inside an `.at-code` container). */
export const LineView = memo(function LineView({ line }: { line: Line }) {
  return (
    <span className="line">
      {line.map((t, i) =>
        t.style ? (
          <span key={i} style={t.style}>
            {t.content}
          </span>
        ) : (
          t.content
        ),
      )}
    </span>
  );
});

/** Lines keyed by index, so a streaming block only mounts (and fades in) the lines that are new. */
export function CodeLines({ lines }: { lines: Line[] }) {
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && '\n'}
      <LineView line={line} />
    </Fragment>
  ));
}

/** Code block chrome per design/components.md › CodeBlock: r12, 0.5px border, 32px header, actions on hover. */
export function CodeFrame({ label, actions, children }: { label: string; actions: ReactNode; children: ReactNode }) {
  return (
    <div
      data-prose-block
      className="at-code group/code relative min-w-0 rounded-2xl border-[0.5px] border-line bg-code-background"
    >
      <div className="flex h-8 items-end px-3.5 font-sans text-caption text-fg-muted">{label}</div>
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity duration-(--at-duration-snap) ease-out group-focus-within/code:opacity-100 group-hover/code:opacity-100">
        {actions}
      </div>
      {children}
    </div>
  );
}

export function CodePre({
  lines,
  streaming,
  lineNumbers,
  className,
}: {
  lines: Line[];
  streaming: boolean;
  lineNumbers?: boolean;
  className?: string;
}) {
  return (
    // Long lines scroll sideways: the block is focusable so the keyboard can scroll it (WCAG 2.1.1).
    <pre
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      data-streaming={streaming || undefined}
      data-line-numbers={lineNumbers || undefined}
      className={cn(
        'overflow-x-auto p-3.5 font-mono text-code-block text-fg outline-none focus-visible:shadow-focus [font-variant-ligatures:none] [tab-size:4]',
        className,
      )}
    >
      <CodeLines lines={lines} />
    </pre>
  );
}

export function CodeBlock({ code, language, streaming }: { code: string; language: string; streaming: boolean }) {
  const lines = useHighlightedLines(code, language, !streaming);
  const run = useContext(RunInTerminal);
  return (
    <CodeFrame
      label={language}
      actions={
        <>
          {run && !streaming && code.trim() && isShellLanguage(language) && <IconButton icon={Play} label="Run in terminal" size="sm" onClick={() => run(code)} />}
          <CopyButton text={code} size="sm" label="Copy code" />
        </>
      }
    >
      <CodePre lines={lines} streaming={streaming} />
    </CodeFrame>
  );
}
