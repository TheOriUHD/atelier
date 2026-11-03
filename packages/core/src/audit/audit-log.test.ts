import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDatabase, type Db } from '../store/db.ts';
import { auditEvents } from '../store/schema.ts';
import { AUDIT_MAX_ROWS, AuditLog } from './audit-log.ts';
import { hostOf, oneLine, scrubText, secretPath, smallValue } from './audit-redact.ts';

const DAY = 24 * 3600_000;
let db: Db;
let now: number;
let errors: string[];
let enabled: boolean;
let log: AuditLog;

beforeEach(() => {
  db = openDatabase(':memory:');
  now = Date.UTC(2026, 10, 2, 12);
  errors = [];
  enabled = true;
  log = new AuditLog(db, { enabled: () => enabled, onError: (m) => errors.push(m), now: () => now });
});
afterEach(() => {
  try {
    db.$client.close();
  } catch {
    // Closed by the test.
  }
});

const who = { actorId: 'u1', actor: 'Ada', ip: '10.0.0.1' };
const page = async (filter = {}, p: { cursor?: string; limit?: number } = {}) => log.list(filter, p, 90);

describe('the activity log', () => {
  it('stores what happened, who did it and from where, with the username in lowercase', async () => {
    log.record(who, { kind: 'account.created', target: 'bob', summary: 'Created the account bob', detail: { role: 'user', skipped: undefined } });
    await log.idle();
    const { events } = await page();
    expect(events).toEqual([{ id: expect.any(String), at: now, kind: 'account.created', actorId: 'u1', actor: 'ada', target: 'bob', summary: 'Created the account bob', detail: { role: 'user' }, ip: '10.0.0.1' }]);
  });

  it('is append-only in its interface: there is no way to change or remove one event', () => {
    expect(Object.getOwnPropertyNames(AuditLog.prototype).filter((n) => /update|delete|remove|edit/i.test(n))).toEqual([]);
  });

  it('writes nothing where it is switched off (a desktop app on its own backend)', async () => {
    enabled = false;
    log.record(who, { kind: 'settings.changed', summary: 'x' });
    await log.idle();
    expect((await page()).events).toEqual([]);
  });

  it('keeps the order of events written in a burst', async () => {
    for (let i = 0; i < 5; i++) log.record(who, { kind: 'settings.changed', summary: `change ${i}` });
    await log.idle();
    // Newest first, and the burst shares one millisecond: the order it was written in decides.
    expect((await page()).events.map((e) => e.summary)).toEqual(['change 4', 'change 3', 'change 2', 'change 1', 'change 0']);
  });

  it('shrinks and scrubs whatever it is given, whatever the rule did', async () => {
    log.record(
      { actor: 'x'.repeat(500), ip: '1'.repeat(500) },
      {
        kind: 'settings.changed',
        target: 'sk-ant-api03-ABCDEFGH0123456789\nsecond line',
        summary: `Changed it\u0000\n\ttoken=abcdef123456 ${'long '.repeat(200)}`,
        detail: { ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])), note: 'Bearer abcdefghijklmnop1234', pass: 'password: hunter2hunter2' },
      },
    );
    await log.idle();
    const [event] = (await page()).events;
    expect(event!.actor!.length).toBeLessThanOrEqual(80);
    expect(event!.ip!.length).toBeLessThanOrEqual(64);
    expect(event!.summary.length).toBeLessThanOrEqual(300);
    expect(event!.summary).not.toMatch(/\p{Cc}/u);
    expect(JSON.stringify(event)).not.toMatch(/ABCDEFGH|abcdef123456|abcdefghijklmnop1234|hunter2/);
    expect(Object.keys(event!.detail!).length).toBeLessThanOrEqual(12);
  });

  it('never throws and never fails the caller when the table is gone, and says so once a minute at most', async () => {
    await db.run(sql`drop table audit_events`);
    expect(() => log.record(who, { kind: 'settings.changed', summary: 'a' })).not.toThrow();
    log.record(who, { kind: 'settings.changed', summary: 'b' });
    await expect(log.idle()).resolves.toBeUndefined();
    expect(errors).toEqual(['the activity log could not be written']);
  });

  it('never throws on a draft that cannot be turned into a row', () => {
    const hostile = { get kind(): never { throw new Error('boom'); } } as never;
    expect(() => log.record(who, hostile)).not.toThrow();
  });

  it('survives a logger that throws', async () => {
    await db.run(sql`drop table audit_events`);
    const loud = new AuditLog(db, { enabled: () => true, onError: () => { throw new Error('logger down'); } });
    loud.record(who, { kind: 'settings.changed', summary: 'a' });
    await expect(loud.idle()).resolves.toBeUndefined();
  });

  describe('reading', () => {
    beforeEach(async () => {
      const rows: [string, string, string, number][] = [
        ['signin.success', 'ada', 'ada', 1],
        ['signin.failed', 'mallory', 'mallory', 2],
        ['account.created', 'ada', 'bob', 3],
        ['account.deleted', 'ada', 'bob', 4],
        ['settings.changed', 'bob', 'server.signup', 5],
      ];
      for (const [kind, actor, target, minute] of rows) {
        now = Date.UTC(2026, 10, 2, 10, minute);
        log.record({ actorId: actor, actor }, { kind: kind as never, target, summary: `${kind} ${target}` });
      }
      await log.idle();
    });

    it('lists newest first', async () => {
      expect((await page()).events.map((e) => e.kind)).toEqual(['settings.changed', 'account.deleted', 'account.created', 'signin.failed', 'signin.success']);
    });

    it('filters by category, by exact kind, by person (as actor or as target) and by date, and combines them', async () => {
      expect((await page({ kind: 'account' })).events.map((e) => e.kind)).toEqual(['account.deleted', 'account.created']);
      expect((await page({ kind: 'account.created' })).events).toHaveLength(1);
      expect((await page({ user: 'BOB' })).events.map((e) => e.kind)).toEqual(['settings.changed', 'account.deleted', 'account.created']);
      expect((await page({ user: 'ada', kind: 'signin' })).events.map((e) => e.kind)).toEqual(['signin.success']);
      expect((await page({ from: Date.UTC(2026, 10, 2, 10, 2), to: Date.UTC(2026, 10, 2, 10, 4) })).events.map((e) => e.kind)).toEqual(['account.deleted', 'account.created', 'signin.failed']);
    });

    it('matches nothing for a kind that is not a word, rather than reaching the query with it', async () => {
      for (const kind of ["account' or 1=1 --", '%', 'a.b.c', '', ' ']) {
        const { events } = await page({ kind });
        expect(events.length === 0 || kind === '').toBe(true);
      }
      expect((await page({ user: "' or 1=1 --" })).events).toEqual([]);
    });

    it('pages by cursor without repeating or skipping an event, also when events share a millisecond', async () => {
      for (let i = 0; i < 4; i++) log.record(who, { kind: 'settings.changed', summary: `same ms ${i}` });
      await log.idle();
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let turn = 0; turn < 10; turn++) {
        const next = await page({}, { limit: 3, ...(cursor ? { cursor } : {}) });
        seen.push(...next.events.map((e) => e.id));
        if (!next.next) break;
        cursor = next.next;
      }
      expect(seen).toHaveLength(9);
      expect(new Set(seen).size).toBe(9);
    });

    it('ignores a cursor that is not one, and clamps the page size', async () => {
      expect((await page({}, { cursor: "1;drop table audit_events", limit: 2 })).events).toHaveLength(2);
      expect((await page({}, { limit: 0 })).events).toHaveLength(1);
    });

    it('exports every matching event with the retention period, newest first', async () => {
      const out = await log.export({ kind: 'account' }, 30);
      expect(out).toMatchObject({ exportedAt: now, retentionDays: 30, truncated: false });
      expect(out.events.map((e) => e.kind)).toEqual(['account.deleted', 'account.created']);
    });
  });

  describe('pruning', () => {
    it('removes events older than the retention period and keeps the rest', async () => {
      for (const days of [100, 91, 89, 1, 0]) {
        now = Date.UTC(2026, 10, 2, 12) - days * DAY;
        log.record(who, { kind: 'settings.changed', summary: `${days} days ago` });
      }
      await log.idle();
      now = Date.UTC(2026, 10, 2, 12);
      expect(await log.prune(90)).toBe(2);
      expect((await page()).events.map((e) => e.summary)).toEqual(['0 days ago', '1 days ago', '89 days ago']);
      expect(await log.prune(7)).toBe(1);
      expect(await log.prune(7)).toBe(0);
    });

    it('keeps retention inside 7 to 365 days whatever it is told', async () => {
      now = Date.UTC(2026, 10, 2, 12) - 8 * DAY;
      log.record(who, { kind: 'settings.changed', summary: 'eight days old' });
      await log.idle();
      now = Date.UTC(2026, 10, 2, 12);
      expect(await log.prune(0)).toBe(1);
      now = Date.UTC(2026, 10, 2, 12) - 400 * DAY;
      log.record(who, { kind: 'settings.changed', summary: 'old' });
      await log.idle();
      now = Date.UTC(2026, 10, 2, 12);
      expect(await log.prune(10_000)).toBe(1);
    });

    it('caps the table so a flood cannot fill the disk before retention would act', async () => {
      const rows = Array.from({ length: AUDIT_MAX_ROWS + 3 }, (_, i) => ({ id: `id-${i}`, at: now - i, kind: 'signin.failed', actorId: null, actor: null, target: null, summary: 'x', detail: null, ip: null }));
      for (let i = 0; i < rows.length; i += 500) await db.insert(auditEvents).values(rows.slice(i, i + 500));
      expect(await log.prune(90)).toBe(3);
      expect((await db.select({ n: sql<number>`count(*)` }).from(auditEvents).get())?.n).toBe(AUDIT_MAX_ROWS);
      // The newest stay.
      expect((await db.select({ id: auditEvents.id }).from(auditEvents).where(sql`${auditEvents.id} = 'id-0'`).get())?.id).toBe('id-0');
    }, 60_000);
  });
});

