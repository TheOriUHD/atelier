/**
 * The setup wizard's frame, in the look of `atelier-setup` (setup/internal/ui): the ATELIER mark and "terminal setup"
 * (or, on the first screen, the big wordmark), the steps as a breadcrumb (✓ done, ● now, ○ next), a rounded box with the
 * step's title over a rule, Pip on its right where there is room, and the keys at the bottom as `key action · key action`.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { PipBox } from '../tui/pip.tsx';
import type { Paint } from '../style.ts';

export const SERVER_CRUMBS = ['server', 'sign in', 'this computer', 'model'] as const;
export const LOCAL_CRUMBS = ['this computer', 'you', 'providers', 'model'] as const;

export function Frame({
  paint,
  columns,
  crumbs,
  at,
  title,
  keys,
  top,
  pip,
  children,
}: {
  paint: Paint;
  columns: number;
  /** The steps, and which one this is (`crumbs.length` when all are done); none on the first screen. */
  crumbs?: readonly string[];
  at?: number;
  title: string;
  keys: string;
  /** In place of the ATELIER line: the big wordmark on the first screen. */
  top?: ReactNode;
  /** Pip's lines, drawn in a box of its own size beside the step. */
  pip?: string[] | null;
  children: ReactNode;
}) {
  const width = Math.min(100, Math.max(40, columns - 2));
  const trail = crumbs?.map((c, i) => (i < (at ?? 0) ? paint.fg('good', `✓ ${c}`) : i === at ? paint.fg('accent', `● ${c}`) : paint.fg('faint', `○ ${c}`))).join(paint.fg('faint', '  ─  '));
  return (
    <Box flexDirection="column" alignItems="center" width={columns}>
      {top ?? <Text>{`${paint.bold(paint.gradient('ATELIER'))}${paint.fg('faint', '  terminal setup')}`}</Text>}
      {trail && <Text>{trail}</Text>}
      <Box flexDirection="column" borderStyle="round" borderColor={paint.p.depth ? paint.p.faint : undefined} paddingX={2} paddingY={1} width={width} marginTop={1}>
        <Text>{paint.bold(paint.fg('accent', title))}</Text>
        <Text>{paint.fg('faint', '─'.repeat(width - 6))}</Text>
        <Box flexDirection="row" gap={2}>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
            {children}
          </Box>
          {pip && <PipBox lines={pip} />}
        </Box>
      </Box>
      <Text>{paint.fg('muted', keys)}</Text>
    </Box>
  );
}
