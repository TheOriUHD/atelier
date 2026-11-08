/** The first time in a folder: whether Atelier may work there (and, for a server, run commands as you there). */
import { Box, render, Text, useApp } from 'ink';
import { useState } from 'react';
import { drawPip } from '../art/mascot.ts';
import type { Paint } from '../style.ts';
import { Choices, Panel } from './inputs.tsx';
import { PipBox } from './pip.tsx';
import { shortPath } from './views.tsx';

function Trust({ paint, root, server, onAnswer }: { paint: Paint; root: string; server: string | null; onAnswer(yes: boolean): void }) {
  const { exit } = useApp();
  const [answered, setAnswered] = useState(false);
  // Gone from the screen once answered: the session starts below a clean slate.
  const answer = (yes: boolean) => {
    onAnswer(yes);
    setAnswered(true);
    setTimeout(exit, 30);
  };
  if (answered) return null;
  return (
    <Box flexDirection="row" gap={2}>
      <PipBox lines={drawPip('lookRight', paint.p.depth)} />
      <Panel paint={paint} title={`Work in ${shortPath(root)}?`} tone="warn">
        <Text>Atelier reads, edits and runs commands in this folder, and reads its CLAUDE.md, AGENTS.md, settings and hooks.</Text>
        {server && <Text>{paint.fg('warn', `Sessions on ${server} can run commands as you here. Only say yes for a server you trust like that.`)}</Text>}
        <Box marginTop={1}>
          <Choices
            paint={paint}
            choices={[
              { value: true, label: 'Yes, work here' },
              { value: false, label: 'No, leave' },
            ]}
            onPick={answer}
            onCancel={() => answer(false)}
          />
        </Box>
      </Panel>
    </Box>
  );
}

export function askTrust(paint: Paint, root: string, server: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    let yes = false;
    const instance = render(<Trust paint={paint} root={root} server={server} onAnswer={(a) => (yes = a)} />, { exitOnCtrlC: true });
    void instance.waitUntilExit().then(
      () => resolve(yes),
      () => resolve(false),
    );
  });
}
