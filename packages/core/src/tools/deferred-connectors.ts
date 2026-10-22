import type { Message } from '@atelier/protocol';
import type { DescribedTool } from './types.ts';
import { textOutput } from './types.ts';

/** Keeps connector schemas out of browser prompts until the model asks for them. */
export function deferConnectors(tools: DescribedTool[], history: Message[]): { tools: DescribedTool[]; available(): DescribedTool[] } {
  const connectors = tools.filter(tool => tool.name.startsWith('mcp__'));
  if (!connectors.length) return { tools, available: () => tools };
  const succeeded = new Set(history.flatMap(message => message.parts.flatMap(part => part.type === 'tool_result' && !part.isError ? [part.callId] : [])));
  const loaded = new Set(history.flatMap(message => message.parts.flatMap(part => {
    if (part.type !== 'tool_call' || part.name !== 'ToolSearch' || !succeeded.has(part.id) || !part.input || typeof part.input !== 'object') return [];
    const names = 'names' in part.input ? part.input.names : undefined;
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
  })));
  const search: DescribedTool = {
    name: 'ToolSearch',
    description: [
      'Load the full description and argument schema of connector tools before calling them. Pick up to three exact names from this catalog. Loaded tools become callable in the next reply. Loading does not run them or grant permission.',
      ...connectors.map(tool => `${tool.name}: ${tool.description.replace(/\s+/g, ' ').trim().slice(0, 140)}`),
    ].join('\n'),
    inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, uniqueItems: true } }, required: ['names'], additionalProperties: false },
    readOnly: true,
    async run(input) {
      const names = (input as { names: string[] }).names;
      const selected = names.map(name => connectors.find(tool => tool.name === name));
      if (selected.some(tool => !tool)) return textOutput('Unknown connector tool. Use exact names from the ToolSearch catalog.', true);
      for (const tool of selected) loaded.add(tool!.name);
      return textOutput(`Loaded ${names.join(', ')}. Their full descriptions and argument schemas are available in the next reply.`);
    },
  };
  const all = [...tools, search];
  return { tools: all, available: () => all.filter(tool => !tool.name.startsWith('mcp__') || loaded.has(tool.name)) };
}
