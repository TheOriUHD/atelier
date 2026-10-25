/**
 * A shell command, highlighted (design/components.md › ToolCard): as bash, or as PowerShell when it reads like
 * PowerShell (on Windows, Bash runs PowerShell where Git Bash is missing). A here-document an interpreter or a file
 * receives (`python3 - <<'EOF' … EOF`, `cat > app.ts <<'EOF'`) is highlighted in that program's or file's language.
 */
import { useHighlightedLines, CodeLines } from '../chat/code-block.tsx';

/** A cmdlet (Verb-Noun) where a command starts, `$env:`, .NET types and PowerShell-only parameters: what bash commands don't have. */
const POWERSHELL = new RegExp(
  [
    String.raw`(^|[|;({]|&&|\|\|)\s*(Get|Set|New|Remove|Select|Where|ForEach|Write|Out|Test|Start|Stop|Restart|Invoke|Copy|Move|Rename|Import|Export|ConvertTo|ConvertFrom|Measure|Sort|Format|Add|Clear|Join|Split|Resolve|Push|Pop|Expand|Compress|Enable|Disable|Wait|Read|Update|Install|Uninstall|Register|Unregister|Group|Compare|Tee)-[A-Z][A-Za-z]+\b`,
    String.raw`\$env:\w`,
    String.raw`\[(System\.\w|IO\.\w|Environment\]|Convert\]|Math\])`,
    String.raw`\s-(ErrorAction|LiteralPath|NoProfile|ExecutionPolicy)\b`,
  ].join('|'),
  'm',
);

export function commandLanguage(command: string): 'powershell' | 'shellscript' {
  return POWERSHELL.test(command) ? 'powershell' : 'shellscript';
}

/** Programs whose here-document is code in a language of their own. */
const INTERPRETERS: [RegExp, string][] = [
  [/^python[\d.]*$|^py$/, 'python'],
  [/^(node|deno|bun)$/, 'javascript'],
  [/^(tsx|ts-node)$/, 'typescript'],
  [/^(bash|sh|zsh|dash)$/, 'shellscript'],
  [/^(pwsh|powershell)$/, 'powershell'],
  [/^(ruby|irb)$/, 'ruby'],
  [/^perl$/, 'perl'],
  [/^php$/, 'php'],
  [/^(psql|sqlite3|mysql|duckdb|clickhouse-client)$/, 'sql'],
];

/** The language a here-document is in, from the command that takes it: its interpreter, or the file it is written to. */
function documentLanguage(command: string): string | null {
  // The last simple command on the line reads the document: cut at separators, not at a redirect's `&` (`2>&1`, `&>log`).
  const last =
    command
      .split(/\|\||&&|;|\|&?|(?<![<>\d])&(?!>)/)
      .map((c) => c.trim())
      .filter(Boolean)
      .pop() ?? '';
  const words = last.split(/\s+/).filter((w) => !/^\w+=/.test(w) && w !== 'sudo' && w !== 'exec' && w !== 'env');
  const program = words[0]?.split('/').pop() ?? '';
  for (const [name, lang] of INTERPRETERS) if (name.test(program)) return lang;
  // `cat > file.py`, `tee -a file.py`: the file's extension (or name, Dockerfile, Makefile).
  const file = /(?<!\d)>>?\s*(['"]?)([^\s'"&][^\s'"]*)\1/.exec(last)?.[2] ?? (program === 'tee' ? words.slice(1).find((w) => !w.startsWith('-')) : undefined);
  if (!file) return null;
  const name = file.split('/').pop()!.toLowerCase();
  return name.includes('.') ? name.split('.').pop()! : name;
}

export interface CommandPart {
  lines: string[];
  /** A language (Shiki id or alias) the part is highlighted in; empty for plain text. */
  lang: string;
}

/**
 * The command in parts of whole lines: the shell's, and each here-document's body in its own language. PowerShell's
 * here-strings are its grammar's own, so a PowerShell command is one part.
 */
export function commandParts(command: string): CommandPart[] {
  const shell = commandLanguage(command);
  const lines = command.split('\n');
  if (shell === 'powershell') return [{ lines, lang: shell }];
  const parts: CommandPart[] = [];
  let shellLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    shellLines.push(line);
    // `<<<` is a here-string, not a document: blanked out (same length) before looking.
    const start = /<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(line.replace(/<<</g, '   '));
    if (!start) continue;
    const [marker, dash, , word] = start;
    const end = lines.findIndex((l, j) => j > i && (dash ? l.replace(/^\t+/, '') : l) === word);
    if (end === -1) continue;
    parts.push({ lines: shellLines, lang: shell });
    // What the line does besides the marker says who reads it (`python3 -`, `cat > app.ts`, `cat <<EOF > app.ts`).
    const reader = line.slice(0, start.index) + ' ' + line.slice(start.index + marker.length);
    parts.push({ lines: lines.slice(i + 1, end), lang: documentLanguage(reader) ?? '' });
    shellLines = [];
    // The line that ends the document is the shell's again.
    i = end - 1;
  }
  if (shellLines.length) parts.push({ lines: shellLines, lang: shell });
  return parts.filter((p) => p.lines.length > 0);
}

function Part({ part }: { part: CommandPart }) {
  return <CodeLines lines={useHighlightedLines(part.lines.join('\n'), part.lang, true)} />;
}

/** The command's text, highlighted, for a `<pre>` that holds it (after its `$ `). */
export function CommandCode({ command }: { command: string }) {
  const parts = commandParts(command);
  return (
    <span className="at-code">
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && '\n'}
          <Part part={part} />
        </span>
      ))}
    </span>
  );
}
