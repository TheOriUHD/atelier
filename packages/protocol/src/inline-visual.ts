/** A self-contained visual shown in the conversation, stored as an inline_visual tool call's input. */
import { z } from 'zod';

export const INLINE_VISUAL_TITLE_MAX = 120;
export const INLINE_VISUAL_DESCRIPTION_MAX = 1_000;
export const INLINE_VISUAL_HTML_MAX = 100_000;

export const InlineVisual = z.object({
  title: z.string().trim().min(1).max(INLINE_VISUAL_TITLE_MAX),
  html: z.string().min(1).max(INLINE_VISUAL_HTML_MAX).refine((html) => html.trim().length > 0),
  description: z.string().trim().min(1).max(INLINE_VISUAL_DESCRIPTION_MAX),
}).strict();
export type InlineVisual = z.infer<typeof InlineVisual>;
