/**
 * A string field of tool-call JSON that may still be streaming (`{"title": "Tal…`): what has arrived of it so far, or
 * undefined while its key hasn't. An escape cut off at the end (`\`, `\u00`) waits for the rest.
 */
export function partialField(json: string | undefined, field: string): string | undefined {
  const match = json && new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]!.replace(/\\(u[0-9a-fA-F]{0,3})?$/, '')}"`) as string;
  } catch {
    return undefined;
  }
}
