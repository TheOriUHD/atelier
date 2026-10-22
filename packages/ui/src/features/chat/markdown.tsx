/**
 * Assistant prose on Streamdown. Streamdown's own renderers are styled for shadcn variables we do not
 * have, so every visible element is ours: typography in markdown.css, blocks as components here.
 */
import { createContext, createElement, lazy, memo, Suspense, useContext, useDeferredValue, useState, type ComponentProps } from 'react';
import { Code2, Workflow } from 'lucide-react';
import remarkMath from 'remark-math';
import { protectCurrency } from './currency.ts';
import { unescapeTags } from '@atelier/protocol';
import {
  defaultRemarkPlugins,
  Streamdown,
  useIsCodeFenceIncomplete,
  type AnimateOptions,
  type Components,
  type ExtraProps,
} from 'streamdown';
import { IconButton } from '../../components/ui/index.ts';
import { openExternal } from '../../lib/platform.ts';
import { useResolvedTheme } from '../../lib/theme.ts';
import { CodeBlock, CodeFrame, CodePre, useHighlightedLines } from './code-block.tsx';
import { CopyButton } from './copy-button.tsx';
import { ZoomableImage } from './images.tsx';
import './markdown.css';

const Katex = lazy(() => import('./katex.tsx'));
const MermaidDiagram = lazy(() => import('./mermaid-diagram.tsx'));

type HastNode = { type: string; value?: string; children?: HastNode[] };

/** Source text of a node. Inline code may already be split into animated word spans, so read the tree. */
const textOf = (node: HastNode | undefined): string =>
  node ? (node.value ?? node.children?.map(textOf).join('') ?? '') : '';

const languageOf = (className: string | undefined) => /\blanguage-(\S+)/.exec(className ?? '')?.[1] ?? '';

function MathTex({ tex, display }: { tex: string; display: boolean }) {
  const fallback = <code className="font-mono text-[0.875em]">{tex}</code>;
  const katex = (
    <Suspense fallback={fallback}>
      <Katex tex={tex} display={display} />
    </Suspense>
  );
  return display ? (
    // Room above and below: limits and fractions draw outside the line box, and the scroller would clip them.
    <div data-prose-block className="overflow-x-auto overflow-y-hidden py-2">
      {katex}
    </div>
  ) : (
    katex
  );
}

function MermaidBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const [showSource, setShowSource] = useState(false);
  const theme = useDeferredValue(useResolvedTheme());
  const lines = useHighlightedLines(source, 'mermaid', !streaming);
  const diagram = !streaming && !showSource;
  return (
    <CodeFrame
      label="mermaid"
      actions={
        <>
          {!streaming && (
            <IconButton
              icon={diagram ? Code2 : Workflow}
              label={diagram ? 'Show source' : 'Show diagram'}
              size="sm"
              onClick={() => setShowSource((s) => !s)}
            />
          )}
          <CopyButton text={source} size="sm" label="Copy source" />
        </>
      }
    >
      {diagram ? (
        <Suspense fallback={<div className="mx-3.5 mb-3.5 h-40 rounded-lg bg-skeleton" />}>
          <MermaidDiagram source={source} theme={theme} />
        </Suspense>
      ) : (
        <CodePre lines={lines} streaming={streaming} />
      )}
    </CodeFrame>
  );
}

/** Fenced code: Streamdown hands us the `<code>` of every `<pre>`. */
function Code({ node, className }: ComponentProps<'code'> & ExtraProps) {
  const streaming = useIsCodeFenceIncomplete();
  const language = languageOf(className);
  const code = textOf(node).replace(/\n$/, '');
  if (language === 'math') return <MathTex tex={code} display />;
  if (language === 'mermaid') return <MermaidBlock source={code} streaming={streaming} />;
  return <CodeBlock code={code} language={language} streaming={streaming} />;
}

/**
 * Opens a file the conversation names in the Files pane (Code sessions); null elsewhere. Inline code that reads as a
 * path (`src/app.ts`, `package.json`) becomes a button that opens it.
 */
export const OpenFilePath = createContext<((path: string) => void) | null>(null);

const FILE_EXTENSION =
  /\.(tsx?|jsx?|mjs|cjs|json|jsonc|md|mdx|txt|css|scss|html?|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|ya?ml|toml|ini|lock|sql|vue|svelte|xml|svg|png|jpe?g|gif|webp|env|gitignore|dockerignore|mod|sum|gradle|tf|proto|graphql|csv)$/i;

/** Inline code that names a file: only path characters, and a folder in it or a file extension it ends with. */
export const looksLikePath = (text: string): boolean =>
  text.length <= 300 && /^[\w@~./-]+$/.test(text) && !text.includes('//') && !/^\.+$/.test(text) && (/[\w-]\/[\w.@-]/.test(text) || FILE_EXTENSION.test(text));

