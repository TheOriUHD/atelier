/**
 * Facts about this install: its version, where its runner builds are, and how to start another process of it (the
 * background service). An installed terminal app is a folder: `bin/atelier`, `node/`, `lib/atelier.mjs`, `lib/runner/`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, runnerBinaryName } from '@atelier/protocol';

export const VERSION = APP.version;
export const USER_AGENT = `Atelier CLI/${VERSION} (${process.platform}; ${process.arch})`;

/** The bundle's own folder (`lib/` when installed, `apps/cli/dist` in the repo). */
export const here = () => dirname(fileURLToPath(import.meta.url));

/** Where the runner builds are: next to the bundle when installed, the repo's `runner/bin` when built from source. */
export function runnerDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.ATELIER_RUNNER_DIR, join(here(), 'runner'), join(here(), '../../../runner/bin'), join(here(), '../../../../runner/bin')].filter((d): d is string => !!d);
  return candidates.find((d) => existsSync(join(d, runnerBinaryName(process.platform, process.arch)))) ?? null;
}

/** The command line that runs this terminal app again: Node and the bundle (or the source through tsx in a test). */
export function selfCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: [...process.execArgv.filter((a) => !a.startsWith('--inspect')), process.argv[1]!] };
}
