/** KaTeX renderer, loaded on demand (with its stylesheet and fonts) the first time a message has math. */
import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export default function Katex({ tex, display }: { tex: string; display: boolean }) {
  const html = useMemo(
    () =>
      katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: false,
        errorColor: 'var(--at-color-danger-text)',
      }),
    [tex, display],
  );
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
