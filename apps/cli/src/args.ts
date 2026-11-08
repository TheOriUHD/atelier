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
  { name: 'model', short: 'm', type: 'string', value: 'model', help: 'The model for new sessions (a name or provider/model)' },
  { name: 'effort', type: 'string', value: 'level', help: 'low, medium, high, xhigh (Extra) or max' },
  { name: 'mode', type: 'string', value: 'mode', help: 'auto, ask, accept, plan or bypass' },
  { name: 'permission-mode', type: 'string', value: 'mode', help: 'The same as --mode (Claude Code’s name)' },
  { name: 'allow', type: 'string', multiple: true, value: 'rule', help: 'With -p: allow calls like this, e.g. --allow "Bash(npm test *)" --allow Edit' },
  { name: 'plain', type: 'boolean', help: 'No colour and no animation' },
  { name: 'screen-reader', type: 'boolean', help: 'Plain text that reads well with a screen reader' },
  { name: 'server', type: 'string', value: 'url', help: 'Use this server for this run (with ATELIER_TOKEN, for scripts)' },
  { name: 'version', short: 'v', type: 'boolean', help: 'Print the version' },
  { name: 'help', short: 'h', type: 'boolean', help: 'This help' },
  { name: 'local', type: 'boolean', help: '' },
  { name: 'force', type: 'boolean', help: '' },
  { name: 'beta', type: 'boolean', help: '' },
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
  ['atelier token', 'Print this terminal’s sign-in, for ATELIER_TOKEN in CI'],
  ['atelier update [--beta]', 'Update to the newest version'],
  ['atelier daemon status|stop|keep|unkeep', 'The background service (keep: start it at login)'],
  ['atelier completion <bash|zsh|fish|pwsh>', 'Shell completion'],
  ['atelier licenses', 'The licenses of the code inside'],
];

export function parse(argv: string[]) {
  const options = Object.fromEntries(FLAGS.map((f) => [f.name, { type: f.type, ...(f.short ? { short: f.short } : {}), ...(f.multiple ? { multiple: true } : {}) }]));
  return parseArgs({ args: argv, options: options as never, allowPositionals: true, strict: false }) as { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };
}

export function helpText(paint: { fg(role: 'accent' | 'muted', t: string): string; bold(t: string): string }): string {
  const commands = COMMAND_HELP.map(([c, h]) => `  ${paint.fg('accent', c.padEnd(42))}${h}`);
  const flags = FLAGS.filter((f) => f.help).map((f) => `  ${paint.fg('accent', `${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.value ? ` <${f.value}>` : ''}`.padEnd(42))}${f.help}`);
  return [paint.bold('Atelier CLI: a coding agent on your own models, in the terminal'), '', paint.bold('Usage'), ...commands, '', paint.bold('Options'), ...flags, '', paint.fg('muted', 'In a session, /help lists the commands and keys. Docs: https://docs.atelierhq.dev/cli/')].join('\n');
}
