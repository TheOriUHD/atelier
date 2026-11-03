import { describe, expect, it } from 'vitest';
import { collectDesktopDiagnostics, DiagnosticsRequest, type DiagnosticsSources } from './diagnostics.ts';

const sources = (over: Partial<DiagnosticsSources> = {}): DiagnosticsSources => ({
  versions: { electron: '40.1.0', chrome: '144.0.1' },
  arch: 'arm64',
  packaged: true,
  readLog: (n) => Array.from({ length: n }, (_, i) => `line ${i}`),
  username: () => 'philippb',
  hostname: () => 'mac',
  home: () => '/Users/philippb',
  folders: () => ['/Users/philippb/Library/Application Support/Atelier', '/x'],
  ...over,
});

describe('the diagnostics request', () => {
  it('asks for 100 lines unless told otherwise, and refuses anything outside 1 to 500', () => {
    expect(DiagnosticsRequest.parse(undefined)).toEqual({ lines: 100 });
    expect(DiagnosticsRequest.parse({})).toEqual({ lines: 100 });
    for (const bad of [{ lines: 0 }, { lines: 501 }, { lines: 1.5 }, { lines: '5' }, { lines: -1 }, 'x', []]) {
      expect(() => DiagnosticsRequest.parse(bad)).toThrow();
    }
  });
});

describe('collecting the desktop’s part of the diagnostics', () => {
  it('reports versions, architecture, the log tail, this computer’s words and the app’s own folders', () => {
    const out = collectDesktopDiagnostics({ lines: 3 }, sources());
    expect(out).toEqual({
      arch: 'arm64',
      electron: '40.1.0',
      chrome: '144.0.1',
      packaged: true,
      log: ['line 0', 'line 1', 'line 2'],
      privateStrings: ['/Users/philippb', 'philippb', 'mac'],
      appFolders: ['/Users/philippb/Library/Application Support/Atelier'],
    });
  });

  it('does not read more lines than were asked for', () => {
    expect(collectDesktopDiagnostics(undefined, sources()).log).toHaveLength(100);
    expect(() => collectDesktopDiagnostics({ lines: 100000 }, sources({ readLog: () => ['x'] }))).toThrow();
  });

  it('survives a source that fails, and leaves out words too short to hide safely', () => {
    const out = collectDesktopDiagnostics(
      {},
      sources({
        readLog: () => {
          throw new Error('disk');
        },
        hostname: () => {
          throw new Error('no');
        },
        username: () => 'al',
        folders: () => {
          throw new Error('no');
        },
      }),
    );
    expect(out.log).toEqual([]);
    expect(out.privateStrings).toEqual(['/Users/philippb']);
    expect(out.appFolders).toEqual([]);
  });
});
