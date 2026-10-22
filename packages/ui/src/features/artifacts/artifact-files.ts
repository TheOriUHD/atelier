import type { ArtifactSummary, ArtifactType } from '@atelier/protocol';

/** Types the sandboxed runtime can render; `code` only has a source view. */
export const PREVIEWABLE: ReadonlySet<ArtifactType> = new Set(['html', 'react', 'svg', 'mermaid', 'markdown']);

const TYPE_EXTENSIONS: Record<Exclude<ArtifactType, 'code'>, string> = {
  html: 'html',
  react: 'jsx',
  svg: 'svg',
  mermaid: 'mmd',
  markdown: 'md',
};

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  kotlin: 'kt',
  csharp: 'cs',
  'c#': 'cs',
  'c++': 'cpp',
  shell: 'sh',
  bash: 'sh',
  zsh: 'sh',
  powershell: 'ps1',
  markdown: 'md',
  yaml: 'yml',
  haskell: 'hs',
  elixir: 'ex',
  clojure: 'clj',
  objectivec: 'm',
  'objective-c': 'm',
  text: 'txt',
  plaintext: 'txt',
};

/** File extension for a download: by type, or by the code's language (short language ids are used as-is). */
export function artifactExtension(type: ArtifactType, language: string | null): string {
  if (type !== 'code') return TYPE_EXTENSIONS[type];
  const lang = language?.trim().toLowerCase() ?? '';
  return LANGUAGE_EXTENSIONS[lang] ?? (/^[a-z0-9]{1,5}$/.test(lang) ? lang : 'txt');
}

export function artifactFilename(artifact: Pick<ArtifactSummary, 'identifier' | 'type' | 'language'>): string {
  return `${artifact.identifier}.${artifactExtension(artifact.type, artifact.language)}`;
}

/** Shiki language for the source view. */
export function sourceLanguage(type: ArtifactType, language: string | null): string {
  return { html: 'html', react: 'tsx', svg: 'xml', mermaid: 'mermaid', markdown: 'markdown', code: language ?? '' }[
    type
  ];
}

export function downloadText(filename: string, content: string): void {
  downloadBlob(filename, new Blob([content], { type: 'text/plain;charset=utf-8' }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
