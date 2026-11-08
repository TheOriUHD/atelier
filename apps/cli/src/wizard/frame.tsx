/**
 * The setup wizard's frame, in the look of `atelier-setup` (setup/internal/ui): the ATELIER mark and "terminal setup",
 * the steps as a breadcrumb (✓ done, ● now, ○ next), a rounded box with the step's title over a rule, and the keys
 * at the bottom as `key action · key action`.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { Paint } from '../style.ts';

export const CRUMBS = ['look', 'connect', 'sign in', 'this computer', 'model', 'terminal'] as const;
export type Crumb = (typeof CRUMBS)[number];

export function Frame({ paint, columns, crumb, crumbs = CRUMBS, title, keys, children }: { paint: Paint; columns: number; crumb: Crumb | null; crumbs?: readonly Crumb[]; title: string; keys: string; children: ReactNode }) {
  const width = Math.min(100, Math.max(40, columns - 2));
  const at = crumb ? crumbs.indexOf(crumb) : -1;
  const trail = crumbs.map((c, i) => (i < at ? paint.fg('good', `✓ ${c}`) : i === at ? paint.fg('accent', `● ${c}`) : paint.fg('faint', `○ ${c}`))).join(paint.fg('faint', '  ─  '));
  return (
    <Box flexDirection="column" alignItems="center" width={columns}>
      <Text>{`${paint.bold(paint.gradient('ATELIER'))}${paint.fg('faint', '  terminal setup')}`}</Text>
      {crumb && <Text>{trail}</Text>}
      <Box flexDirection="column" borderStyle="round" borderColor={paint.p.depth ? paint.p.faint : undefined} paddingX={2} paddingY={1} width={width} marginTop={1}>
        <Text>{paint.bold(paint.fg('accent', title))}</Text>
        <Text>{paint.fg('faint', '─'.repeat(width - 6))}</Text>
        {children}
      </Box>
      <Text>{paint.fg('muted', keys)}</Text>
    </Box>
  );
}
