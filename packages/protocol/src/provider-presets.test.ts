import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, presetOf } from './provider-presets.ts';

describe('presetOf', () => {
  it('knows each preset by its own address and anything else on its host', () => {
    for (const preset of PROVIDER_PRESETS) expect(presetOf(preset.baseUrl)).toBe(preset.id);
    expect(presetOf('https://www.openrouter.ai/api/v1/')).toBe('openrouter');
    expect(presetOf('http://localhost:1234/v1')).toBeUndefined();
    expect(presetOf('https://notopenrouter.ai/api/v1')).toBeUndefined();
    expect(presetOf('not a url')).toBeUndefined();
  });
});
