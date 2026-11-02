/**
 * Personal image providers (ARCHITECTURE §23): a person's own image servers on one of their computers, kept per account.
 * The registry reaches them through that computer's device link (device services, §21), by the `http` and `ws` the
 * desktop lends there; their API key, if any, is the person's own secret, as for text (`personalKeyId`).
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../store/db.ts';
import { devices, personalImageProviders } from '../store/schema.ts';
import type { ProviderFetch } from '../providers/types.ts';
import type { ImageAdapterDeps } from './types.ts';

export type PersonalImageProviderRow = typeof personalImageProviders.$inferSelect;
/** A row with its computer's name; null once that computer was removed from the account. */
export type PersonalImageRow = PersonalImageProviderRow & { deviceName: string | null };

export class PersonalImageRepo {
  constructor(private readonly db: Db) {}

  async list(userId: string): Promise<PersonalImageRow[]> {
    const rows = await this.query().where(eq(personalImageProviders.userId, userId)).orderBy(personalImageProviders.createdAt).all();
    return rows.map(({ row, deviceName }) => ({ ...row, deviceName }));
  }

  async get(id: string): Promise<PersonalImageRow | null> {
    const found = await this.query().where(eq(personalImageProviders.id, id)).get();
    return found ? { ...found.row, deviceName: found.deviceName } : null;
  }

  async put(row: PersonalImageProviderRow): Promise<void> {
    const { id: _, ...rest } = row;
    await this.db.insert(personalImageProviders).values(row).onConflictDoUpdate({ target: personalImageProviders.id, set: rest });
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(personalImageProviders).where(eq(personalImageProviders.id, id));
  }

  private query() {
    return this.db
      .select({ row: personalImageProviders, deviceName: devices.name })
      .from(personalImageProviders)
      .leftJoin(devices, and(eq(devices.userId, personalImageProviders.userId), eq(devices.id, personalImageProviders.deviceId)));
  }
}

/** How the image registry reaches a person's computers. */
export interface PersonalImageAccess {
  repo: PersonalImageRepo;
  /** The computer is connected and lends the address. */
  lends(userId: string, deviceId: string, providerId: string): boolean;
  /** `fetch` from the computer to the address it lent as `providerId`. Never through the request inspector. */
  fetch(userId: string, deviceId: string, providerId: string): ProviderFetch;
  /** WebSockets from the computer to that same address. */
  socket(userId: string, deviceId: string, providerId: string, headers: Record<string, string>): ImageAdapterDeps['socket'];
}
