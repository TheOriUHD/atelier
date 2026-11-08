/**
 * The session's header: Pip beside the wordmark, the version, model, where it runs and the folder. Pip moves while it
 * is the live part of the screen (before the first message); printed into the scrollback, it holds still.
 */
import { Box, Text, useAnimation } from 'ink';
import { drawPip, PIP_IDLE, PIP_STEP_MS, type PipFrame } from '../art/mascot.ts';
import { smallBanner } from '../art/banner.ts';
import type { Paint } from '../style.ts';

export interface HeaderInfo {
  version: string;
  model: string;
  /** "Philipp @ atelier.home" or "This computer". */
  where: string;
  folder: string;
  branch?: string | null;
}

function Lines({ info, paint, pip }: { info: HeaderInfo; paint: Paint; pip: string[] }) {
  const right = [
    ...smallBanner(paint).map((l, i) => (i === 0 ? `${l}  ${paint.fg('muted', `v${info.version}`)}` : l)),
    '',
    `${paint.fg('text', info.model)}`,
    paint.fg('secondary', info.where),
    paint.fg('muted', `${info.folder}${info.branch ? ` · ${info.branch}` : ''}`),
  ];
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box width={18} flexShrink={0} flexDirection="column">
        <Text>{pip.join('\n')}</Text>
      </Box>
      <Box flexDirection="column">
        <Text>{right.join('\n')}</Text>
      </Box>
    </Box>
  );
}

export function StillHeader({ info, paint }: { info: HeaderInfo; paint: Paint }) {
  return <Lines info={info} paint={paint} pip={drawPip('base', paint.p.depth)} />;
}

export function LiveHeader({ info, paint, motion, frames = PIP_IDLE }: { info: HeaderInfo; paint: Paint; motion: boolean; frames?: readonly PipFrame[] }) {
  const { frame } = useAnimation({ interval: PIP_STEP_MS, isActive: motion && paint.p.depth > 0 });
  const name = motion ? frames[frame % frames.length]! : 'base';
  return <Lines info={info} paint={paint} pip={drawPip(name, paint.p.depth)} />;
}
