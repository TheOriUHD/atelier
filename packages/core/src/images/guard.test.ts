import { describe, expect, it } from 'vitest';
import { refusedError } from './guard.ts';

describe('refusedError', () => {
  it('says what the provider said, without the words of an ordinary failed request around it', () => {
    expect(refusedError('OpenAI', 'OpenAI request failed (400): Blocked by the content policy.').message).toBe('OpenAI refused this: Blocked by the content policy.');
  });

  it('takes a plain reason, or none', () => {
    expect(refusedError('OpenAI', 'Blocked.').message).toBe('OpenAI refused this: Blocked.');
    expect(refusedError('OpenAI').message).toBe('OpenAI refused this.');
  });
});
