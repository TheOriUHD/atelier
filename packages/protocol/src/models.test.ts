import { describe, expect, it } from 'vitest';
import { chatGptPlanLabel, ModelInfo, modelRef, parseModelRef } from './models.ts';
import { defaultSettings, SettingsSchema } from './settings.ts';
import { UserPrefs, defaultUserPrefs } from './accounts.ts';

describe('model refs', () => {
  it.each([['prolite', 'Pro 100'], ['pro', 'Pro 200'], ['promax', 'Pro 500'], ['pro_500', 'Pro 500'], ['plus', 'Plus']])('labels subscription %s consistently', (raw, label) => {
    expect(chatGptPlanLabel(raw)).toBe(label);
  });
  it('splits on the first slash only', () => {
    expect(parseModelRef('openrouter/anthropic/claude-x')).toEqual({ providerId: 'openrouter', modelId: 'anthropic/claude-x' });
    expect(parseModelRef(modelRef('ollama', 'library/qwen3:32b'))).toEqual({ providerId: 'ollama', modelId: 'library/qwen3:32b' });
  });
  it('rejects malformed refs', () => {
    expect(parseModelRef('noslash')).toBeNull();
    expect(parseModelRef('/x')).toBeNull();
    expect(parseModelRef('x/')).toBeNull();
  });
});

describe('settings schema', () => {
  it('fills defaults for an empty document', () => {
    const s = defaultSettings();
    expect(s.server.signup).toBe('invite');
    expect(s.providers).toEqual([]);
    expect(s.context.autoCompactAt).toBe(0.85);
  });
  it('fills per-user preference defaults separately', () => {
    const p = defaultUserPrefs();
    expect(p.appearance.theme).toBe('system');
    expect(p.appearance.chatFont).toBe('serif');
    expect(p.appearance.interfaceFont).toBe('sans');
    expect(p.code).toEqual({ font: '', syntaxTheme: { light: 'atelier-light', dark: 'atelier-dark' }, transcriptView: 'normal', suggestions: true });
    expect(UserPrefs.safeParse({ appearance: { theme: 'neon' } }).success).toBe(false);
    // Stored before these keys existed: defaults fill in.
    expect(UserPrefs.parse({ appearance: { theme: 'dark' }, code: { font: 'Fira Code' } }).code.syntaxTheme.dark).toBe('atelier-dark');
    expect(UserPrefs.safeParse({ code: { font: 'Fira"; color: red' } }).success).toBe(false);
    expect(UserPrefs.safeParse({ code: { syntaxTheme: { light: '../evil' } } }).success).toBe(false);
  });
  it('rejects provider ids containing a slash', () => {
    const r = SettingsSchema.safeParse({ providers: [{ id: 'a/b', type: 'ollama', name: 'x', baseUrl: 'http://x' }] });
    expect(r.success).toBe(false);
  });
});

describe('effort stops', () => {
  const model = (stop: Record<string, unknown>) => ({
    ref: 'p/m', providerId: 'p', modelId: 'm', displayName: 'M', contextLength: 1000, maxOutput: 100,
    capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'effort', caching: false },
    tier: 'full', source: 'detected', hidden: false, favorite: false, order: 0,
    effortStops: [{ effort: 'low', label: 'Instant' }, stop],
  });
  // The effort control reads this over RPC: a schema that does not name the flag would strip it before the UI sees it.
  it('keeps a stop’s `featured` flag, takes a stop without it, and refuses one that is not a boolean', () => {
    expect(ModelInfo.parse(model({ effort: 'max', label: 'Pro', featured: true })).effortStops![1]).toEqual({ effort: 'max', label: 'Pro', featured: true });
    expect(ModelInfo.parse(model({ effort: 'max', label: 'Pro' })).effortStops![1]!.featured).toBeUndefined();
    expect(ModelInfo.safeParse(model({ effort: 'max', label: 'Pro', featured: 'yes' })).success).toBe(false);
  });
});
