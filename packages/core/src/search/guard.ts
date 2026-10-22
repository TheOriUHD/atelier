/**
 * What may leave this machine as a search query. A page the model read can tell it to "search for" something it
 * shouldn't repeat to a third party; a query is the cheapest way to smuggle a value out, so credentials never go.
 */
const MAX_QUERY = 400;

const SECRET_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export type Checked = { ok: true; query: string } | { ok: false; message: string };

/** The query as it will be sent (one line, trimmed), or why it won't be. */
export function checkQuery(raw: string, secretValues: readonly string[] = []): Checked {
  const query = raw.replace(/\s+/g, ' ').trim();
  if (query.length < 2) return { ok: false, message: 'The query is empty.' };
  if (query.length > MAX_QUERY) return { ok: false, message: `The query is too long (${query.length} characters; the limit is ${MAX_QUERY}). Search for the few words that matter.` };
  if (SECRET_SHAPES.some((p) => p.test(query)) || secretValues.some((v) => v.length >= 8 && query.includes(v))) {
    return { ok: false, message: 'The query contains what looks like a credential, so it was not sent. Search without keys, tokens or passwords.' };
  }
  return { ok: true, query };
}
