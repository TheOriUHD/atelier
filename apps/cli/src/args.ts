/**
 * The command line (ARCHITECTURE §25), described once: parsing uses it, `--help` prints it, and the docs' reference
 * page is generated from it.
 */
import { parseArgs } from 'node:util';

export interface Flag {
  name: string;
  short?: string;
  type: 'boolean' | 'string';
  multiple?: boolean;
  value?: string;
  help: string;
}

export const FLAGS: Flag[] = [
  { name: 'print', short: 'p', type: 'boolean', help: 'Answer one prompt and exit (for scripts): the reply goes to stdout' },
  { name: 'output-format', type: 'string', value: 'text|json|stream-json', help: 'With -p: plain text, one JSON result, or a JSON line per event' },
  { name: 'continue', short: 'c', type: 'boolean', help: 'Carry on with the latest session in this folder' },
  { name: 'resume', short: 'r', type: 'boolean', help: 'Pick a session to carry on with (or give its id: -r <id>)' },
  { name: 'session', type: 'string', value: 'id', help: 'Open this session' },
  { name: 'model', short: 'm', type: 'string', value: 'model', help: 'The model for new sessions (a name or provider/model); with decide, a decision model’s id from --list (admins)' },
  { name: 'effort', type: 'string', value: 'level', help: 'low, medium, high, xhigh (Extra) or max' },
  { name: 'mode', type: 'string', value: 'mode', help: 'auto, ask, accept, plan or bypass' },
  { name: 'permission-mode', type: 'string', value: 'mode', help: 'The same as --mode (Claude Code’s name)' },
  { name: 'allow', type: 'string', multiple: true, value: 'rule', help: 'With -p: allow calls like this, e.g. --allow "Bash(npm test *)" --allow Edit' },
  { name: 'yes-no', type: 'string', multiple: true, value: 'question', help: 'With decide: a yes-or-no question (give it again for more)' },
  { name: 'choice', type: 'string', multiple: true, value: 'a,b,c', help: 'With decide: which of these options fits, with --question; an option may be name=what it means' },
  { name: 'score', type: 'string', multiple: true, value: 'low,mid,high', help: 'With decide: a level on this scale (2 to 10 levels, lowest first), with --question' },
  { name: 'question', type: 'string', multiple: true, value: 'question', help: 'With decide: the question of a --choice or --score (one each, in the same order)' },
  { name: 'questions', type: 'string', value: 'file.json', help: 'With decide: the questions from a JSON file (an array of questions)' },
  { name: 'file', type: 'string', value: 'path', help: 'With decide: the text from this file' },
  { name: 'lines', type: 'boolean', help: 'With decide: each line of the text on its own, one line out for each' },
  { name: 'json', type: 'boolean', help: 'With decide: the whole result as JSON (with --lines, a list of them)' },
  { name: 'plain', type: 'boolean', help: 'No colour and no animation' },
  { name: 'screen-reader', type: 'boolean', help: 'Plain text that reads well with a screen reader' },
  { name: 'server', type: 'string', value: 'url', help: 'Use this server for this run (with ATELIER_TOKEN, for scripts)' },
  { name: 'version', short: 'v', type: 'boolean', help: 'Print the version' },
  { name: 'help', short: 'h', type: 'boolean', help: 'This help' },
  { name: 'local', type: 'boolean', help: '' },
  { name: 'force', type: 'boolean', help: '' },
  { name: 'beta', type: 'boolean', help: '' },
  { name: 'list', type: 'boolean', help: '' },
];

export const COMMAND_HELP: [string, string][] = [
  ['atelier', 'A session in this folder'],
  ['atelier "prompt"', 'A session that starts with this prompt'],
  ['atelier -p "prompt"', 'One answer, printed (stdin is added to the prompt)'],
  ['atelier setup', 'The setup wizard: a server or this computer, sign-in, models'],
  ['atelier login', 'Sign in to the server again'],
  ['atelier logout', 'Sign this terminal out'],
  ['atelier connect <url>', 'Connect to a server (or --local: only this computer)'],
  ['atelier status', 'Where it is connected, as whom, and versions'],
  ['atelier doctor', 'Check that everything works'],
  ['atelier models', 'The models you can use'],
  ['atelier sessions', 'Your Code sessions'],
  ['atelier decide [text]', 'Ask a decision model about a text (or --file, or stdin) with --yes-no, --choice or --score'],
  ['atelier decide --list', 'The decision model in use (admins: every one, with its id)'],
  ['atelier token', 'Print this terminal’s sign-in, for ATELIER_TOKEN in CI'],
  ['atelier update [--beta]', 'Update to the newest version'],
  ['atelier daemon status|stop|keep|unkeep', 'The background service (keep: start it at login)'],
  ['atelier reset-keys', 'Start the key store for saved API keys over (they are added again)'],
  ['atelier completion <bash|zsh|fish|pwsh>', 'Shell completion'],
  ['atelier licenses', 'The licenses of the code inside'],
];

/** An option or a word as it was typed, in order (`decide` pairs each --choice with its --question by it). */
export type ArgToken = { kind: 'option'; name: string; value?: string | undefined } | { kind: 'positional' | 'option-terminator' };

export function parse(argv: string[]) {
  const options = Object.fromEntries(FLAGS.map((f) => [f.name, { type: f.type, ...(f.short ? { short: f.short } : {}), ...(f.multiple ? { multiple: true } : {}) }]));
  return parseArgs({ args: argv, options: options as never, allowPositionals: true, strict: false, tokens: true }) as {
    values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    positionals: string[];
    tokens: ArgToken[];
  };
}

export function helpText(paint: { fg(role: 'accent' | 'muted', t: string): string; bold(t: string): string }): string {
  const commands = COMMAND_HELP.map(([c, h]) => `  ${paint.fg('accent', c.padEnd(42))}${h}`);
  const flags = FLAGS.filter((f) => f.help).map((f) => `  ${paint.fg('accent', `${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.value ? ` <${f.value}>` : ''}`.padEnd(42))}${f.help}`);
  return [paint.bold('Atelier CLI: a coding agent on your own models, in the terminal'), '', paint.bold('Usage'), ...commands, '', paint.bold('Options'), ...flags, '', paint.fg('muted', 'In a session, /help lists the commands and keys. Docs: https://docs.atelierhq.dev/cli/')].join('\n');
}
