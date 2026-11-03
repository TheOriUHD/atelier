import { describe, expect, it } from 'vitest';
import { createGenerateImageTool } from './generate-image.ts';
import { describeTool } from './types.ts';

describe('GenerateImage description', () => {
  const tool = createGenerateImageTool({ generate: async () => ({ content: [] }) });

  it('tells the model how a marked area reaches it, in both tiers', () => {
    for (const tier of ['full', 'compact'] as const) {
      const text = describeTool(tool, { tier, mode: 'chat', has: () => false }).description;
      expect(text).toContain('mask');
      expect(text).toContain('reference_images');
    }
    const full = describeTool(tool, { tier: 'full', mode: 'chat', has: () => false }).description;
    expect(full).toContain("If the model can't change one area, the result says which can");
  });

  it('takes the mask as an image id like any other, never a path', () => {
    const mask = (tool.inputSchema as { properties: { mask: { pattern: string } } }).properties.mask;
    expect(new RegExp(mask.pattern).test('img_ab12cd34')).toBe(true);
    expect(new RegExp(mask.pattern).test('/etc/passwd')).toBe(false);
  });
});
