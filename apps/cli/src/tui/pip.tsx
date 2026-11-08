/** Pip in a column of its own width, so what is beside it neither squeezes nor moves it as it animates. */
import { Box, Text } from 'ink';
import { PIP_WIDTH } from '../art/mascot.ts';

export function PipBox({ lines }: { lines: string[] }) {
  return (
    <Box width={PIP_WIDTH} height={lines.length} flexShrink={0}>
      <Text>{lines.join('\n')}</Text>
    </Box>
  );
}
