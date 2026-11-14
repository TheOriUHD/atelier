/**
 * Opens the report dialog. With `capture` (the report shortcut, the bug button, Help › Report an Issue…) the report is
 * about where the person is: the desktop app first takes a picture of the window as it is, before the dialog covers it,
 * and the conversation open now is attached. The person can take either out again.
 */
import type { ReportKind } from '@atelier/protocol';
import { desktop } from '../../lib/platform.ts';
import { windowShot } from './report-images.ts';
import { useReports } from './report-store.ts';

export async function openReporter(kind: ReportKind, { capture = false }: { capture?: boolean } = {}): Promise<void> {
  const store = useReports.getState();
  if (store.open) {
    store.setKind(kind);
    return;
  }
  let shot = null;
  if (capture && desktop?.reports) {
    try {
      const png = await desktop.reports.capture();
      if (png) shot = await windowShot(png);
    } catch {
      // No picture, then: the dialog opens all the same.
    }
  }
  useReports.getState().open_(kind, shot, capture);
}
