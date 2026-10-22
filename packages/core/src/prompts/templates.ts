/**
 * Prompt template files (`prompts/**.md`, embedded at build time, overridable in ~/.atelier/prompts): lookup, `{{var}}`
 * substitution and `<!-- if:cond -->…<!-- endif -->` guards, which the builder resolves so the model never sees a
 * condition. A guard is either a block (both comments on lines of their own) or inline within one line; `!` negates a
 * condition and `&` joins conditions that must all hold.
 */
import { join, relative } from 'node:path';
import type { WorkspaceFs } from '../fs/workspace-fs.ts';
import { BUILTIN_TOOLS } from '../tools/types.ts';
import { defaultTemplates } from './templates.gen.ts';

export type Overrides = Partial<Record<string, string>>;

/** Answers a guard condition; undefined means the condition is unknown, which is an error in the template. */
export type Condition = (cond: string) => boolean | undefined;

export function template(name: string, overrides: Overrides = {}): string {
  const t = overrides[name] ?? defaultTemplates[name];
  if (t === undefined) throw new Error(`Unknown prompt template ${name}`);
  return t;
}

export function hasTemplate(name: string, overrides: Overrides = {}): boolean {
  return (overrides[name] ?? defaultTemplates[name]) !== undefined;
}

export function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '').trim();
}

const OPEN = /^<!-- if:(\S+) -->$/;
const CLOSE = '<!-- endif -->';
const INLINE = /<!-- if:(\S+) -->(.*?)<!-- endif -->/g;

/** Resolves every guard in `text`; `name` identifies the template in errors. Guards don't nest. */
export function resolveGuards(text: string, test: Condition, name: string): string {
  const one = (raw: string): boolean => {
    const negated = raw.startsWith('!');
    const result = test(negated ? raw.slice(1) : raw);
    if (result === undefined) throw new Error(`Unknown condition "${raw}" in prompt template ${name}`);
    return negated ? !result : result;
  };
  const check = (raw: string): boolean => raw.split('&').every(one);
  const out: string[] = [];
  let open: boolean | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const start = OPEN.exec(trimmed);
    if (start) {
      if (open !== null) throw new Error(`Nested guard in prompt template ${name}`);
      open = check(start[1]!);
      continue;
    }
    if (trimmed === CLOSE) {
      if (open === null) throw new Error(`Unmatched ${CLOSE} in prompt template ${name}`);
      open = null;
      continue;
    }
    if (open === false) continue;
    out.push(line.replace(INLINE, (_m, cond: string, body: string) => (check(cond) ? body : '')));
  }
  if (open !== null) throw new Error(`Unclosed guard in prompt template ${name}`);
  return renumber(out.join('\n')).replace(/\n{3,}/g, '\n\n');
}

/** Numbers each run of `N. ` lines 1, 2, 3… again, so rules dropped by a guard leave no gaps. */
function renumber(text: string): string {
  let n = 0;
  return text
    .split('\n')
    .map((line) => {
      const m = /^(\d+)\. /.exec(line);
      if (!m) {
        n = 0;
        return line;
      }
      return `${++n}. ${line.slice(m[0].length)}`;
    })
    .join('\n');
}

/**
 * A note or string template: guards test whether a variable is non-empty or, given the session's `tools`, whether it has
 * a built-in tool, so a note that can arrive later names only tools the session has. Then the variables are filled in.
 */
export function renderNote(name: string, vars: Record<string, string>, overrides: Overrides = {}, tools?: readonly string[]): string {
  const test: Condition = (cond) => (cond in vars ? vars[cond] !== '' : tools && (BUILTIN_TOOLS as readonly string[]).includes(cond) ? tools.includes(cond) : undefined);
  return render(resolveGuards(template(name, overrides), test, name), vars);
}

/** Reads template overrides (`<name>.md`, also in subfolders such as `notes/`) from the prompts directory, if any. */
export async function loadTemplateOverrides(fs: WorkspaceFs, dir: string): Promise<Overrides> {
  const out: Overrides = {};
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await fs.list(folder)) {
      const path = join(folder, entry.name);
      if (entry.kind === 'dir') await walk(path);
      else if (entry.kind === 'file' && entry.name.endsWith('.md')) {
        const text = await fs.read(path);
        if (text?.trim()) out[relative(dir, path).slice(0, -3).split('\\').join('/')] = text;
      }
    }
  };
  await walk(dir);
  return out;
}
