/**
 * What a window shows when a page breaks: what went wrong, and a way back. Before this it was the router's bare
 * "Something went wrong!" with only a button to hide the message, so on Windows the way out was Task Manager.
 */
import type { ErrorComponentProps } from '@tanstack/react-router';
import { APP } from '@atelier/protocol';
import { Button } from '../components/ui/index.ts';
import { recordError } from '../lib/last-error.ts';
import { CopyDiagnosticsButton } from './copy-diagnostics-button.tsx';

export function AppError({ error, reset }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : String(error);
  // So "Copy diagnostics" on this screen names what broke, whether or not the window saw it as an uncaught error.
  recordError(error);
  return (
    <div role="alert" className="app-drag flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      <h1 className="text-title text-fg">{APP.name} ran into a problem</h1>
      <p className="max-w-md text-body text-fg-secondary">Reloading usually fixes it. If it keeps happening, Copy diagnostics puts what helps to find out why on your clipboard, for you to paste into a report. Atelier sends nothing by itself.</p>
      <code className="app-no-drag max-w-xl rounded-lg bg-fill-ghost-hover px-3 py-2 text-left font-mono text-footnote break-words text-fg-secondary select-text">{message}</code>
      <div className="app-no-drag flex gap-2">
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button onClick={reset}>Try again</Button>
        <CopyDiagnosticsButton />
      </div>
    </div>
  );
}
