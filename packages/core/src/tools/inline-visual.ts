import { InlineVisual, INLINE_VISUAL_DESCRIPTION_MAX, INLINE_VISUAL_HTML_MAX, INLINE_VISUAL_TITLE_MAX } from '@atelier/protocol';
import { textOutput, type DescribeContext, type Tool } from './types.ts';

function describe({ tier, has }: DescribeContext): string {
  const core = [
    'Shows a self-contained inline explainer or mini app in the conversation when seeing or interacting helps understanding; not for every answer.',
    ...(has('artifact') ? ['Use artifact for a standalone deliverable to keep or edit; inline_visual is for understanding and quick prototypes.'] : []),
    'Write an HTML fragment with CSS and any script last, not an iframe or a full page. Use vanilla JS, CSS, SVG or Canvas; no external network, assets, libraries or storage.',
    'Blend into the conversation: no app chrome or repeated page heading unless useful. Use theme variables --text-primary, --text-secondary, --text-muted, --surface-1, --surface-2, --border, --border-strong and --text-accent.',
    'Provide accessible, keyboard-operable controls and a plain-language description. Animate with requestAnimationFrame and elapsed time, and respect prefers-reduced-motion.',
  ];
  if (tier === 'full') core.push('Keep the visual focused and readable at conversation width. Make controls do something useful; use clear labels and visible focus, and do not rely on color alone. The description explains what the visual shows without needing to see it.');
  return core.join('\n');
}

/** The transcript already stores the input; the renderer displays it without a duplicate HTML result or artifact. */
export function createInlineVisualTool(): Tool<InlineVisual> {
  return {
    name: 'inline_visual',
    readOnly: true,
    description: describe,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: INLINE_VISUAL_TITLE_MAX },
        html: { type: 'string', minLength: 1, maxLength: INLINE_VISUAL_HTML_MAX, description: 'Self-contained HTML fragment, with CSS and any script last.' },
        description: { type: 'string', minLength: 1, maxLength: INLINE_VISUAL_DESCRIPTION_MAX, description: 'Plain-language explanation, also available without the visual.' },
      },
      required: ['title', 'html', 'description'],
      additionalProperties: false,
    },
    async run(input) {
      if (!InlineVisual.safeParse(input).success) return textOutput('Invalid inline visual: provide a title (1–120 characters), HTML (1–100000 characters), and description (1–1000 characters).', true);
      return textOutput('Inline visual shown.');
    },
  };
}
