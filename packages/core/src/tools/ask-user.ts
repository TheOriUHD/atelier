/** AskUser (ARCHITECTURE §8): multiple-choice questions the run waits on, answered in an inline card. */
import type { QuestionAnswer, QuestionRequest } from '@atelier/protocol';
import { textOutput, type DescribeContext, type Tool } from './types.ts';

type Ask = (sessionId: string, request: QuestionRequest, signal: AbortSignal) => Promise<QuestionAnswer>;

function describe({ tier, has }: DescribeContext): string {
  if (tier === 'compact') {
    return ['Asks the person up to four questions, each with 2 to 4 options, and waits for the answers.', '- Only for choices that belong to the person.', '- Put the option you recommend first.'].join('\n');
  }
  return [
    'Puts up to four questions with fixed choices to the person and waits for their answers.',
    `- Use it when you can't go on without a choice that belongs to the person: a preference, the scope, a trade-off with no clear default. Don't use it for something you can find out yourself, or to get permission for a tool call (the permission system asks for that)${has('ExitPlanMode') ? ', or to get a plan approved (ExitPlanMode does that)' : ''}.`,
    '- Each question is the full question ending with "?", a `header` of at most 12 characters for its chip, and 2 to 4 options, each with a short `label` (1 to 5 words) and a `description` of what choosing it means. Put the option you recommend first and add "(Recommended)" to its label.',
    '- The person can always type an answer of their own, so don\'t add an "Other" option.',
    "- Set `multiSelect` when the choices aren't exclusive.",
  ].join('\n');
}

export function createAskUserTool(ask: Ask): Tool<Pick<QuestionRequest, 'questions'>> {
  return {
    name: 'AskUser',
    readOnly: false,
    description: describe,
    compactExample: {
      questions: [
        {
          question: '<question>?',
          header: '<short label>',
          options: [
            { label: '<option>', description: '<what it means>' },
            { label: '<option>', description: '<what it means>' },
          ],
          multiSelect: false,
        },
      ],
    },
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', minLength: 1, maxLength: 500, description: 'The full question, ending with a question mark.' },
              header: { type: 'string', maxLength: 12, description: 'A label of at most 12 characters for the question\'s chip ("Database").' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', minLength: 1, maxLength: 80, description: 'The choice in 1 to 5 words.' },
                    description: { type: 'string', maxLength: 300, description: 'What choosing this means.' },
                  },
                  required: ['label', 'description'],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: 'boolean', description: 'Whether several options can be chosen.' },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    async run({ questions }, ctx) {
      if (new Set(questions.map((q) => q.question)).size !== questions.length) return textOutput('Each question must be different.', true);
      const { answers } = await ask(ctx.sessionId, { callId: ctx.callId, questions }, ctx.signal);
      const lines = questions.filter((q) => answers[q.question]?.trim()).map((q) => `"${q.question}" = "${answers[q.question]!.trim()}"`);
      if (!lines.length) return textOutput('The person dismissed the questions without answering. Continue with your best judgment and say which assumptions you made.');
      return textOutput(`The person answered:\n${lines.join('\n')}\nContinue with these answers in mind.`);
    },
  };
}
