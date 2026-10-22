import { describe, expect, it } from 'vitest';
import { artifactExtension, artifactFilename, sourceLanguage } from './artifact-files.ts';

describe('artifact downloads', () => {
  it('names files by type', () => {
    expect(artifactFilename({ identifier: 'tally-counter', type: 'html', language: null })).toBe('tally-counter.html');
    expect(artifactExtension('react', null)).toBe('jsx');
    expect(artifactExtension('svg', null)).toBe('svg');
    expect(artifactExtension('mermaid', null)).toBe('mmd');
    expect(artifactExtension('markdown', null)).toBe('md');
  });

  it('names code by its language', () => {
    expect(artifactFilename({ identifier: 'sort', type: 'code', language: 'TypeScript' })).toBe('sort.ts');
    expect(artifactExtension('code', 'python')).toBe('py');
    expect(artifactExtension('code', 'c++')).toBe('cpp');
    expect(artifactExtension('code', 'bash')).toBe('sh');
    // Short language ids are already extensions.
    expect(artifactExtension('code', 'go')).toBe('go');
    expect(artifactExtension('code', 'tsx')).toBe('tsx');
    expect(artifactExtension('code', null)).toBe('txt');
    expect(artifactExtension('code', 'some language')).toBe('txt');
  });

  it('picks the source-view language', () => {
    expect(sourceLanguage('react', null)).toBe('tsx');
    expect(sourceLanguage('svg', null)).toBe('xml');
    expect(sourceLanguage('code', 'rust')).toBe('rust');
  });
});
