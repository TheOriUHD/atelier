/**
 * Skills (ARCHITECTURE §10): folders with a SKILL.md, found in the global roots on the backend's machine and
 * the project roots in the workspace. Only names and descriptions go into the prompt; the Skill tool loads
 * the full instructions when the model (or the person, with /name) picks one. Parsing is lenient: real-world
 * SKILL.md files are often not quite valid YAML.
 */
import { parse as parseYaml } from 'yaml';
import { escapeTags } from '../prompts/escape.ts';

export interface Skill {
  name: string;
  description: string;
  /** The folder with SKILL.md; scripts and references live next to it. */
  dir: string;
  /** SKILL.md itself. */
  path: string;
  scope: ExtensionSource['scope'];
  /** Where the folder is: the backend's machine, or the workspace's (read through its runner). */
  location: 'host' | 'workspace';
  /** Set for a plugin's skills. */
  pluginRoot?: string;
  /** Only `/name` can start it. */
  disableModelInvocation: boolean;
  /** Listed in the `/` menu. */
  userInvocable: boolean;
  argumentHint?: string;
  /** Issues worth showing in Settings (a name that doesn't match its folder, frontmatter that isn't YAML). */
  warnings: string[];
}

/** How extension roots are read: the backend's own files, or a workspace through its runner. */
export interface ExtensionFs {
  sep: string;
  /** Entry names in a directory; empty when it doesn't exist. */
  list(dir: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  /** The resolved path, so a skill linked into several roots counts once. */
  realpath(path: string): Promise<string>;
}

export interface ExtensionSource {
  fs: ExtensionFs;
  location: 'host' | 'workspace';
  scope: 'project' | 'global' | 'plugin';
  roots: string[];
  /** A plugin's components: names become `plugin:name`, and `${CLAUDE_PLUGIN_ROOT}` points at its folder. */
  plugin?: { name: string; root: string };
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_DESCRIPTION = 1024;

/** Every skill in the sources, earlier sources and roots first; a name or folder seen before is skipped. */
export async function discoverSkills(sources: ExtensionSource[]): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  const dirs = new Set<string>();
  for (const { fs, location, scope, roots, plugin } of sources) {
    for (const root of roots) {
      for (const entry of (await fs.list(root).catch(() => [])).sort()) {
        if (entry.startsWith('.')) continue;
        const dir = `${root}${fs.sep}${entry}`;
        const text = await fs.read(`${dir}${fs.sep}SKILL.md`).catch(() => null);
        if (text === null) continue;
        const real = await fs.realpath(dir).catch(() => dir);
        if (dirs.has(real)) continue;
        dirs.add(real);
        const parsed = parseSkill(text, entry);
        const name = parsed && (plugin ? `${plugin.name}:${parsed.name}` : parsed.name);
        if (!parsed || !name || byName.has(name)) continue;
        byName.set(name, { ...parsed, name, dir, path: `${dir}${fs.sep}SKILL.md`, scope, location, ...(plugin ? { pluginRoot: plugin.root } : {}) });
      }
    }
  }
  return [...byName.values()];
}

/** A SKILL.md's metadata; null without a description (the model couldn't know when to use it). */
export function parseSkill(text: string, folder: string): Omit<Skill, 'dir' | 'path' | 'scope' | 'location'> | null {
  const { data, warnings } = frontmatter(text);
  const description = typeof data.description === 'string' ? data.description.trim().replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION) : '';
  if (!description) return null;
  let name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : folder;
  if (!NAME.test(name)) {
    warnings.push(`“${name}” isn't a valid skill name (lowercase letters, digits and hyphens); using the folder name.`);
    name = folder;
  } else if (name !== folder) warnings.push(`The name “${name}” differs from its folder “${folder}”.`);
  return {
    name,
    description,
    disableModelInvocation: data['disable-model-invocation'] === true,
    userInvocable: data['user-invocable'] !== false,
    ...(typeof data['argument-hint'] === 'string' ? { argumentHint: data['argument-hint'] } : {}),
    warnings,
  };
}

/** The text after the frontmatter. */
export function skillBody(text: string): string {
  return text.replace(FRONTMATTER, '').trim();
}

export function frontmatter(text: string): { data: Record<string, unknown>; warnings: string[] } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, warnings: ['No frontmatter.'] };
  // Some installers write `disable-model-invocation: false` without its newline: `…: falsename: pdf`.
  const yaml = match[1]!.replace(/^([\w-]+:[ \t]*(?:true|false))(?=[a-z][\w-]*:)/gm, '$1\n');
  try {
    const data = parseYaml(yaml) as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data)) return { data: data as Record<string, unknown>, warnings: [] };
  } catch {
    // Fall through to the line-based reading below.
  }
  return { data: lenient(yaml), warnings: ['The frontmatter isn’t valid YAML; only its name and description were read.'] };
}

/** `name:` and `description:` lines (with folded or literal continuation lines) from broken YAML. */
function lenient(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let value = m[2]!.trim();
    if (value === '' || value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      value = block.join(' ');
    }
    out[m[1]!] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const SKILL_LIST_TAG = '<available_skills>';

/** Whether a system prompt block is the skill list (counted apart in the context breakdown). */
export function isSkillList(text: string): boolean {
  return text.startsWith(SKILL_LIST_TAG);
}

/**
 * The `<available_skills>` block: names and descriptions the model may pick from, within `budget`
 * characters (about 1% of the context window), most specific first. `namesOnly` is the compact tier's
 * last resort when the whole prompt is over its budget (prompts/budget.ts).
 */
export function renderSkillList(skills: Skill[], budget: number, { namesOnly = false } = {}): string {
  const offered = skills.filter((s) => !s.disableModelInvocation);
  if (!offered.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const s of offered) {
    // Names and descriptions come from SKILL.md files: they can't open or close Atelier's tags (prompts/escape.ts).
    const line = escapeTags(namesOnly ? `- ${s.name}` : `- ${s.name}: ${s.description.length > 250 ? `${s.description.slice(0, 247)}...` : s.description}`);
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  const more = offered.length - lines.length;
  return [
    SKILL_LIST_TAG,
    'Skills hold instructions for specific tasks. When a request matches one, load it with the Skill tool before you start, then follow it.',
    ...(namesOnly ? ['Only the names are listed, to save room; loading a skill shows what it covers.'] : []),
    ...lines,
    ...(more ? [`(${more} more not listed; the Skill tool can load any skill by name.)`] : []),
    '</available_skills>',
  ].join('\n');
}

/**
 * A skill's instructions for the model: `$ARGUMENTS`, `$0`… and the `${CLAUDE_*}` variables filled in, and
 * the arguments appended when the skill doesn't place them itself.
 */
export function renderSkill(skill: Skill, text: string, args: string, vars: { projectDir: string; sessionId: string }): string {
  const positional = args.trim() ? args.trim().split(/\s+/) : [];
  let body = skillBody(text)
    .replaceAll('${CLAUDE_SKILL_DIR}', skill.dir)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', skill.pluginRoot ?? '')
    .replaceAll('${CLAUDE_PROJECT_DIR}', vars.projectDir)
    .replaceAll('${CLAUDE_SESSION_ID}', vars.sessionId);
  const placesArgs = /\$ARGUMENTS|\$\d/.test(body);
  body = body.replaceAll('$ARGUMENTS', args.trim()).replace(/\$(\d+)/g, (_m, n: string) => positional[Number(n)] ?? '');
  return [`Base directory for this skill: ${skill.dir}`, '', body, ...(args.trim() && !placesArgs ? ['', `ARGUMENTS: ${args.trim()}`] : [])].join('\n');
}
