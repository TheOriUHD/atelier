// Prints Atelier's prompts from the repository: `pnpm prompts:show` lists them, `pnpm prompts:show chat.full` prints a
// template, `pnpm prompts:show --assembled code.full` prints what a model receives in that kind of session (system
// blocks, notes and tools as JSON), and `--all` prints every template. They are also published at
// https://docs.atelierhq.dev/prompts/ (see docs/PROMPTS.md for how they are assembled).
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const templates = join(root, 'prompts');
const assembled = join(root, 'src/prompts/__snapshots__/prompts');

const args = process.argv.slice(2);
const names = async (dir, ext) => (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(ext)).map((f) => f.split('\\').join('/').slice(0, -ext.length)).sort();

if (args[0] === '--assembled') {
  const all = await names(assembled, '.txt');
  const name = args[1];
  if (!name || !all.includes(name)) {
    console.error(`${name ? `No assembled prompt called "${name}".` : 'Name an assembled prompt.'} Available:\n  ${all.join('\n  ')}`);
    process.exit(1);
  }
  process.stdout.write(await readFile(join(assembled, `${name}.txt`), 'utf8'));
} else if (args[0] === '--all') {
  for (const name of await names(templates, '.md')) process.stdout.write(`\n===== ${name} (packages/core/prompts/${name}.md) =====\n\n${await readFile(join(templates, `${name}.md`), 'utf8')}`);
} else if (args[0]) {
  const all = await names(templates, '.md');
  if (!all.includes(args[0])) {
    console.error(`No prompt called "${args[0]}". Available:\n  ${all.join('\n  ')}`);
    process.exit(1);
  }
  process.stdout.write(await readFile(join(templates, `${args[0]}.md`), 'utf8'));
} else {
  console.log('Prompt templates (pnpm prompts:show <name>):');
  for (const name of await names(templates, '.md')) console.log(`  ${name}`);
  console.log('\nAssembled prompts, what a model receives (pnpm prompts:show --assembled <name>):');
  for (const name of await names(assembled, '.txt')) console.log(`  ${name}`);
  console.log('\n--all prints every template. Docs: https://docs.atelierhq.dev/prompts/');
}
