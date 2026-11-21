/**
 * Connector presets (ARCHITECTURE §9-B): ready-made MCP server entries for common services. The person pastes
 * a token (kept in the secret store; the entry only references it) and, for self-hosted services, an address.
 * Services whose hosted server lets clients register themselves can be signed in to with OAuth instead. A program
 * that comes with an app on the person's computer (Roblox Studio's) needs neither.
 */

/** An `mcpServers` entry in Claude Code's shape. */
export interface PresetServer {
  type: 'http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ConnectorPreset {
  id: string;
  name: string;
  description: string;
  /** What to paste, and where to create it; absent when it needs nothing pasted. */
  token?: { label: string; url: string; help: string };
  /** Other inputs, such as a self-hosted address. */
  fields: { id: string; label: string; placeholder: string }[];
  /** The token setup runs a stdio server on the person's computer, so only the desktop app offers it. */
  desktopOnly: boolean;
  /** The systems its program exists for (`process.platform` names); absent for any. */
  platforms?: readonly string[];
  /** The hosted server to sign in to with OAuth instead of pasting a token. */
  oauth?: { url: string };
  note?: string;
  /** What has to be true on the computer for it to work, shown on its form and on its page while it fails. */
  setup?: string;
  /**
   * `secretRef` stands for the pasted token: `${secret:<id>}`, or the token itself for a person's own connector (whose
   * values are its secret). `platform` is the system the program runs on (`darwin`, `win32`, `linux`).
   */
  server(input: { secretRef: string; fields: Record<string, string>; platform: string }): PresetServer;
}

/** Whether a preset's program exists for `platform`. */
export function presetRunsOn(preset: Pick<ConnectorPreset, 'platforms'>, platform: string): boolean {
  return !preset.platforms || preset.platforms.includes(platform);
}

const bearer = (secretRef: string) => ({ Authorization: `Bearer ${secretRef}` });

export const CONNECTOR_PRESETS: readonly ConnectorPreset[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Workers, DNS, R2, D1 and the rest of your Cloudflare account, through Cloudflare’s API server.',
    token: { label: 'API token', url: 'https://dash.cloudflare.com/profile/api-tokens', help: 'Grant only what you need. Account tokens need “Account Resources: Read”; IP-filtered tokens don’t work.' },
    fields: [],
    desktopOnly: false,
    oauth: { url: 'https://mcp.cloudflare.com/mcp' },
    server: ({ secretRef }) => ({ type: 'http', url: 'https://mcp.cloudflare.com/mcp', headers: bearer(secretRef) }),
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, code search and Actions in your repositories.',
    token: { label: 'Personal access token', url: 'https://github.com/settings/personal-access-tokens/new', help: 'Fine-grained tokens work; classic ones need the repo and read:org scopes.' },
    fields: [],
    desktopOnly: false,
    note: 'GitHub’s hosted server may need Copilot on your account.',
    server: ({ secretRef }) => ({ type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: bearer(secretRef) }),
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and update pages and databases shared with your integration.',
    token: { label: 'Integration secret', url: 'https://www.notion.so/profile/integrations', help: 'Give it read (and insert/update) content access, then share the pages it should see with the integration.' },
    fields: [],
    desktopOnly: true,
    oauth: { url: 'https://mcp.notion.com/mcp' },
    note: 'Runs Notion’s open-source server with npx (needs Node.js). Signing in uses Notion’s hosted server instead.',
    server: ({ secretRef }) => ({ type: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: secretRef } }),
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects and cycles in your Linear workspace.',
    token: { label: 'Personal API key', url: 'https://linear.app/settings/account/security', help: 'Linear › Settings › Security and access › Personal API keys.' },
    fields: [],
    desktopOnly: false,
    oauth: { url: 'https://mcp.linear.app/mcp' },
    server: ({ secretRef }) => ({ type: 'http', url: 'https://mcp.linear.app/mcp', headers: bearer(secretRef) }),
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web, news and image search through Brave’s API.',
    token: { label: 'API key', url: 'https://api-dashboard.search.brave.com/app/keys', help: 'The free plan is enough to try it.' },
    fields: [],
    desktopOnly: true,
    note: 'Runs Brave’s server with npx (needs Node.js). On a server, use the built-in web search with Brave instead (Settings › Admin › Capabilities).',
    server: ({ secretRef }) => ({ type: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], env: { BRAVE_API_KEY: secretRef } }),
  },
  {
    id: 'home-assistant',
    name: 'Home Assistant',
    description: 'Your devices, sensors and automations, through Home Assistant’s MCP server.',
    token: { label: 'Long-lived access token', url: 'https://www.home-assistant.io/docs/authentication/#your-account-profile', help: 'Create it under your Home Assistant profile › Security, as an admin user, and enable the “Model Context Protocol Server” integration.' },
    fields: [{ id: 'url', label: 'Home Assistant address', placeholder: 'http://homeassistant.local:8123' }],
    desktopOnly: false,
    server: ({ secretRef, fields }) => ({ type: 'http', url: `${(fields.url ?? '').replace(/\/+$/, '')}/api/mcp`, headers: bearer(secretRef) }),
  },
  {
    id: 'roblox-studio',
    name: 'Roblox Studio',
    description: 'Run Luau, read and edit scripts, insert assets, play-test and take screenshots in the place open in Studio.',
    fields: [],
    desktopOnly: true,
    platforms: ['darwin', 'win32'],
    note: 'Runs the MCP server that comes with Roblox Studio, on your computer.',
    setup: 'Roblox Studio must be installed and open, with Assistant › ⋯ › Manage MCP Servers › Enable Studio as MCP server turned on.',
    // As Roblox documents them (create.roblox.com/docs/studio/mcp). On Windows, Studio's version folder changes with every
    // update; the launcher it keeps at %LOCALAPPDATA%\Roblox\mcp.bat finds the current one.
    server: ({ platform }) =>
      platform === 'win32' ? { type: 'stdio', command: '${LOCALAPPDATA}\\Roblox\\mcp.bat' } : { type: 'stdio', command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP' },
  },
];
