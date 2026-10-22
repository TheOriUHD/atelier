import { extendTailwindMerge } from 'tailwind-merge';

export type ClassValue = string | false | null | undefined;

// Our type scale uses named sizes (`text-body`, `text-footnote`, …). Registering them keeps
// tailwind-merge from mistaking them for text colors like `text-fg`.
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        'prose-sm', 'prose', 'prose-lg', 'prose-h1', 'prose-h2', 'prose-h3', 'user-text', 'composer', 'body', 'body-strong',
        'footnote', 'control-sm', 'caption', 'badge', 'section-heading', 'title', 'page-title', 'greeting', 'code', 'code-block',
      ],
      radius: ['xs', 'sm', 'md', 'lg', 'xl', '2xl', 'composer', 'palette', 'full'],
      shadow: ['sm', 'md', 'lg', 'popover', 'panel', 'composer', 'card-ring', 'field-drop', 'focus'],
    },
  },
});

/** Joins truthy class names; when two set the same property, the later one wins (so a caller's `className` overrides). */
export function cn(...classes: ClassValue[]): string {
  return merge(classes.filter(Boolean).join(' '));
}
