/** Skill (ARCHITECTURE §10): loads a skill's instructions when the task calls for it. */
import { textOutput, type Tool } from './types.ts';

export function createSkillTool(load: (sessionId: string, name: string, args: string) => Promise<string>): Tool<{ skill: string; args?: string }> {
  return {
    name: 'Skill',
    // Loading instructions changes nothing.
    readOnly: true,
    description: ({ tier }) =>
      tier === 'compact'
        ? ['Loads the instructions of a skill from `<available_skills>`.', '- Load a matching skill before you start the task, then follow it.', '- Use the exact skill name.'].join('\n')
        : [
            'Loads the instructions of an installed skill.',
            '- When a skill in `<available_skills>` fits the request, load it before you start and follow it in place of your usual approach.',
            '- Use the exact name from the list (`plugin:skill` for plugin skills); `args` passes arguments.',
            '- If the skill\'s text is already in the turn (inside `<skill>`), follow it without loading it again.',
            '- Paths a skill mentions are relative to its base directory.',
          ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', minLength: 1, maxLength: 130, description: 'The skill name exactly as listed, e.g. "pdf" or "plugin:skill".' },
        args: { type: 'string', maxLength: 10_000, description: 'Arguments for the skill, if it takes any.' },
      },
      required: ['skill'],
      additionalProperties: false,
    },
    run: async ({ skill, args }, ctx) => textOutput(await load(ctx.sessionId, skill, args ?? '')),
  };
}
