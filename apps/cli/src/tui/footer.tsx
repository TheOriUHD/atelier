/**
 * The line under the message box: the permission mode (Shift+Tab), how full the context is, where this terminal is
 * connected and whether the server can reach this computer, and the model. A status line command, when set, replaces
 * the middle with its first line.
 */
import { Box, Text } from 'ink';
import type { PermissionMode } from '@atelier/protocol';
import type { Paint } from '../style.ts';
import { MODE_WORDS } from './session.ts';

export interface FooterInfo {
  mode: PermissionMode;
  contextPercent: number | null;
  where: string;
  /** Server mode: the device link. */
  link?: 'online' | 'connecting' | 'signed_out' | 'off' | undefined;
  connected: boolean;
  model: string;
  effort: string | null;
  queued: number;
  tasks: number;
  hint?: string | null;
  statusLine?: string | null;
}

export function Footer({ info, paint, columns }: { info: FooterInfo; paint: Paint; columns: number }) {
  const modeColour = { auto: 'accent', default: 'muted', acceptEdits: 'good', plan: 'info', bypassPermissions: 'bad' } as const;
  const mode = paint.fg(modeColour[info.mode], `⏵⏵ ${MODE_WORDS[info.mode]}`) + paint.fg('faint', ' (shift+tab)');
  const dot = !info.connected ? paint.fg('bad', '○') : info.link === 'signed_out' ? paint.fg('bad', '●') : info.link === 'connecting' || info.link === 'off' ? paint.fg('warn', '●') : paint.fg('good', '●');
  const bits = [
    mode,
    ...(info.contextPercent !== null ? [paint.fg(info.contextPercent >= 80 ? 'warn' : 'muted', `ctx ${info.contextPercent}%`)] : []),
    `${dot} ${paint.fg('muted', info.where)}`,
    ...(info.queued ? [paint.fg('accentSoft', `${info.queued} queued`)] : []),
    ...(info.tasks ? [paint.fg('muted', `${info.tasks} in background · ↓`)] : []),
  ];
  const left = info.hint ? paint.fg('muted', info.hint) : info.statusLine ?? bits.join(paint.fg('faint', ' · '));
  const right = paint.fg('secondary', info.model) + (info.effort ? paint.fg('muted', ` · ${info.effort}`) : '');
  return (
    <Box width={columns} justifyContent="space-between" paddingX={1}>
      <Text wrap="truncate-end">{left}</Text>
      <Text wrap="truncate-start">{right}</Text>
    </Box>
  );
}
