/**
 * The person's computer use settings on this computer (`userData/computer-use.json`): on or off, how it uses the apps
 * they allow, their denied apps (password managers to begin with) and the apps allowed for good, per backend. Only
 * this computer's windows change it, through main.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { ComputerSettings, seededDenied } from '@atelier/protocol';

export async function readComputerSettings(path: string): Promise<ComputerSettings> {
  const raw = await readFile(path, 'utf8').then(
    (text) => JSON.parse(text) as unknown,
    () => null,
  );
  // A first start gets the password managers on its denied list; after that the person's list is theirs.
  const seeded = seededDenied(process.platform);
  const parsed = ComputerSettings.safeParse(raw ?? { denied: seeded });
  return parsed.success ? parsed.data : ComputerSettings.parse({ denied: seeded });
}

/** Changes the settings as one write: no reader ever sees half a file. */
export async function changeComputerSettings(path: string, change: (s: ComputerSettings) => ComputerSettings): Promise<ComputerSettings> {
  const next = ComputerSettings.parse(change(await readComputerSettings(path)));
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return next;
}
