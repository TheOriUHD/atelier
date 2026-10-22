/**
 * Atelier's structural tags in what models read (docs/PROMPTS.md §1.7). Text Atelier didn't write (the person's
 * messages, attachments, tool output, file contents, commit subjects, connector descriptions, skill bodies) could
 * otherwise forge one, such as a fake `<context-update>` or a `</document>` that ends its container early, so those
 * tags get their `<` replaced by `‹` in what the model reads. Tools that put the model's text into files, artifacts,
 * commands or search patterns turn exactly these forms back, and so does the transcript, so what people see, copy and
 * get written matches what it came from.
 */
export const ATELIER_TAGS = [
  'context-update',
  'workspace_content_settings',
  'instructions',
  'env',
  'project',
  'document',
  'command',
  'user_instructions',
  'available_skills',
  'skill',
  'connector_instructions',
  'tool_call',
  'tool_result',
  // The wrappers of the summarizer's transcript and of the page WebFetch's helper model reads.
  'transcript',
  'page',
  // What Atelier remembers about the person (memory digest).
  'memory',
] as const;

const NAMES = new Set<string>(ATELIER_TAGS);
// A name after `<` or `</` (whitespace allowed), then the shape of a tag: `>`, `/>`, a quoted attribute or any other
// word after whitespace. Matched in any case; `isTag` decides which spellings count.
const TAG = `(\\s*(/?)\\s*(${ATELIER_TAGS.join('|')}))(?=(\\s*/?>|\\s+[A-Za-z_][\\w:-]*\\s*=\\s*"|\\s+[A-Za-z_]))`;
const ESCAPE = new RegExp(`<${TAG}`, 'gi');
const UNESCAPE = new RegExp(`‹${TAG}`, 'gi');

/**
 * The exact lower-case name counts in every shape. A compound name (`Context-Update`, `TOOL_RESULT`) counts in any
 * case too, since code never spells a type that way. A one-word name in another case is usually code: a generic type
 * (`Promise<Env>`, `Map<Env, Project>`, `<Env extends Base>`) or a component (`<Document file={pdf}>`). It counts only
 * where code of that kind rarely goes and Atelier's own tags do: as a closing tag (`</Document>`), or with a quoted
 * attribute (`<Instructions source="…">`). The price is that JSX components named like Atelier's tags, such as
 * `<Command className="…">`, read escaped too; the writing tools turn them back.
 */
function isTag(slash: string, name: string, shape: string): boolean {
  if (NAMES.has(name) || /[-_]/.test(name)) return true;
  return slash === '/' || shape.includes('"');
}

export function escapeTags(text: string): string {
  return text.replace(ESCAPE, (match, tag: string, slash: string, name: string, shape: string) => (isTag(slash, name, shape) ? `‹${tag}` : match));
}

export function unescapeTags(text: string): string {
  return text.replace(UNESCAPE, (match, tag: string, slash: string, name: string, shape: string) => (isTag(slash, name, shape) ? `<${tag}` : match));
}
