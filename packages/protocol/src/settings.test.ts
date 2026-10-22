import { describe, expect, it } from 'vitest';
import { defaultModelFor, defaultSettings } from './settings.ts';

describe('defaultModelFor', () => {
  it('has nothing to start with until a default is set', () => {
    expect(defaultModelFor(defaultSettings(), 'code')).toBeUndefined();
  });

  it('lets Cowork and Code follow the default for everyone', () => {
    const settings = defaultSettings();
    settings.models.defaults.chat = 'anthropic/sonnet';
    expect(defaultModelFor(settings, 'chat')).toBe('anthropic/sonnet');
    expect(defaultModelFor(settings, 'work')).toBe('anthropic/sonnet');
    expect(defaultModelFor(settings, 'code')).toBe('anthropic/sonnet');
  });

  it('prefers a default set for the mode itself', () => {
    const settings = defaultSettings();
    settings.models.defaults.chat = 'anthropic/sonnet';
    settings.models.defaults.code = 'openai/gpt';
    expect(defaultModelFor(settings, 'code')).toBe('openai/gpt');
    expect(defaultModelFor(settings, 'work')).toBe('anthropic/sonnet');
  });
});
