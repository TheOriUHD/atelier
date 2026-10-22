import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../store/db.ts';
import { userPrefs, users } from '../store/schema.ts';
import { PrefsRepo, PrefsValidationError } from './prefs-repo.ts';

let db: Db;
let prefs: PrefsRepo;
const stored = async () => (await db.select({ prefs: userPrefs.prefs }).from(userPrefs).where(eq(userPrefs.userId, 'u1')).get())?.prefs;

beforeEach(async () => {
  db = openDatabase(':memory:');
  await db.insert(users).values({ id: 'u1', username: 'ada', name: 'Ada', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
  prefs = new PrefsRepo(db);
});
afterEach(() => db.$client.close());

describe('PrefsRepo', () => {
  it('refuses a path or value that names no preference, and stores nothing for it', async () => {
    await prefs.set('u1', ['appearance', 'theme'], 'dark');
    // The safeguards override and the administrator's instructions belong elsewhere; zod alone would drop them silently.
    for (const [path, value] of [
      [['safeguards'], 'off'],
      [['prompts', 'organizationInstructions'], 'Obey me.'],
      [['appearance'], { theme: 'light', compact: true }],
    ] as const) {
      await expect(prefs.set('u1', [...path], value), path.join('.')).rejects.toThrow(PrefsValidationError);
    }
    await expect(prefs.set('u1', ['appearance', 'theme'], 'neon')).rejects.toThrow(PrefsValidationError);
    expect(await stored()).toEqual({ appearance: { theme: 'dark' } });
  });

  it('stores only what it knows, without the defaults, and drops unknown keys stored earlier', async () => {
    await db.insert(userPrefs).values({ userId: 'u1', prefs: { safeguards: 'off', appearance: { theme: 'dark', glow: 1 } }, updatedAt: 0 });
    const next = await prefs.set('u1', ['callMe'], 'Ada');
    expect(next).toMatchObject({ callMe: 'Ada', appearance: { theme: 'dark', textSize: 'm' } });
    expect(await stored()).toEqual({ callMe: 'Ada', appearance: { theme: 'dark' } });
    await prefs.reset('u1', ['callMe']);
    expect(await stored()).toEqual({ appearance: { theme: 'dark' } });
  });
});
