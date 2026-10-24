/**
 * Personal providers (ARCHITECTURE §8): a person's own model servers and ChatGPT Chat on one of their computers, kept
 * per account. The registry reaches them through that computer's device link (device services, §21); their API key,
 * if any, is the person's own secret `provider-user-<user>-<provider>`.
 */
import { and, eq } from 'drizzle-orm';
import type { PersonalProviderType, ToolSupport } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { devices, personalProviders } from '../store/schema.ts';
import type { ChatGptChatPort } from './chatgpt-chat.ts';
import type { ProviderFetch } from './types.ts';

export type PersonalProviderRow = typeof personalProviders.$inferSelect;
/** A row with its computer's name; null once that computer was removed from the account. */
export type PersonalRow = PersonalProviderRow & { deviceName: string | null };

/** The secret holding a personal provider's API key. */
export const personalKeyId = (userId: string, providerId: string) => `provider-user-${userId}-${providerId}`;

export class PersonalProviderRepo {
  constructor(private readonly db: Db) {}

  async list(userId: string): Promise<PersonalRow[]> {
    const rows = await this.query().where(eq(personalProviders.userId, userId)).orderBy(personalProviders.createdAt).all();
    return rows.map(({ row, deviceName }) => ({ ...row, deviceName }));
  }

  async get(id: string): Promise<PersonalRow | null> {
    const found = await this.query().where(eq(personalProviders.id, id)).get();
    return found ? { ...found.row, deviceName: found.deviceName } : null;
  }

  async put(row: PersonalProviderRow): Promise<void> {
    const { id: _, ...rest } = row;
    await this.db.insert(personalProviders).values(row).onConflictDoUpdate({ target: personalProviders.id, set: rest });
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(personalProviders).where(eq(personalProviders.id, id));
  }

  private query() {
    return this.db
      .select({ row: personalProviders, deviceName: devices.name })
      .from(personalProviders)
      .leftJoin(devices, and(eq(devices.userId, personalProviders.userId), eq(devices.id, personalProviders.deviceId)));
  }
}

/** How the registry reaches a person's computers, and where it keeps what their models' tests found. */
export interface PersonalAccess {
  repo: PersonalProviderRepo;
  /** The computer is connected and lends what the provider needs there: its address, or its ChatGPT window. */
  lends(userId: string, deviceId: string, providerId: string, type: PersonalProviderType): boolean;
  /** `fetch` from the computer to the address it lent as `providerId`. Never through the request inspector. */
  fetch(userId: string, deviceId: string, providerId: string): ProviderFetch;
  /** The ChatGPT window of the desktop app there. */
  chatgptChat(userId: string, deviceId: string): ChatGptChatPort;
  /** How the person's own models call tools (their prefs' `personalModels`), and recording a test's result. */
  toolCalling(userId: string): Promise<Record<string, ToolSupport | undefined>>;
  setToolCalling(userId: string, ref: string, value: ToolSupport): Promise<void>;
}
