/**
 * The session's header: Pip beside the name, the version, model, where it runs and the folder. Pip moves while it
 * is the live part of the screen (before the first message); printed into the scrollback, it holds still.
 */
import { Box, Text, useAnimation } from 'ink';
import { drawPip, PIP_IDLE, PIP_STEP_MS, PIP_WIDTH, type PipFrame } from '../art/mascot.ts';
import type { Paint } from '../style.ts';
import { PipBox } from './pip.tsx';

export interface HeaderInfo {
  version: string;
  model: string;
  /** "Philipp @ atelier.home" or "This computer". */
  where: string;
  folder: string;
  branch?: string | null;
}

function Lines({ info, paint, pip }: { info: HeaderInfo; paint: Paint; pip: string[] }) {
  // The name in plain letters (block letters this small break apart in terminals with line spacing), beside Pip's face.
  const right = [
    `${paint.bold(paint.gradient('Atelier'))} ${paint.bold('CLI')}  ${paint.fg('muted', `v${info.version}`)}`,
    paint.fg('text', info.model),
    paint.fg('secondary', info.where),
    paint.fg('muted', `${info.folder}${info.branch ? ` · ${info.branch}` : ''}`),
  ];
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box width={PIP_WIDTH + 3} flexShrink={0}>
        <PipBox lines={pip} />
      </Box>
      <Box flexDirection="column" marginTop={1} flexShrink={1} minWidth={0}>
        {right.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line}
          </Text>
        ))}
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
