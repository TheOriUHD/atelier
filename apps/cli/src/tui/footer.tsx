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

/** Below this many columns the footer leaves out the "(shift+tab)" hint. */
const NARROW = 96;

export function Footer({ info, paint, columns }: { info: FooterInfo; paint: Paint; columns: number }) {
  const modeColour = { auto: 'accent', default: 'muted', acceptEdits: 'good', plan: 'info', bypassPermissions: 'bad' } as const;
  // The key's hint goes first when the terminal is narrow: the mode, the context and the model matter more.
  const mode = paint.fg(modeColour[info.mode], `⏵⏵ ${MODE_WORDS[info.mode]}`) + (columns >= NARROW ? paint.fg('faint', ' (shift+tab)') : '');
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
  // The model keeps its place on the right; what doesn't fit on the left ends in "…", with a gap before the model.
  return (
    <Box width={columns} paddingX={1} columnGap={2}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">{left}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text wrap="truncate-start">{right}</Text>
      </Box>
    </Box>
  );
}
