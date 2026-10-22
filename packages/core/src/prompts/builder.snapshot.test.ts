/**
 * The assembled prompt of every kind of session as reviewable text (docs/PROMPTS.md §10): a change to a template, a
 * tool description or the assembly shows up as a diff in `__snapshots__/prompts/`. Update with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { assemble, CASES, describeCase } from './__fixtures__/prompt-cases.ts';

describe('assembled prompts', () => {
  for (const [name, c] of Object.entries(CASES)) {
    it(name, async () => {
      await expect(describeCase(await assemble(c))).toMatchFileSnapshot(`__snapshots__/prompts/${name}.txt`);
    });
  }
});
