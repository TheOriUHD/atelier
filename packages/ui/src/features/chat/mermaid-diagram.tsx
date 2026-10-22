/** Mermaid renderer, loaded on demand the first time a message has a finished ```mermaid fence. */
import { use } from 'react';
import mermaid from 'mermaid';

type Result = { svg: string } | { error: string };

const results = new Map<string, Promise<Result>>();
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

/** Renders are serialized because `initialize` sets mermaid's global theme. Results are cached per theme and source. */
function render(source: string, theme: 'light' | 'dark'): Promise<Result> {
  const key = `${theme}\0${source}`;
  let result = results.get(key);
  if (!result) {
    result = queue.then(async (): Promise<Result> => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: theme === 'dark' ? 'dark' : 'neutral',
        fontFamily: 'var(--at-font-ui)',
      });
      try {
        return { svg: (await mermaid.render(`at-mermaid-${++counter}`, source)).svg };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    queue = result;
    results.set(key, result);
  }
  return result;
}

export default function MermaidDiagram({ source, theme }: { source: string; theme: 'light' | 'dark' }) {
  const result = use(render(source, theme));
  if ('error' in result)
    return (
      <p className="px-3.5 pb-3.5 font-sans text-body text-danger-text">
        This diagram couldn’t be rendered: {result.error}
      </p>
    );
  return (
    <div
      // Edge labels take the app's text and surface colors: mermaid's own fall below 4.5:1 contrast.
      className="flex justify-center overflow-x-auto px-3.5 pb-3.5 [&_svg]:h-auto [&_svg]:max-w-full [&_.edgeLabel]:!text-fg [&_.edgeLabel_p]:!text-fg [&_.labelBkg]:!bg-raised"
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}
