/**
 * Workspace files in the Browser pane: the desktop app serves a workspace under an origin of its own and asks this
 * window for each file a page loads (apps/desktop/src/workspace-pages.ts); the window reads it over its connection.
 */
import { desktop } from '../../lib/platform.ts';
import { rpc } from '../../lib/rpc.ts';

/** Files the pane shows as pages: HTML, SVG and images. */
const PAGE_FILE = /\.(html?|svg|png|jpe?g|gif|webp)$/i;

export const opensInBrowser = (path: string) => PAGE_FILE.test(path);

/** Whether this app can show workspace files in the Browser pane (its desktop shell serves them). */
export const canServePages = () => !!desktop?.browser.serve && !!desktop.browser.setFileReader;

let reading = false;

/** The pane's address for a workspace file (`path` relative to the root, with `/`). */
export async function pageUrl(workspaceId: string, path: string): Promise<string> {
  const bridge = desktop!.browser;
  if (!reading) {
    reading = true;
    bridge.setFileReader!(({ workspaceId, path }) =>
      rpc()
        .call('workspaces.fileBytes', { workspaceId, path })
        .then((file) => file.dataBase64),
    );
  }
  const origin = await bridge.serve!(workspaceId);
  return origin + path.split('/').map(encodeURIComponent).join('/');
}
