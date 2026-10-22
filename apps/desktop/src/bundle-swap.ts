/**
 * How the macOS app replaces itself without a Developer ID (updater.ts has the rest): the update is unpacked beside
 * the app while it runs, and a small shell script, started detached, waits for the app to quit, moves the old bundle
 * aside, moves the new one in, clears the quarantine flag and starts it again if asked. Nothing downloaded by the app
 * itself carries the quarantine flag to begin with, so Gatekeeper never judges the new bundle.
 */
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BundleSwap } from './updater.ts';

const run = promisify(execFile);

/** Arguments: the app's pid, its bundle, the new bundle, and 1 to start it again. */
export const SWAP_SCRIPT = `
while kill -0 "$1" 2>/dev/null; do sleep 0.3; done
old="$2"; new="$3"; backup="$old.previous"
rm -rf "$backup"
if mv "$old" "$backup" && mv "$new" "$old"; then
  xattr -cr "$old" 2>/dev/null
  rm -rf "$backup"
else
  # Put the old one back: an update that could not be placed must not leave no app at all.
  if [ -d "$backup" ] && [ ! -d "$old" ]; then mv "$backup" "$old"; fi
fi
if [ "$4" = "1" ]; then open "$old"; fi
exit 0
`;

/** The running app's bundle when it can be replaced where it is, or why not. */
export function targetOf(executable: string, writable: (path: string) => boolean): { bundle: string } | { reason: string } {
  const bundle = resolve(executable, '..', '..', '..');
  if (!bundle.endsWith('.app')) return { reason: 'This copy is not an app bundle.' };
  // Launched from the Downloads folder or a disk image, macOS runs a read-only copy from a random place.
  if (bundle.includes('/AppTranslocation/')) return { reason: 'Move Atelier to the Applications folder to let it update itself.' };
  if (bundle.startsWith('/Volumes/')) return { reason: 'Atelier is running from a disk image: drag it to Applications.' };
  if (!writable(bundle) || !writable(dirname(bundle))) return { reason: 'Atelier cannot replace itself where it is installed.' };
  return { bundle };
}

const isWritable = (path: string) => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

async function bundleId(bundle: string): Promise<string> {
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')]);
  return stdout.trim();
}

/** The real swap for the running app: `executable` is `process.execPath`, `staging` a folder in the app's own data. */
export function createBundleSwap(executable: string, staging: string): BundleSwap {
  const target = targetOf(executable, isWritable);
  return {
    target,
    staging,
    async unpack(zip, into) {
      await rm(into, { recursive: true, force: true });
      await run('/usr/bin/ditto', ['-x', '-k', zip, into]);
      const app = readdirSync(into).find((name) => name.endsWith('.app'));
      if (!app) throw new Error('the update has no app in it');
      const unpacked = join(into, app);
      if ('bundle' in target && (await bundleId(unpacked)) !== (await bundleId(target.bundle))) throw new Error('the update is another app');
      return unpacked;
    },
    replaceAfterQuit(staged, bundle, relaunch) {
      spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'atelier-update', String(process.pid), bundle, staged, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref();
    },
  };
}
