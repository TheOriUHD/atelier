import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CommandCode, commandLanguage, commandParts } from './command-code.tsx';

describe('command highlighting', () => {
  it('reads a command as PowerShell only when it looks like PowerShell', () => {
    for (const command of ['Get-ChildItem -Recurse src | Select-String TODO', '$env:PATH -split ";"', 'Remove-Item build -Recurse -Force', '[System.IO.File]::ReadAllText("a.txt")'])
      expect(commandLanguage(command), command).toBe('powershell');
    for (const command of ['ls -la', 'git log --oneline -5 && npm test', 'echo "$HOME" > out.txt 2>&1', 'find . -name "*.ts" -exec grep -l Get-Thing {} +'])
      expect(commandLanguage(command), command).toBe('shellscript');
  });

  it("highlights a here-document in its reader's language, and the rest as the shell", () => {
    const command = ["cd app && python3 - <<'EOF' 2>&1", 'import json', 'print(json.dumps({"a": 1}))', 'EOF', 'echo done'].join('\n');
    expect(commandParts(command)).toEqual([
      { lines: ["cd app && python3 - <<'EOF' 2>&1"], lang: 'shellscript' },
      { lines: ['import json', 'print(json.dumps({"a": 1}))'], lang: 'python' },
      { lines: ['EOF', 'echo done'], lang: 'shellscript' },
    ]);
  });

  it('takes the language of the file a here-document is written to, before or after the marker', () => {
    expect(commandParts("cat > src/app.ts <<'EOF'\nconst a = 1;\nEOF")[1]).toEqual({ lines: ['const a = 1;'], lang: 'ts' });
    expect(commandParts('cat <<EOF > config.json\n{}\nEOF')[1]).toEqual({ lines: ['{}'], lang: 'json' });
    expect(commandParts('tee -a Dockerfile <<EOF\nFROM node\nEOF')[1]).toEqual({ lines: ['FROM node'], lang: 'dockerfile' });
    expect(commandParts('node <<EOF\nconsole.log(1)\nEOF')[1]?.lang).toBe('javascript');
    // An unknown reader: plain text, still its own lines.
    expect(commandParts('mail me <<EOF\nhi\nEOF')[1]).toEqual({ lines: ['hi'], lang: '' });
  });

  it('keeps every line, an empty one, an unterminated document and a here-string included', () => {
    for (const command of ['python3 <<EOF\n\nEOF\nls', 'python3 <<EOF\nprint(1)', 'grep x <<< "$text"', 'a\n\nb']) {
      expect(commandParts(command).flatMap((p) => p.lines), command).toEqual(command.split('\n'));
    }
    // `<<-` documents end at a line indented with tabs.
    expect(commandParts('bash <<-END\n\techo hi\n\tEND\nls').map((p) => p.lang)).toEqual(['shellscript', 'shellscript', 'shellscript']);
  });

  it('colors the command once its language has loaded, keeping the text as it is', async () => {
    const command = 'git commit -m "fix: it works" && echo $HOME';
    const { container } = render(
      <pre>
        <CommandCode command={command} />
      </pre>,
    );
    expect(container.textContent).toBe(command);
    await waitFor(() => expect(container.querySelector('.at-code span[style]')).not.toBeNull(), { timeout: 10_000 });
    expect(container.textContent).toBe(command);
  });
});
