import { describe, expect, it } from 'vitest';
import { isDiskImage, planUploads, pool, retrying, runUploads } from '../cloudflare/upload.mjs';

type Planned = { name: string; kind: string; send: boolean };

const folder = [
  'Atelier-0.3.2-mac.zip',
  'Atelier-0.3.2-mac.zip.blockmap',
  'Atelier-0.3.2.dmg',
  'Atelier-0.3.2.dmg.blockmap',
  'Atelier-0.3.2-arm64.dmg',
  'Atelier-0.3.2-arm64.dmg.blockmap',
  'Atelier-Setup-0.3.2-x64.exe',
  'Atelier-Setup-0.3.2-x64.exe.blockmap',
  'Atelier-Setup-0.3.2-arm64.exe',
  'Atelier-Setup-0.3.2-arm64.exe.blockmap',
  'latest.yml',
  'latest-mac.yml',
  'Atelier-0.3.2.dmg.sig',
  'notes.md',
];

describe('what goes to the bucket', () => {
  it('sends packages and block maps first and the update files last, and nothing else', () => {
    const plan = planUploads(folder);
    expect(plan.last.map((i: Planned) => i.name)).toEqual(['latest.yml', 'latest-mac.yml']);
    const names = plan.first.map((i: Planned) => i.name);
    expect(names).toContain('Atelier-Setup-0.3.2-arm64.exe');
    expect(names).toContain('Atelier-0.3.2-mac.zip.blockmap');
    expect(names).not.toContain('notes.md');
    expect(names).not.toContain('latest.yml');
    expect(names).not.toContain('Atelier-0.3.2.dmg.sig');
  });

  it('leaves the macOS disk images and their block maps to the GitHub release, but still signs the images', () => {
    const plan = planUploads(folder);
    const images = plan.first.filter((i: Planned) => isDiskImage(i.name));
    expect(images.map((i: Planned) => [i.name, i.send])).toEqual([
      ['Atelier-0.3.2.dmg', false],
      ['Atelier-0.3.2-arm64.dmg', false],
    ]);
    expect(plan.first.map((i: Planned) => i.name)).not.toContain('Atelier-0.3.2.dmg.blockmap');
    const withImages = planUploads(folder, { diskImages: true });
    expect(withImages.first.filter((i: Planned) => isDiskImage(i.name) && i.send)).toHaveLength(2);
    expect(withImages.first.map((i: Planned) => i.name)).toContain('Atelier-0.3.2.dmg.blockmap');
  });
});

describe('sending in parallel', () => {
  const tick = () => new Promise((r) => setTimeout(r, 2));

  it('never runs more than the limit at once, and runs every item', async () => {
    let running = 0;
    let most = 0;
    const seen: number[] = [];
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n: number) => {
      running++;
      most = Math.max(most, running);
      await tick();
      seen.push(n);
      running--;
    });
    expect(most).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('starts nothing new after a failure, lets the running ones finish and throws the first error', async () => {
    const started: number[] = [];
    await expect(
      pool([1, 2, 3, 4, 5, 6], 2, async (n: number) => {
        started.push(n);
        await tick();
        if (n === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(started.length).toBeLessThan(6);
  });

  it('tries again after a failure with a longer wait each time, and gives up after the last try', async () => {
    const waits: number[] = [];
    const messages: string[] = [];
    let calls = 0;
    await retrying(
      'x',
      async () => {
        if (++calls < 3) throw new Error('502');
      },
      { sleep: async (s: number) => void waits.push(s), log: (m: string) => messages.push(m) },
    );
    expect(calls).toBe(3);
    expect(waits).toEqual([15, 30]);
    expect(messages[0]).toContain('x failed (try 1 of 4), again in 15 s');
    let tries = 0;
    await expect(
      retrying(
        'y',
        async () => {
          tries++;
          throw new Error('401');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('401');
    expect(tries).toBe(4);
  });
});

describe('running the uploads', () => {
  const item = (name: string, size: number, extra = {}) => ({ name, kind: 'package', send: true, size, path: `/p/${name}`, sigPath: `/s/${name}.sig`, signature: `sig-${name}`, ...extra });
  const feed = (name: string) => ({ name, kind: 'feed', send: true, path: `/p/${name}`, size: 1 });
  const record = (puts: string[], slow = '') => async (key: string) => {
    await new Promise((r) => setTimeout(r, key === slow ? 15 : 1));
    puts.push(key);
  };

  it('puts each package, then its signature, and the update files only after every package and signature', async () => {
    const puts: string[] = [];
    const plan = { first: [item('a.zip', 5), item('b.exe', 50), { name: 'b.exe.blockmap', kind: 'blockmap', send: true, path: '/p/b.exe.blockmap', size: 1 }], last: [feed('latest.yml')] };
    const stats = await runUploads({ plan, jobs: 3, put: record(puts, 'b.exe') });
    expect(stats).toEqual({ put: 6, skipped: 0 });
    expect(puts.indexOf('b.exe')).toBeLessThan(puts.indexOf('b.exe.sig'));
    expect(puts.indexOf('a.zip')).toBeLessThan(puts.indexOf('a.zip.sig'));
    expect(puts.at(-1)).toBe('latest.yml');
  });

  it('skips a package that is there already, with its signature, and sends the ones that are not', async () => {
    const puts: string[] = [];
    const plan = { first: [item('a.zip', 5), item('b.exe', 50)], last: [feed('latest.yml')] };
    const stats = await runUploads({ plan, put: record(puts), isUploaded: async (i: { name: string }) => i.name === 'a.zip' });
    expect(puts.sort()).toEqual(['b.exe', 'b.exe.sig', 'latest.yml']);
    expect(stats).toEqual({ put: 3, skipped: 2 });
  });

  it('sends a package again when asking whether it is there fails', async () => {
    const puts: string[] = [];
    await runUploads({
      plan: { first: [item('a.zip', 5)], last: [] },
      put: record(puts),
      isUploaded: async () => {
        throw new Error('offline');
      },
    });
    expect(puts).toEqual(['a.zip', 'a.zip.sig']);
  });

  it('sends only the signature of a disk image that is left to GitHub', async () => {
    const puts: string[] = [];
    await runUploads({ plan: { first: [item('a.dmg', 5, { send: false })], last: [] }, put: record(puts), isUploaded: async () => true });
    expect(puts).toEqual(['a.dmg.sig']);
  });

  it('does not touch the update files when a package fails for good', async () => {
    const puts: string[] = [];
    const plan = { first: [item('a.zip', 5), item('b.exe', 50)], last: [feed('latest.yml')] };
    await expect(
      runUploads({
        plan,
        jobs: 2,
        retry: { sleep: async () => {} },
        put: async (key: string) => {
          if (key === 'b.exe') throw new Error('502');
          puts.push(key);
        },
      }),
    ).rejects.toThrow('502');
    expect(puts).not.toContain('latest.yml');
  });
});
