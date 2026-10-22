import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeWorkspaceFs } from '../fs/workspace-fs.ts';
import { SettingsService, SettingsValidationError } from './settings-service.ts';

let home: string;
let project: string;
const fs = new NodeWorkspaceFs();

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'atelier-home-'));
  project = await mkdtemp(join(tmpdir(), 'atelier-proj-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

describe('SettingsService', () => {
  it('applies defaults when no files exist', async () => {
    const s = new SettingsService(fs, home);
    await s.load();
    expect(s.effective.server.signup).toBe('invite');
    expect(s.snapshot().errors).toEqual([]);
  });

  it('writes one path into a layer and keeps unknown keys', async () => {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ futureKey: { a: 1 } }));
    const s = new SettingsService(fs, home);
    await s.load();
    await s.set('global', ['server', 'signup'], 'open');
    const raw = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
    expect(raw).toEqual({ futureKey: { a: 1 }, server: { signup: 'open' } });
    expect(s.effective.server.signup).toBe('open');
  });

  it('keeps the newest settings when a file change reloads while another write is under way', async () => {
    // A reload that read the file before the second write must not land after it and bring the first state back.
    class HeldReads extends NodeWorkspaceFs {
      hold = false;
      release: (() => void) | null = null;
      reads = 0;
      onChange: ((path: string) => void) | null = null;
      override async read(path: string): Promise<string | null> {
        const text = await super.read(path);
        if (this.hold) {
          this.reads++;
          await new Promise<void>((resolve) => (this.release = resolve));
        }
        return text;
      }
      override watch(_paths: string[], onChange: (path: string) => void): () => void {
        this.onChange = onChange;
        return () => {};
      }
    }
    const slow = new HeldReads();
    const s = new SettingsService(slow, home);
    await s.load();
    s.watch();
    await s.set('global', ['server', 'signup'], 'open');
    slow.hold = true;
    slow.onChange!(join(home, 'settings.json'));
    await vi.waitFor(() => expect(slow.reads).toBe(1));
    // The second write starts while the reload holds the file's old content.
    const second = s.set('global', ['context', 'autoCompactAt'], 0.8);
    slow.hold = false;
    slow.release!();
    await second;
    await vi.waitFor(async () => expect(await fs.read(join(home, 'settings.json'))).toContain('0.8'));
    expect(s.effective.server.signup).toBe('open');
    expect(s.effective.context.autoCompactAt).toBe(0.8);
  });

  it('rejects invalid values without writing', async () => {
    const s = new SettingsService(fs, home);
    await s.load();
    await expect(s.set('global', ['server', 'signup'], 'anyone')).rejects.toBeInstanceOf(SettingsValidationError);
    expect(await fs.read(join(home, 'settings.json'))).toBeNull();
  });

  it('layers project and local over global and reports origins', async () => {
    await mkdir(join(project, '.atelier'), { recursive: true });
    await writeFile(join(home, 'settings.json'), JSON.stringify({ context: { autoCompactAt: 0.9 }, pricing: { 'a/b': { input: 1, output: 2 } } }));
    await writeFile(join(project, '.atelier', 'settings.json'), JSON.stringify({ context: { autoCompactAt: 0.7 } }));
    await writeFile(join(project, '.atelier', 'settings.local.json'), JSON.stringify({ server: { signup: 'open' } }));
    const s = new SettingsService(fs, home, { fs, root: project });
    await s.load();
    expect(s.effective.context.autoCompactAt).toBe(0.7);
    expect(s.effective.pricing['a/b']).toEqual({ input: 1, output: 2 });
    expect(s.effective.server.signup).toBe('open');
    expect(s.snapshot().origins).toEqual({ 'context.autoCompactAt': 'project', 'server.signup': 'local' });
    await s.reset('project', ['context', 'autoCompactAt']);
    expect(s.effective.context.autoCompactAt).toBe(0.9);
  });

  it('keeps a file’s valid keys when one is invalid, and says which', async () => {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ server: { signup: 'open' }, permissions: { defaultMode: 'yolo' } }));
    const s = new SettingsService(fs, home);
    await s.load();
    expect(s.effective.server.signup).toBe('open');
    expect(s.effective.permissions.defaultMode).toBe('auto');
    expect(s.snapshot().errors).toEqual([{ layer: 'global', message: expect.stringMatching(/^permissions\.defaultMode: /) }]);
    // Saving another setting keeps the invalid key in the file for the person to fix.
    await s.set('global', ['server', 'signup'], 'invite');
    expect(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))).toEqual({ server: { signup: 'invite' }, permissions: { defaultMode: 'yolo' } });
    expect(s.effective.server.signup).toBe('invite');
  });

  it('isolates a broken layer and reports it', async () => {
    await writeFile(join(home, 'settings.json'), '{ not json');
    const s = new SettingsService(fs, home);
    await s.load();
    expect(s.effective.server.signup).toBe('invite');
    expect(s.snapshot().errors[0]?.layer).toBe('global');
    await expect(s.set('global', ['server', 'signup'], 'open')).rejects.toThrow(/Fix the file first/);
    expect(await readFile(join(home, 'settings.json'), 'utf8')).toBe('{ not json');
  });
});
