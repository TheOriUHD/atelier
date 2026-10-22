import { describe, expect, it } from 'vitest';
import { INLINE_VISUAL_HTML_MAX, InlineVisual } from '@atelier/protocol';
import { createInlineVisualTool } from './inline-visual.ts';
import { describeTool, orderTools, type ToolContext } from './types.ts';
import { decide } from '../permissions/engine.ts';

const input = { title: 'Orbit', html: '<p>Orbit</p>', description: 'A planet orbiting a star.' };
const ctx = {} as ToolContext;

describe('inline_visual', () => {
  it('validates bounded required strings at the backend, without echoing HTML', async () => {
    const tool = createInlineVisualTool();
    expect(tool.readOnly).toBe(true);
    expect(await tool.run(input, ctx)).toEqual({ content: [{ type: 'text', text: 'Inline visual shown.' }] });
    expect(InlineVisual.safeParse({ ...input, html: 'x'.repeat(INLINE_VISUAL_HTML_MAX) }).success).toBe(true);
    for (const bad of [null, {}, { ...input, title: ' ' }, { ...input, title: 'x'.repeat(121) }, { ...input, description: '' }, { ...input, description: 'x'.repeat(1001) }, { ...input, html: ' ' }, { ...input, html: 'x'.repeat(INLINE_VISUAL_HTML_MAX + 1) }, { ...input, extra: true }]) {
      expect((await tool.run(bad as typeof input, ctx)).isError).toBe(true);
    }
  });

  it('carries focused design guidance in both tool-description tiers', () => {
    const tool = createInlineVisualTool();
    for (const tier of ['full', 'compact'] as const) {
      const description = describeTool(tool, { tier, mode: 'chat', has: (name) => name === 'artifact' }).description;
      for (const term of ['HTML fragment', 'script last', 'no external network', '--text-primary', '--surface-1', '--border-strong', 'keyboard', 'requestAnimationFrame', 'elapsed time', 'prefers-reduced-motion', 'not for every answer', 'standalone deliverable']) expect(description).toContain(term);
    }
    expect(orderTools([{ name: 'mcp__x' }, { name: 'inline_visual' }, { name: 'artifact' }]).map((t) => t.name)).toEqual(['artifact', 'inline_visual', 'mcp__x']);
  });

  it.each(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const)('is safe display in %s mode', (mode) => {
    const permission = { mode, cwd: '/work', projectRoot: '/work', home: '/home/test', roots: ['/work'], rules: { allow: [], ask: [], deny: [] }, isReadOnly: () => true };
    expect(decide({ name: 'inline_visual', input }, permission).behavior).toBe('allow');
    expect(decide({ name: 'inline_visual', input }, { ...permission, rules: { ...permission.rules, deny: ['inline_visual'] } }).behavior).toBe('deny');
  });
});
