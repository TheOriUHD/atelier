import { describe, expect, it } from 'vitest';
import { CONNECTOR_PRESETS, presetRunsOn } from './connector-presets.ts';
import { McpServerConfig } from './mcp.ts';

const preset = (id: string) => CONNECTOR_PRESETS.find((p) => p.id === id)!;

describe('connector presets', () => {
  it('reference the pasted token instead of containing it', () => {
    for (const preset of CONNECTOR_PRESETS) {
      for (const platform of ['darwin', 'win32', 'linux']) {
        const server = preset.server({ secretRef: '${secret:x}', fields: { url: 'http://ha.local:8123/' }, platform });
        // Every one is a valid entry, and only one that asks for a token has it in its entry.
        expect(McpServerConfig.safeParse(server).success).toBe(true);
        expect(JSON.stringify(server).includes('${secret:x}')).toBe(!!preset.token);
        expect(server.type === 'stdio' ? preset.desktopOnly : true).toBe(true);
      }
      if (preset.token) expect(new URL(preset.token.url).protocol).toBe('https:');
    }
    expect(preset('home-assistant').server({ secretRef: 's', fields: { url: 'http://ha.local:8123/' }, platform: 'linux' }).url).toBe('http://ha.local:8123/api/mcp');
    expect(new Set(CONNECTOR_PRESETS.map((p) => p.id)).size).toBe(CONNECTOR_PRESETS.length);
  });

  it("runs Roblox Studio's own MCP server where Roblox documents it, on macOS and Windows only", () => {
    const roblox = preset('roblox-studio');
    expect(roblox.desktopOnly).toBe(true);
    expect(roblox.token).toBeUndefined();
    expect(roblox.server({ secretRef: '', fields: {}, platform: 'darwin' })).toEqual({ type: 'stdio', command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP' });
    // On Windows, the launcher Studio keeps outside its version folder (which every update renames), found on that computer.
    expect(roblox.server({ secretRef: '', fields: {}, platform: 'win32' })).toEqual({ type: 'stdio', command: '${LOCALAPPDATA}\\Roblox\\mcp.bat' });
    expect([presetRunsOn(roblox, 'darwin'), presetRunsOn(roblox, 'win32'), presetRunsOn(roblox, 'linux')]).toEqual([true, true, false]);
    expect(presetRunsOn(preset('notion'), 'linux')).toBe(true);
  });
});
