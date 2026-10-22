/**
 * Escaping for what models read (docs/PROMPTS.md §1.7). The rule for Atelier's tags lives in the protocol, because the
 * transcript turns them back too. Tools that put the model's text into files, artifacts, commands or search patterns
 * (Write, Edit, Bash, artifact, Grep, Glob) undo it, so text copied from escaped output still matches what it came from.
 */
export { escapeTags, unescapeTags } from '@atelier/protocol';

/** An attribute value Atelier writes into one of its own tags. */
export function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** An attribute value read back from one of Atelier's tags. */
export function unescapeAttr(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
