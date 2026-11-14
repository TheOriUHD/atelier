/**
 * The Cloudflare bindings the report collector, the admin Worker and the update feed's counting use, faked for
 * `node --test`: D1 as a small adapter over node:sqlite with the real migrations applied, R2 as a Map, and a rate
 * limiter. Shared by deploy/reports, deploy/admin and deploy/cloudflare's tests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

/** D1's binding types: undefined is an error there (D1_TYPE_ERROR), booleans become 1 and 0. */
function value(v) {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: Type undefined is not supported for value undefined');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/** A D1 database (prepare/bind/first/all/run/raw, batch, exec) in memory, with deploy/admin/migrations applied. */
export function fakeD1({ migrate = true } = {}) {
  const db = new DatabaseSync(':memory:');
  if (migrate)
    for (const name of readdirSync(MIGRATIONS)
      .filter((n) => n.endsWith('.sql'))
      .sort())
      db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
  /** Every statement run, for tests that look at what was asked. */
  const log = [];
  const returnsRows = (sql) => /^\s*(?:select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);

  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new Statement(this.sql, params.map(value));
    }
    /** Runs now and returns D1's result shape: `{ results, success, meta }`. */
    execute() {
      log.push({ sql: this.sql, params: this.params });
      const statement = db.prepare(this.sql);
      if (returnsRows(this.sql)) {
        const results = statement.all(...this.params).map((r) => ({ ...r }));
        return { results, success: true, meta: { changes: 0, rows_read: results.length } };
      }
      const info = statement.run(...this.params);
      return {
        results: [],
        success: true,
        meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      };
    }
    async first(column) {
      const row = this.execute().results[0];
      if (!row) return null;
      return column === undefined ? row : (row[column] ?? null);
    }
    async all() {
      return this.execute();
    }
    async run() {
      return this.execute();
    }
    async raw() {
      return this.execute().results.map((r) => Object.values(r));
    }
  }

  return {
    sqlite: db,
    log,
    prepare: (sql) => new Statement(sql),
    /** All or nothing, like D1. */
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => s.execute());
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    /** Every row of every table, for tests that look for what must never be stored. */
    dump() {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all();
      return Object.fromEntries(
        tables.map(({ name }) => [
          name,
          db
            .prepare(`SELECT * FROM "${name}"`)
            .all()
            .map((r) => ({ ...r })),
        ]),
      );
    },
  };
}

const toBytes = async (v) => {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  if (v instanceof ReadableStream) return new Uint8Array(await new Response(v).arrayBuffer());
  throw new TypeError('unsupported R2 value');
};

/** An R2 bucket as a Map of key → { bytes, httpMetadata }. */
export function fakeR2() {
  const objects = new Map();
  const object = (key, o) => ({
    key,
    size: o.bytes.byteLength,
    httpMetadata: { ...o.httpMetadata },
    customMetadata: { ...o.customMetadata },
    httpEtag: '"fake"',
    uploaded: new Date(o.at),
    writeHttpMetadata(headers) {
      if (o.httpMetadata.contentType) headers.set('content-type', o.httpMetadata.contentType);
    },
  });
  return {
    objects,
    async put(key, v, options = {}) {
      const o = {
        bytes: await toBytes(v),
        httpMetadata: options.httpMetadata ?? {},
        customMetadata: options.customMetadata ?? {},
        at: Date.now(),
      };
      objects.set(key, o);
      return object(key, o);
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      const copy = o.bytes.slice();
      return {
        ...object(key, o),
        body: new Blob([copy]).stream(),
        arrayBuffer: async () => copy.buffer,
        text: async () => new TextDecoder().decode(copy),
        json: async () => JSON.parse(new TextDecoder().decode(copy)),
      };
    },
    async head(key) {
      const o = objects.get(key);
      return o ? object(key, o) : null;
    },
    async delete(keys) {
      for (const key of [].concat(keys)) objects.delete(key);
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map((k) => object(k, objects.get(k))),
        truncated,
        ...(truncated ? { cursor: String(start + limit) } : {}),
        delimitedPrefixes: [],
      };
    },
  };
}

/** A rate limiting binding that lets `limit` calls per key through, and remembers the keys it saw. */
export function fakeLimiter(limit = Infinity) {
  const seen = new Map();
  return {
    seen,
    async limit({ key }) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return { success: seen.get(key) <= limit };
    },
  };
}

/** `ctx` for a Worker's fetch or scheduled handler: collects what was handed to waitUntil. */
export function fakeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil: (p) => void pending.push(Promise.resolve(p)),
    passThroughOnException() {},
    /** Waits for everything handed to waitUntil so far, and what that handed on. */
    async settle() {
      for (let i = 0; i < pending.length; i++) await pending[i];
    },
  };
}
