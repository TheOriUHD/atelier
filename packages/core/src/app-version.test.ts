import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP, compareVersions } from '@atelier/protocol';

const desktopVersion = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../apps/desktop/package.json'), 'utf8')) as { version: string }).version;

describe('APP.version', () => {
  // v0.1.9 was released with `APP.version` still at 0.1.8: its server announced itself as 0.1.8 and offered to update to 0.1.9.
  it('is the desktop package version at a release, and not ahead of it while a dev version is under way', () => {
    if (desktopVersion.includes('-')) expect(compareVersions(desktopVersion, APP.version)).toBeGreaterThanOrEqual(0);
    else expect(APP.version).toBe(desktopVersion);
  });
});
