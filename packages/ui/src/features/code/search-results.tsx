/**
 * A WebSearch result as people read it: the title as a link, the site (and for news the date and outlet) and the snippet under it. Failures say what
 * happened in a line and, when the cause is search being limited, where to change it. No favicons: they would be
 * requests to third parties for the sake of decoration.
 */
import { useOpenSettings } from '../../app/navigation.ts';
import { cn } from '../../components/ui/index.ts';
import { parseSearchResult } from './search-result.ts';

export function SearchResults({ text, failed, className }: { text: string; failed: boolean; className?: string }) {
  const view = parseSearchResult(text);
  if (failed || view.rows.length === 0) return <SearchProblem text={text} failed={failed} className={className} />;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {view.note && <p className="text-footnote text-fg-muted">{view.note}</p>}
      <ol className="flex flex-col gap-2.5">
        {view.rows.map((row) => (
          <li key={row.url} className="min-w-0">
            <a href={row.url} target="_blank" rel="noreferrer noopener" className="block truncate rounded-xs text-body text-fg outline-none hover:underline focus-ring">
              {row.title}
            </a>
            <span className="block truncate text-footnote text-fg-muted">
              {row.host}
              {row.published ? ` · ${row.published}` : ''}
            </span>
            {row.snippet && <span className="line-clamp-2 text-footnote text-fg-secondary">{row.snippet}</span>}
          </li>
        ))}
      </ol>
      {view.via && <p className="text-footnote text-fg-muted">via {view.via}{view.cached ? ' · from this session’s cache' : ''}</p>}
    </div>
  );
}

/** No results, or a search that couldn't run: one line, and where to change it. */
function SearchProblem({ text, failed, className }: { text: string; failed: boolean; className: string | undefined }) {
  const openSettings = useOpenSettings();
  return (
    <div className={cn('flex flex-col gap-1 text-body', className)}>
      <p className={failed ? 'text-danger-text' : 'text-fg-secondary'}>{text.split('\n')[0]}</p>
      {failed && (
        <button type="button" onClick={() => openSettings('capabilities')} className="self-start rounded-xs text-interactive-text underline-offset-2 outline-none hover:underline focus-ring">
          Search settings
        </button>
      )}
    </div>
  );
}
