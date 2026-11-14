/** The update feed's platform and kind names (deploy/cloudflare/src/stats.js), as the panel groups and labels them. */

/** The series the charts stack by, in a fixed order with fixed colors. */
export const GROUPS = [
  { id: 'mac', label: 'macOS', color: 'var(--viz-1)' },
  { id: 'windows', label: 'Windows', color: 'var(--viz-2)' },
  { id: 'linux', label: 'Linux', color: 'var(--viz-3)' },
  { id: 'cli', label: 'Terminal app', color: 'var(--viz-4)' },
  { id: 'server', label: 'Server', color: 'var(--viz-5)' },
  { id: 'other', label: 'Other', color: 'var(--viz-other)' },
] as const;
export type GroupId = (typeof GROUPS)[number]['id'];

export function groupOf(platform: string): GroupId {
  if (platform.startsWith('mac')) return 'mac';
  if (platform.startsWith('windows')) return 'windows';
  if (platform.startsWith('linux')) return 'linux';
  if (platform.startsWith('cli')) return 'cli';
  if (platform.startsWith('server')) return 'server';
  return 'other';
}

const ARCH: Record<string, string> = { arm64: 'ARM64', x64: 'x64' };
const OS: Record<string, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

/** "mac-arm64" → "macOS, Apple silicon"; "cli-linux-x64" → "Terminal app, Linux x64". */
export function platformLabel(platform: string): string {
  if (platform === 'mac-arm64') return 'macOS, Apple silicon';
  if (platform === 'mac-x64') return 'macOS, Intel';
  if (platform === 'mac') return 'macOS';
  if (platform === 'windows') return 'Windows';
  if (platform === 'server') return 'Server install script';
  if (platform === 'cli') return 'Terminal app';
  if (platform === 'cli-unix') return 'Terminal app install script (macOS, Linux)';
  if (platform === 'cli-windows') return 'Terminal app install script (Windows)';
  const m = /^(?:(cli|server)-)?(mac|windows|linux)-(x64|arm64)$/.exec(platform);
  if (!m) return platform;
  const base = `${OS[m[2]!]} ${ARCH[m[3]!]}`;
  return m[1] === 'cli' ? `Terminal app, ${base}` : m[1] === 'server' ? `Server setup, ${base}` : base;
}

export const KINDS: { id: string; label: string; hint: string }[] = [
  { id: 'download', label: 'Downloads', hint: 'A person downloaded a package' },
  { id: 'update', label: 'Updates', hint: 'An installed app downloaded its update' },
  { id: 'install-script', label: 'Install scripts', hint: 'curl … | sh and irm … | iex' },
  { id: 'server-setup', label: 'Server setup', hint: 'The setup binary the server installer fetches' },
  { id: 'update-blockmap', label: 'Blockmaps', hint: 'Differential-update maps (the app has them off)' },
];
export const kindLabel = (kind: string) => KINDS.find((k) => k.id === kind)?.label ?? kind;

/** Fixed colors for a short list of categories (versions, kinds): by position, never cycled; the rest is "Other". */
export const SLOT_COLORS = [
  'var(--viz-1)',
  'var(--viz-2)',
  'var(--viz-3)',
  'var(--viz-4)',
  'var(--viz-5)',
  'var(--viz-6)',
  'var(--viz-7)',
  'var(--viz-8)',
];
