/**
 * Resolves `${secret:<id>}`, `${ENV}` and `${ENV:-default}` references inside a string.
 * Unknown env vars without a default resolve to '' and are reported via `missing`.
 */
const PATTERN = /\$\{(secret:([A-Za-z0-9._-]+)|([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?)\}/g;

export interface Resolvers {
  secret: (id: string) => Promise<string | undefined>;
  /** null leaves the reference as written, for where the value is used to fill in (a program on a person's desktop). */
  env: (name: string) => string | undefined | null;
}

export async function interpolate(input: string, resolvers: Resolvers): Promise<{ value: string; missing: string[] }> {
  const missing: string[] = [];
  const replacements = new Map<string, string>();
  for (const match of input.matchAll(PATTERN)) {
    const [token, , secretId, envName, envDefault] = match;
    if (replacements.has(token)) continue;
    if (secretId) {
      const v = await resolvers.secret(secretId);
      if (v === undefined) missing.push(`secret:${secretId}`);
      replacements.set(token, v ?? '');
    } else if (envName) {
      const v = resolvers.env(envName);
      if (v === null) {
        replacements.set(token, token);
        continue;
      }
      if (v === undefined && envDefault === undefined) missing.push(envName);
      replacements.set(token, v ?? envDefault ?? '');
    }
  }
  return { value: input.replace(PATTERN, (t) => replacements.get(t) ?? ''), missing };
}

/** Secret ids referenced by a string, used to show where a secret is used. */
export function secretRefs(input: string): string[] {
  return [...input.matchAll(PATTERN)].map((m) => m[2]).filter((id): id is string => Boolean(id));
}
