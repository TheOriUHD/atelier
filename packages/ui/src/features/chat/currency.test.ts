import { describe, expect, it } from 'vitest';
import { protectCurrency } from './currency.ts';

describe('dollar amounts are not math', () => {
  it('escapes prices, however many are in a paragraph', () => {
    expect(protectCurrency('**HomeView ($299)** is new; HomePod mini 2 ($149) and Apple TV 4K ($299, also $59 standalone).')).toBe(
      '**HomeView (\\$299)** is new; HomePod mini 2 (\\$149) and Apple TV 4K (\\$299, also \\$59 standalone).',
    );
    expect(protectCurrency('Pay $5 or $10, about ~$1,295 in all, mounts from $59.95.')).toBe('Pay \\$5 or \\$10, about ~\\$1,295 in all, mounts from \\$59.95.');
    expect(protectCurrency('US$5 and EUR 5$ and a lone $')).toBe('US\\$5 and EUR 5\\$ and a lone \\$');
  });

  it('leaves real inline math alone', () => {
    for (const math of ['inline $x^2$ is math', 'both $a$ and $b$ here', 'digits $2x+3$.', 'greek $\\alpha + \\beta$, then more', '($E = mc^2$)']) expect(protectCurrency(math)).toBe(math);
  });

  it('leaves display math, code and escaped dollars alone', () => {
    const same = ['$$E = mc^2$$', 'a $$\\sum_{i=1}^n i$$ here', 'run `echo $5 and $10` now', 'already \\$5 and \\$10', 'a ``code with ` $9`` span'];
    for (const text of same) expect(protectCurrency(text)).toBe(text);
    const fenced = 'text $5\n\n```sh\necho $HOME $PATH\n```\n\nafter $7';
    expect(protectCurrency(fenced)).toBe('text \\$5\n\n```sh\necho $HOME $PATH\n```\n\nafter \\$7');
  });

  it('keeps math next to prices working', () => {
    expect(protectCurrency('It costs ($299) and $x^2$ stays math')).toBe('It costs (\\$299) and $x^2$ stays math');
  });

  it('works over several lines of one paragraph and leaves text without dollars untouched', () => {
    expect(protectCurrency('line one $5\nline two $10')).toBe('line one \\$5\nline two \\$10');
    const plain = 'nothing to do here\n\n- a list\n- of things';
    expect(protectCurrency(plain)).toBe(plain);
  });
});
