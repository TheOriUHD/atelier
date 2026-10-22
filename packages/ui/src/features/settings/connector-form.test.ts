import { describe, expect, it } from 'vitest';
import { CONNECTOR_PRESETS, McpServerConfig } from '@atelier/protocol';
import { connectorFormErrors, emptyForm, entryFromForm, entryFromImport, entryFromPreset, formFromConfig, secretId, storesSecret } from './connector-form.ts';

const form = (patch: Partial<ReturnType<typeof emptyForm>>) => ({ ...emptyForm(), ...patch });

describe('connector forms', () => {
  it('derives valid secret ids from names', () => {
    expect(secretId('mcp', 'My_Server', 'X-Api-Key')).toBe('mcp-my-server-x-api-key');
    expect(secretId('mcp', 'a'.repeat(80))).toHaveLength(64);
    expect(secretId('mcp', 'x', 'url')).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  it('checks the name, the URL or command, and that values have names', () => {
    expect(connectorFormErrors(form({ name: '' }), new Set())).toEqual({ name: 'Give it a name.', url: 'Enter the server’s URL, like https://example.com/mcp.' });
    expect(connectorFormErrors(form({ name: 'my server', url: 'https://x.dev/mcp' }), new Set()).name).toBe('Use up to 64 letters, digits, - and _.');
    expect(connectorFormErrors(form({ name: 'docs', url: 'https://x.dev/mcp' }), new Set(['docs'])).name).toBe('There is a connector with this name already.');
    expect(connectorFormErrors(form({ name: 'docs', url: '${DOCS_URL}' }), new Set())).toEqual({});
    expect(connectorFormErrors(form({ name: 'files', type: 'stdio' }), new Set())).toEqual({ command: 'Enter the command that starts the server.' });
    expect(connectorFormErrors(form({ name: 'docs', url: 'https://x.dev/mcp', pairs: [{ name: ' ', value: 'v' }] }), new Set())).toEqual({ pairs: 'Every value needs a name.' });
  });

  it('marks http and sse connectors that sign in with OAuth', () => {
    expect(entryFromForm(form({ name: 'docs', url: 'https://x.dev/mcp', oauth: true }))).toEqual({ entry: { type: 'http', url: 'https://x.dev/mcp', headers: {}, auth: 'oauth' }, secrets: [] });
    expect(entryFromForm(form({ name: 'files', type: 'stdio', command: 'npx', oauth: true })).entry).not.toHaveProperty('auth');
    expect(formFromConfig('docs', McpServerConfig.parse({ type: 'sse', url: 'https://x.dev/sse', auth: 'oauth' })).oauth).toBe(true);
  });

  it('moves credential-like and marked values into secrets, keeping a bearer scheme in the entry', () => {
    const { entry, secrets } = entryFromForm(
      form({
        name: 'docs',
        url: ' https://x.dev/mcp ',
        pairs: [
          { name: 'Authorization', value: 'Bearer abc-123-def' },
          { name: 'X-Team', value: 'blue' },
          { name: 'X-Tenant', value: 'acme-77', secret: true },
          { name: 'X-Api-Key', value: '${secret:shared}' },
          { name: '', value: '' },
        ],
      }),
    );
    expect(entry).toEqual({
      type: 'http',
      url: 'https://x.dev/mcp',
      headers: {
        Authorization: 'Bearer ${secret:mcp-docs-authorization}',
        'X-Team': 'blue',
        'X-Tenant': '${secret:mcp-docs-x-tenant}',
        'X-Api-Key': '${secret:shared}',
      },
    });
    expect(secrets).toEqual([
      { id: 'mcp-docs-authorization', label: 'Authorization for docs', kind: 'token', value: 'abc-123-def' },
      { id: 'mcp-docs-x-tenant', label: 'X-Tenant for docs', kind: 'token', value: 'acme-77' },
    ]);
    expect(storesSecret({ name: 'API_KEY', value: 'k', secret: false })).toBe(false);
  });

  it('round-trips a stdio entry and keeps what the form doesn’t edit', () => {
    const config = McpServerConfig.parse({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { NOTES_TOKEN: '${secret:mcp-notes}' }, enabled: false, disabledTools: ['wipe'] });
    const edited = formFromConfig('notes', config);
    expect(edited).toMatchObject({ type: 'stdio', command: 'npx', args: '-y\npkg', pairs: [{ name: 'NOTES_TOKEN', value: '${secret:mcp-notes}' }] });
    expect(entryFromForm(edited, config)).toEqual({
      entry: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { NOTES_TOKEN: '${secret:mcp-notes}' }, enabled: false, disabledTools: ['wipe'] },
      secrets: [],
    });
  });

  it('builds a preset’s entry around the stored token', () => {
    const ha = CONNECTOR_PRESETS.find((p) => p.id === 'home-assistant')!;
    expect(entryFromPreset(ha, 'home', ' tok-123 ', { url: 'http://ha.lan:8123/' })).toEqual({
      entry: { type: 'http', url: 'http://ha.lan:8123/api/mcp', headers: { Authorization: 'Bearer ${secret:mcp-home}' }, preset: 'home-assistant' },
      secrets: [{ id: 'mcp-home', label: 'Long-lived access token for home', kind: 'token', value: 'tok-123' }],
    });
  });

  it('moves the credentials an import flagged', () => {
    const config = McpServerConfig.parse({ type: 'http', url: 'https://x.dev/mcp?key=sk-1234567890', headers: { Authorization: 'Bearer ghp_abcdefgh' }, env: {} });
    const { entry, secrets } = entryFromImport({ name: 'gh', config, secrets: [['headers', 'Authorization'], ['url']], source: '~/.claude.json' });
    expect(entry).toMatchObject({ url: '${secret:mcp-gh-url}', headers: { Authorization: 'Bearer ${secret:mcp-gh-authorization}' } });
    expect(secrets).toEqual([
      { id: 'mcp-gh-authorization', label: 'Authorization for gh', kind: 'token', value: 'ghp_abcdefgh' },
      { id: 'mcp-gh-url', label: 'URL for gh', kind: 'token', value: 'https://x.dev/mcp?key=sk-1234567890' },
    ]);
    // The import result itself is left as it was.
    expect(config.headers.Authorization).toBe('Bearer ghp_abcdefgh');
  });
});
