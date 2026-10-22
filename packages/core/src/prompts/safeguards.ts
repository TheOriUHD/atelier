/**
 * The optional safeguards block (docs/PROMPTS.md §9). Off by default: then nothing is added anywhere and the prompt
 * never mentions safeguards. An admin turns them on for everyone (settings) or per person (the user record).
 */
import { createHash } from 'node:crypto';
import { effectiveSafeguards, type PromptTier, type SafeguardsOverride, type SafeguardsSettings } from '@atelier/protocol';
import { render, resolveGuards, template, type Overrides } from './templates.ts';

/** The rendered block and a hash of it; a session's snapshot is rebuilt when the hash changes. */
export interface SafeguardsBlock {
  text: string;
  hash: string;
}

/** The block for a person, or null when nothing applies to them (then nothing about safeguards reaches the model). */
export function safeguardsBlock(system: SafeguardsSettings, person: SafeguardsOverride, tier: PromptTier, overrides: Overrides): SafeguardsBlock | null {
  const effective = effectiveSafeguards(system, person);
  if (!effective) return null;
  const name = `safeguards.${tier}`;
  const sections: Record<string, boolean> = { ...system.categories, younger: effective.younger };
  const resolved = resolveGuards(template(name, overrides), (cond) => sections[cond], name);
  const crisis = system.crisisResources.trim();
  const text = render(resolved, { crisis: crisis ? `; you can mention: ${crisis}` : '' });
  return { text, hash: createHash('sha256').update(text).digest('hex') };
}
