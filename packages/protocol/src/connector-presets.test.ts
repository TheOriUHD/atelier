import { describe, expect, it } from 'vitest';
import { CONNECTOR_PRESETS } from './connector-presets.ts';

describe('connector presets', () => {
  it('reference the pasted token instead of containing it', () => {
    for (const preset of CONNECTOR_PRESETS) {
      const server = preset.server({ secretRef: '${secret:x}', fields: { url: 'http://ha.local:8123/' } });
      const text = JSON.stringify(server);
      expect(text).toContain('${secret:x}');
      expect(server.type === 'stdio' ? preset.desktopOnly : true).toBe(true);
      expect(new URL(preset.token.url).protocol).toBe('https:');
    }
    expect(CONNECTOR_PRESETS.find((p) => p.id === 'home-assistant')!.server({ secretRef: 's', fields: { url: 'http://ha.local:8123/' } }).url).toBe('http://ha.local:8123/api/mcp');
    expect(new Set(CONNECTOR_PRESETS.map((p) => p.id)).size).toBe(CONNECTOR_PRESETS.length);
  });
});
