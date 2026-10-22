/** Desktop apps registered to an account (ARCHITECTURE §21). Online state comes from live connections. */
import { and, desc, eq } from 'drizzle-orm';
import type { DeviceSummary } from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { devices } from '../store/schema.ts';

type DeviceRow = typeof devices.$inferSelect;

export class DeviceRepo {
  constructor(private readonly db: Db) {}

  /**
   * Registers or refreshes the account's row for a device. Rows are per account: registering an id another
   * account uses (signed in on the same machine, or a copied id) leaves that account's row alone.
   */
  async register(userId: string, input: { id: string; name: string; platform: string }): Promise<DeviceRow> {
    const now = Date.now();
    const row: DeviceRow = { id: input.id, userId, name: input.name, platform: input.platform, createdAt: now, lastSeenAt: now };
    await this.db
      .insert(devices)
      .values(row)
      .onConflictDoUpdate({ target: [devices.userId, devices.id], set: { name: input.name, platform: input.platform, lastSeenAt: now } });
    return (await this.db.select().from(devices).where(and(eq(devices.userId, userId), eq(devices.id, input.id))).get())!;
  }

  async list(userId: string, current: string | null, online: (id: string) => boolean): Promise<DeviceSummary[]> {
    const rows = await this.db.select().from(devices).where(eq(devices.userId, userId)).orderBy(desc(devices.lastSeenAt)).all();
    return rows.map((r) => toDeviceSummary(r, current, online(r.id)));
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.db.delete(devices).where(and(eq(devices.userId, userId), eq(devices.id, id)));
  }
}

export function toDeviceSummary(r: DeviceRow, current: string | null, online: boolean): DeviceSummary {
  return { id: r.id, name: r.name, platform: r.platform, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, current: r.id === current, online };
}
