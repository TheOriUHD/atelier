import { describe, expect, it } from 'vitest';
import type { SecretSummary } from '@atelier/protocol';
import {
  formFromConfig,
  formFromDetected,
  keyHint,
  newProviderForm,
  renameForm,
  slugify,
  toDraft,
  uniqueId,
  validateProviderForm,
} from './provider-form.ts';

const none = new Set<string>();
const create = { taken: none, editing: false, hasStoredKey: false };

describe('provider ids', () => {
  it('slugifies names into valid provider ids', () => {
    expect(slugify('Homelab Ollama')).toBe('homelab-ollama');
    expect(slugify('  --LM Studio (GPU #2)-- ')).toBe('lm-studio-gpu-2');
    expect(slugify('Café Llama')).toBe('cafe-llama');
    expect(slugify('llama.cpp')).toBe('llama-cpp');
    expect(slugify('日本')).toBe('');
    expect(slugify('a'.repeat(60) + ' b')).toBe('a'.repeat(48));
    expect(slugify('x'.repeat(47) + ' y')).toBe('x'.repeat(47));
  });

  it('suffixes taken ids and keeps them within 48 characters', () => {
    expect(uniqueId('ollama', none)).toBe('ollama');
    expect(uniqueId('ollama', new Set(['ollama', 'ollama-2']))).toBe('ollama-3');
    expect(uniqueId('', none)).toBe('provider');
    const long = 'a'.repeat(48);
    expect(uniqueId(long, new Set([long]))).toBe('a'.repeat(46) + '-2');
  });

  it('follows the name until the id is edited', () => {
    const taken = new Set(['ollama']);
    const form = newProviderForm('ollama', taken);
    expect(form).toMatchObject({ name: 'Ollama', id: 'ollama-2', baseUrl: 'http://localhost:11434' });
    const renamed = renameForm(form, 'GPU box', taken);
    expect(renamed.id).toBe('gpu-box');
    const edited = renameForm({ ...renamed, id: 'mine', idEdited: true }, 'Something else', taken);
    expect(edited).toMatchObject({ name: 'Something else', id: 'mine' });
  });

  it('keeps the id of an existing provider', () => {
    const form = formFromConfig({ id: 'lab', type: 'ollama', name: 'Lab', baseUrl: 'http://lab:11434', headers: { 'X-A': '1' }, enabled: false });
    expect(renameForm(form, 'Renamed', none).id).toBe('lab');
    expect(form.headers).toEqual([{ name: 'X-A', value: '1' }]);
    expect(form.enabled).toBe(false);
  });
});

describe('validateProviderForm', () => {
  it('accepts a complete local provider without a key', () => {
    expect(validateProviderForm(newProviderForm('ollama', none), create)).toEqual({});
  });

  it('reports each invalid field', () => {
    const form = { ...newProviderForm('openai-compatible', none), name: ' ', id: 'Bad Id', baseUrl: 'localhost:1234' };
    expect(Object.keys(validateProviderForm(form, create)).sort()).toEqual(['baseUrl', 'id', 'name']);
    expect(validateProviderForm({ ...form, baseUrl: 'ftp://host' }, create).baseUrl).toBeDefined();
  });

  it('rejects an id that is already taken, unless editing that provider', () => {
    const form = newProviderForm('ollama', none);
    expect(validateProviderForm(form, { ...create, taken: new Set(['ollama']) }).id).toMatch(/already/);
    expect(validateProviderForm(form, { taken: new Set(['ollama']), editing: true, hasStoredKey: false }).id).toBeUndefined();
  });

  it('requires a key for hosted APIs unless one is stored or comes from the environment', () => {
    const form = newProviderForm('anthropic', none);
    expect(validateProviderForm(form, create).apiKey).toBe('Anthropic needs an API key.');
    expect(validateProviderForm({ ...form, apiKey: 'sk-test' }, create).apiKey).toBeUndefined();
    expect(validateProviderForm({ ...form, apiKeyFromEnv: 'ANTHROPIC_API_KEY' }, create).apiKey).toBeUndefined();
    expect(validateProviderForm(form, { taken: none, editing: true, hasStoredKey: true }).apiKey).toBeUndefined();
  });

  it('checks header names and duplicates, ignoring empty rows', () => {
    const form = newProviderForm('ollama', none);
    expect(validateProviderForm({ ...form, headers: [{ name: '', value: '' }] }, create)).toEqual({});
    expect(validateProviderForm({ ...form, headers: [{ name: 'Bad Name', value: 'x' }] }, create).headers).toBeDefined();
    expect(validateProviderForm({ ...form, headers: [{ name: '', value: 'x' }] }, create).headers).toBeDefined();
    const dupes = [
      { name: 'X-Key', value: '1' },
      { name: 'x-key', value: '2' },
    ];
    expect(validateProviderForm({ ...form, headers: dupes }, create).headers).toMatch(/once/);
  });
});

