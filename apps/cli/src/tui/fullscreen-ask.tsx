/** Asked once, before the first session: the fullscreen view or the classic one. `/fullscreen` switches later. */
import { Box, render, Text, useApp } from 'ink';
import { useState } from 'react';
import { drawPip } from '../art/mascot.ts';
import type { Paint } from '../style.ts';
import { holdInput, interactive } from '../term.ts';
import { Choices, Panel } from './inputs.tsx';
import { PipBox } from './pip.tsx';

const SELECT_KEY = process.platform === 'darwin' ? 'Option (⌥)' : 'Shift';

function Ask({ paint, onAnswer }: { paint: Paint; onAnswer(fullscreen: boolean | null): void }) {
  const { exit } = useApp();
  const [answered, setAnswered] = useState(false);
  const answer = (fullscreen: boolean | null) => {
    onAnswer(fullscreen);
    setAnswered(true);
    setTimeout(exit, 30);
  };
  if (answered) return null;
  return (
    <Box flexDirection="row" gap={2}>
      <PipBox lines={drawPip('happy', paint.p.depth)} />
      <Panel paint={paint} title="Try the fullscreen view?">
        <Text>Atelier takes the whole window: the conversation scrolls above, the message box stays at the bottom, and nothing is redrawn into your terminal’s history.</Text>
        <Text>{paint.fg('muted', `Scroll with the trackpad, the wheel or Page Up/Down; hold ${SELECT_KEY} to select text. /fullscreen switches any time.`)}</Text>
        <Box marginTop={1}>
          <Choices
            paint={paint}
            choices={[
              { value: true, label: 'Yes, use fullscreen', aside: 'recommended' },
              { value: false, label: 'No, keep the classic view', aside: 'the conversation prints into the terminal' },
            ]}
            onPick={answer}
            onCancel={() => answer(null)}
          />
        </Box>
      </Panel>
    </Box>
  );
}

/** True or false as answered; null when the person left without answering (asked again next time). */
export function askFullscreen(paint: Paint): Promise<boolean | null> {
  return new Promise((resolve) => {
    let picked: boolean | null = null;
    holdInput();
    const instance = render(<Ask paint={paint} onAnswer={(a) => (picked = a)} />, { exitOnCtrlC: true, interactive: interactive() });
    void instance.waitUntilExit().then(
      () => resolve(picked),
      () => resolve(null),
    );
  });
}