function InlineCode({ node, className, children }: ComponentProps<'code'> & ExtraProps) {
  const openPath = useContext(OpenFilePath);
  if (languageOf(className) === 'math') return <MathTex tex={textOf(node)} display={false} />;
  const text = textOf(node);
  if (openPath && looksLikePath(text))
    return (
      <button
        type="button"
        title="Open in Files"
        onClick={() => openPath(text)}
        className="rounded-xs bg-code-inline-background px-1 py-px font-mono text-[0.875em] text-interactive-text outline-none [font-variant-ligatures:none] focus-ring hover:underline"
      >
        {children}
      </button>
    );
  return (
    <code className="rounded-xs bg-code-inline-background px-1 py-px font-mono text-[0.875em] [font-variant-ligatures:none]">
      {children}
    </code>
  );
}

function Link({ node: _node, href, children, ...props }: ComponentProps<'a'> & ExtraProps) {
  const external = !!href && /^(https?:|mailto:)/i.test(href);
  return (
    <a
      {...props}
      href={href === 'streamdown:incomplete-link' ? undefined : href}
      onClick={
        external
          ? (e) => {
              e.preventDefault();
              openExternal(href);
            }
          : undefined
      }
    >
      {children}
    </a>
  );
}

/** Renders the element without Streamdown's (shadcn) classes; markdown.css styles it. */
const plain = (tag: string) =>
  function Plain({ node: _node, ...props }: { node?: unknown }) {
    return createElement(tag, props);
  };

const components: Components = {
  code: Code,
  inlineCode: InlineCode,
  a: Link,
  img: ({ node: _node, alt, src }) => (typeof src === 'string' && src ? <ZoomableImage group={[{ src, alt: alt ?? '' }]} className="max-w-full rounded-lg" /> : null),
  table: ({ node: _node, ...props }) => (
    <div data-prose-block className="overflow-x-auto rounded-md border border-line">
      <table {...props} className="w-full border-collapse" />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th
      {...props}
      className="h-9 bg-fill-ghost-hover px-[0.75em] py-[0.4375em] text-left font-medium whitespace-nowrap"
    />
  ),
  td: ({ node: _node, ...props }) => <td {...props} className="border-t border-line px-[0.75em] py-[0.4375em]" />,
  ...Object.fromEntries(
    [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ul',
      'ol',
      'li',
      'strong',
      'blockquote',
      'hr',
      'thead',
      'tbody',
      'tr',
      'sup',
      'sub',
    ].map((tag) => [tag, plain(tag)]),
  ),
};

type MdNode = { type: string; value?: string; children?: MdNode[] };

/**
 * The model reads Atelier's tags in quoted material escaped (`‹project>`, docs/PROMPTS.md §1.7), and quotes them that
 * way. People see the original characters, as text: turned back in the parsed text and code, so they never become HTML.
 */
function remarkUnescapeTags() {
  const walk = (node: MdNode) => {
    if (node.value !== undefined && node.type !== 'html') node.value = unescapeTags(node.value);
    node.children?.forEach(walk);
  };
  return walk;
}

const verbatimPlugins = [...Object.values(defaultRemarkPlugins), remarkMath];
const remarkPlugins = [...verbatimPlugins, remarkUnescapeTags];

/** remark-math only treats `$$` on its own line as display math; models often write `$$ … $$` on one line. */
export function displayMathLines(text: string): string {
  if (!text.includes('$$')) return text;
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
      return fenced ? line : line.replace(/^ {0,3}\$\$([^$]+)\$\$[ \t]*$/, '$$$$\n$1\n$$$$');
    })
    .join('\n');
}

/** New words are wrapped and staggered by Streamdown; markdown.css fades each one in over 600ms. */
const animated: AnimateOptions = { animation: 'fadeIn', duration: 600, stagger: 30 };
const linkSafety = { enabled: false };

/**
 * Assistant prose. Blocks are memoized by Streamdown, so streaming only re-renders the last block. `verbatim` shows a
 * file as it is, without turning escaped tags back.
 */
export const Markdown = memo(function Markdown({ text, streaming, verbatim = false }: { text: string; streaming: boolean; verbatim?: boolean }) {
  return (
    <Streamdown
      className="atelier-prose"
      components={components}
      remarkPlugins={verbatim ? verbatimPlugins : remarkPlugins}
      animated={animated}
      isAnimating={streaming}
      parseIncompleteMarkdown={streaming}
      linkSafety={linkSafety}
      controls={false}
    >
      {displayMathLines(protectCurrency(text))}
    </Streamdown>
  );
});