describe('what the log may keep of a value', () => {
  it('scrubs the credentials people paste into places', () => {
    const hostile = [
      'sk-ant-api03-AbCdEf0123456789',
      'sk-proj-abcdefghijklmnop',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789_abcdef',
      'xoxb-123456789012-abcdefghij',
      'AKIAABCDEFGHIJKLMNOP',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-DEF_123',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-DEF_123',
      'https://user:hunter2@example.com/path',
      'https://example.com/cb?access_token=abc123def456&x=1',
      'password = "correct-horse-battery"',
      '"apiKey":"abcd1234efgh5678"',
      'cookie: atelier_session=abc123',
      'a'.repeat(20) + '1' + 'b'.repeat(30),
    ];
    for (const text of hostile) {
      const out = scrubText(`before ${text} after`);
      expect(out).toContain('[hidden]');
      expect(out).not.toMatch(/AbCdEf0123|abcdefghijklmnop|hunter2|abc123def456|correct-horse|abcd1234efgh|session=abc123|eyJhbGci/);
    }
  });

  it('leaves ordinary words, ids and usernames alone', () => {
    for (const text of ['Changed server.signup: invite → open', 'bob', 'ollama:llama3.1:8b', '0b6f2f1e-9d0b-4c46-8c75-0f6f4f1d1a11', 'Created the account ada.lovelace']) expect(scrubText(text)).toBe(text);
  });

  it('keeps only small plain values', () => {
    expect([true, 5, null, 'open', 'a b c'].map(smallValue)).toEqual([true, 5, null, 'open', 'a b c']);
    for (const bad of [undefined, {}, [], Number.NaN, 'x'.repeat(61), 'a\nb', 'sk-abcdefghijkl', '/etc/passwd', '~/secret', 'C:\\Users\\x', '${secret:a}']) expect(smallValue(bad)).toBeUndefined();
  });

  it('knows which settings paths may hold a secret', () => {
    for (const path of [['providers', 0, 'apiKey'], ['x', 'Authorization'], ['mcpServers', 'a', 'headers'], ['mcpServers', 'a', 'env', 'X'], ['cloud', 'github', 'token'], ['hooks', 'Stop', 0, 'command']]) expect(secretPath(path)).toBe(true);
    for (const path of [['server', 'signup'], ['models', 'overrides', 'a', 'hidden'], ['imageGeneration', 'maxImagesPerTurn'], [0, 1]]) expect(secretPath(path)).toBe(false);
  });

  it('reduces an address to its host, and nothing else to anything', () => {
    expect(hostOf('http://user:pw@10.0.0.9:11434/v1?key=1')).toBe('10.0.0.9');
    expect(hostOf('not an address')).toBeNull();
    expect(oneLine(' a\u0000b\n\tc  ')).toBe('a b c');
    expect(oneLine('x'.repeat(50), 10)).toHaveLength(10);
  });
});
