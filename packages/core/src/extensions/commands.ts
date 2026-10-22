/**
 * Custom slash commands (ARCHITECTURE §10): markdown prompts in `commands` folders (subfolders group them),
 * started with `/name`. They share the `/` namespace with skills; a skill of the same name wins.
 */
import { frontmatter, skillBody, type ExtensionSource } from './skills.ts';

export interface Command {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
  scope: ExtensionSource['scope'];
  location: ExtensionSource['location'];
  pluginRoot?: string;
}

const NAME = /^[\w-]{1,64}$/;

/** Every command in the sources, earlier ones first; a name seen before is skipped. */
export async function discoverCommands(sources: ExtensionSource[]): Promise<Command[]> {
  const byName = new Map<string, Command>();
  for (const { fs, location, scope, roots, plugin } of sources) {
    for (const root of roots) {
      for (const entry of (await fs.list(root).catch(() => [])).sort()) {
        if (entry.startsWith('.')) continue;
        const files = entry.endsWith('.md') ? [`${root}${fs.sep}${entry}`] : (await fs.list(`${root}${fs.sep}${entry}`).catch(() => [])).filter((f) => f.endsWith('.md')).sort().map((f) => `${root}${fs.sep}${entry}${fs.sep}${f}`);
        for (const path of files) {
          const file = path.slice(path.lastIndexOf(fs.sep) + 1, -3);
          const name = plugin ? `${plugin.name}:${file}` : file;
          if (!NAME.test(file) || byName.has(name)) continue;
          const text = await fs.read(path).catch(() => null);
          if (text === null) continue;
          const { data } = frontmatter(text);
          const firstLine = skillBody(text).split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? '';
          const description = (typeof data.description === 'string' && data.description.trim()) || firstLine;
          byName.set(name, {
            name,
            description: description.length > 120 ? `${description.slice(0, 117)}...` : description,
            ...(typeof data['argument-hint'] === 'string' ? { argumentHint: data['argument-hint'] } : {}),
            path,
            scope,
            location,
            ...(plugin ? { pluginRoot: plugin.root } : {}),
          });
        }
      }
    }
  }
  return [...byName.values()];
}

/** The command's prompt with `$ARGUMENTS` and `$1`… (1-based, as Claude Code numbers them) filled in. */
export function renderCommand(text: string, args: string, pluginRoot = ''): string {
  const positional = args.trim() ? args.trim().split(/\s+/) : [];
  const body = skillBody(text).replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  const placesArgs = /\$ARGUMENTS|\$\d/.test(body);
  const filled = body.replaceAll('$ARGUMENTS', args.trim()).replace(/\$(\d+)/g, (_m, n: string) => positional[Number(n) - 1] ?? '');
  return args.trim() && !placesArgs ? `${filled}\n\nARGUMENTS: ${args.trim()}` : filled;
}