describe('VRAM budget', () => {
  it('accepts fractional GB, converts to stored GiB, and round-trips edits and clearing', () => {
    const form = newProviderForm('ollama', none);
    expect(toDraft(form)).not.toHaveProperty('vramGiB');
    for (const vramGB of ['0', '-1', 'Infinity', 'NaN', 'abc', '1048577']) {
      expect(validateProviderForm({ ...form, vramGB }, create).vramGB).toBeDefined();
    }
    expect(validateProviderForm({ ...form, vramGB: ' 24.5 ' }, create)).toEqual({});
    const draft = toDraft({ ...form, vramGB: ' 24.5 ' });
    expect(draft.vramGiB).toBe(24.5 * 1e9 / 1024 ** 3);
    const edited = formFromConfig(draft);
    expect(edited.vramGB).toBe('24.5');
    expect(toDraft({ ...edited, vramGB: '' })).not.toHaveProperty('vramGiB');
    const existing = { ...draft, vramGiB: 16 };
    expect(formFromConfig(existing).vramGB).toBe('17.179869184');
    expect(toDraft(formFromConfig(existing)).vramGiB).toBe(16);
  });
});

describe('server capacity', () => {
  it('is automatic when empty, else a whole number in range, and round-trips through settings', () => {
    const form = newProviderForm('ollama', none);
    expect(toDraft(form)).not.toHaveProperty('parallelRequests');
    expect(validateProviderForm({ ...form, parallelRequests: '0', modelsAtOnce: '1.5' }, create)).toMatchObject({
      parallelRequests: expect.stringMatching(/1 to 64/),
      modelsAtOnce: expect.stringMatching(/1 to 16/),
    });
    expect(toDraft({ ...form, parallelRequests: ' 4 ', modelsAtOnce: '2' })).toMatchObject({ parallelRequests: 4, modelsAtOnce: 2 });
    const edited = formFromConfig({ id: 'lab', type: 'llamacpp', name: 'Lab', baseUrl: 'http://lab:8080', headers: {}, enabled: true, parallelRequests: 4 });
    expect(edited).toMatchObject({ parallelRequests: '4', modelsAtOnce: '' });
  });
});

describe('toDraft', () => {
  it('trims fields, drops empty headers and leaves the key out when none was typed', () => {
    const form = { ...newProviderForm('ollama', none), name: ' Lab ', baseUrl: ' http://lab:11434 ', headers: [{ name: ' X-A ', value: 'v' }, { name: '', value: '' }] };
    const draft = toDraft(form);
    expect(draft).toEqual({ id: 'ollama', type: 'ollama', name: 'Lab', baseUrl: 'http://lab:11434', headers: { 'X-A': 'v' }, enabled: true });
    expect('apiKey' in draft).toBe(false);
  });

  it('passes a typed key, or the environment variable instead of it', () => {
    const form = newProviderForm('openai', none);
    expect(toDraft({ ...form, apiKey: ' sk-1 ' }).apiKey).toBe('sk-1');
    const detected = formFromDetected({ type: 'openai', baseUrl: 'https://api.openai.com', label: 'OpenAI', via: 'env', envVar: 'OPENAI_API_KEY' }, none);
    const draft = toDraft({ ...detected, apiKey: 'ignored' });
    expect(draft.apiKeyFromEnv).toBe('OPENAI_API_KEY');
    expect(draft.apiKey).toBeUndefined();
  });
});

describe('keyHint', () => {
  const secrets: SecretSummary[] = [
    { id: 'provider-anthropic', label: 'Anthropic API key', kind: 'api_key', masked: '••••3f9a', usedBy: [], createdAt: 0, rotatedAt: null, lastUsedAt: null },
  ];

  it('never reveals a key: masked tail, environment reference or dots', () => {
    expect(keyHint(undefined, secrets)).toBeUndefined();
    expect(keyHint('${secret:provider-anthropic}', secrets)).toBe('••••3f9a');
    expect(keyHint('${secret:gone}', secrets)).toBe('••••');
    expect(keyHint('${OPENAI_API_KEY}', secrets)).toBe('${OPENAI_API_KEY}');
    expect(keyHint('sk-live-plaintext', secrets)).toBe('••••');
  });
});
