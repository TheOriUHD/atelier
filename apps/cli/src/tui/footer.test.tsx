import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Paint, palette } from '../style.ts';
import { Footer, type FooterInfo } from './footer.tsx';

const info: FooterInfo = { mode: 'acceptEdits', contextPercent: 12, where: 'this computer', connected: true, model: 'qwen3:30b', effort: 'Medium', queued: 0, tasks: 0 };
const line = (columns: number, over: Partial<FooterInfo> = {}) => render(<Footer info={{ ...info, ...over }} paint={new Paint(palette('dark', 0))} columns={columns} />).lastFrame() ?? '';

describe('the footer', () => {
  it('shows the mode with its key, the context, the connection and the model in a wide terminal', () => {
    const text = line(120);
    expect(text).toContain('⏵⏵ Accept edits (shift+tab) · ctx 12% · ● this computer');
    expect(text.trimEnd().endsWith('qwen3:30b · Medium')).toBe(true);
  });

  it('keeps the model whole in a narrow terminal, leaving out the key and cutting what doesn’t fit', () => {
    const narrow = line(74);
    expect(narrow).not.toContain('(shift+tab)');
    expect(narrow).toMatch(/● this computer\s{2,}qwen3:30b · Medium/);
    const tiny = line(52, { where: 'atelier.example.com' });
    expect(tiny.trimEnd().endsWith('qwen3:30b · Medium')).toBe(true);
    expect(tiny).toContain('…');
    expect(tiny.length).toBeLessThanOrEqual(52);
  });
});
