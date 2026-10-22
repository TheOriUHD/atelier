/** Per-user preferences: a JSON document per user, validated against `UserPrefs` on every write. */
import { eq } from 'drizzle-orm';
import { UserPrefs, type SettingsPath } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { userPrefs } from '../store/schema.ts';
import { deleteAt, getAt, setAt } from '../util/json-path.ts';

export class PrefsValidationError extends Error {}

export class PrefsRepo {
  constructor(private readonly db: Db) {}

  async get(userId: string): Promise<UserPrefs> {
    return UserPrefs.parse(await this.raw(userId));
  }

  async set(userId: string, path: SettingsPath, value: unknown): Promise<UserPrefs> {
    const doc = setAt(await this.raw(userId), path, value);
    return this.write(userId, doc, (stored) => {
      // Zod drops keys it doesn't know rather than failing, so a value it would drop names no preference.
      if (JSON.stringify(getAt(stored, path)) !== JSON.stringify(getAt(doc, path))) throw new PrefsValidationError(`${path.join('.')}: not a preference`);
    });
  }

  async reset(userId: string, path: SettingsPath): Promise<UserPrefs> {
    return this.write(userId, deleteAt(await this.raw(userId), path));
  }

  private async raw(userId: string): Promise<Record<string, unknown>> {
    return (await this.db.select({ prefs: userPrefs.prefs }).from(userPrefs).where(eq(userPrefs.userId, userId)).get())?.prefs ?? {};
  }

  /**
   * Stores what the schema accepts and knows: keys it would drop are left out (also ones stored before this check
   * existed). Defaults aren't written, so a changed default still reaches people who never chose otherwise.
   */
  private async write(userId: string, doc: Record<string, unknown>, check?: (stored: Record<string, unknown>) => void): Promise<UserPrefs> {
    const parsed = UserPrefs.safeParse(doc);
    if (!parsed.success) throw new PrefsValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const stored = known(doc, parsed.data) as Record<string, unknown>;
    check?.(stored);
    const now = Date.now();
    await this.db
      .insert(userPrefs)
      .values({ userId, prefs: stored, updatedAt: now })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { prefs: stored, updatedAt: now } });
    return parsed.data;
  }
}

/** `doc` without the keys that `parsed`, its parsed form, doesn't have. */
function known(doc: unknown, parsed: unknown): unknown {
  if (!isObject(doc) || !isObject(parsed)) return doc;
  return Object.fromEntries(Object.entries(doc).flatMap(([key, value]) => (key in parsed ? [[key, known(value, parsed[key])]] : [])));
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
