/** Schema for design/tokens/tokens.json. build-theme validates against it and emits tokens.schema.json. */
import { z } from 'zod';

const colorRoles = [
  'background', 'background-sunken', 'sidebar', 'surface', 'surface-raised', 'surface-popover',
  'border', 'border-subtle', 'border-strong', 'border-stronger',
  'text-primary', 'text-secondary', 'text-muted', 'text-disabled',
  'accent', 'accent-hover', 'on-accent', 'brand-mark',
  'interactive', 'interactive-hover', 'interactive-text', 'interactive-subtle', 'on-interactive',
  'danger', 'danger-hover', 'danger-text', 'danger-subtle',
  'success', 'success-text', 'success-subtle',
  'warning', 'warning-text', 'warning-subtle',
  'fill-primary', 'fill-primary-hover', 'on-primary',
  'fill-secondary', 'fill-secondary-hover', 'fill-secondary-ring',
  'fill-ghost-hover', 'fill-ghost-selected', 'fill-field', 'fill-field-ring', 'fill-control',
  'segmented-track', 'segmented-thumb', 'switch-track', 'switch-track-hover', 'switch-knob',
  'badge-bg', 'tooltip-bg', 'tooltip-fg', 'backdrop', 'user-message',
  'focus-ring', 'focus-glow', 'selection', 'code-background', 'code-inline-background',
  'diff-added', 'diff-added-bg', 'diff-removed', 'diff-removed-bg', 'diff-modified',
  // Signs, line numbers and counts on the diff backgrounds, at least 4.5:1 on them.
  'diff-added-text', 'diff-removed-text',
  // Syntax colors for the Atelier themes, each at least 4.5:1 on code and diff backgrounds.
  'code-keyword', 'code-type', 'code-string', 'code-comment',
  'progress-track', 'skeleton',
  // The effort slider, and Ultracode's violet: its label and the charged cells drawn in the slider's fill.
  'slider-fill', 'slider-stop', 'pro',
  'ultracode-charged-start', 'ultracode-charged-end', 'ultracode-ink-cool', 'ultracode-ink-hot',
] as const;

const color = z.string().regex(/^(#[0-9A-F]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0|1|0?\.\d+)\)|transparent)$/, 'hex (#RRGGBB) or rgba(r, g, b, a)');
const palette = z.object(Object.fromEntries(colorRoles.map((r) => [r, color])) as Record<(typeof colorRoles)[number], typeof color>).strict();

const weightName = z.enum(['regular', 'medium', 'semibold', 'bold']);
const fontFamily = z.object({ family: z.string(), fallback: z.string(), role: z.string() }).strict();
const typeRole = z.object({
  family: z.enum(['sans', 'serif', 'mono']),
  size: z.union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?em$/)]),
  lineHeight: z.number().positive(),
  weight: weightName,
  tracking: z.number(),
  note: z.string().optional(),
}).strict();
const shadowSet = z.object({
  sm: z.string(), md: z.string(), lg: z.string(), popover: z.string(), panel: z.string(),
  composer: z.string(), 'card-ring': z.string(), 'field-drop': z.string(), focus: z.string(), 'slider-thumb': z.string(),
}).strict();

export const TokensSchema = z.object({
  $schema: z.string().optional(),
  meta: z.object({ source: z.string(), updatedAt: z.string(), viewport: z.tuple([z.number(), z.number()]), notes: z.array(z.string()) }).strict(),
  color: z.object({ light: palette, dark: palette }).strict(),
  font: z.object({ sans: fontFamily, serif: fontFamily, mono: fontFamily, dyslexic: fontFamily, system: fontFamily }).strict(),
  fontWeight: z.record(weightName, z.number().int().min(100).max(900)),
  type: z.record(z.string().regex(/^[a-z0-9-]+$/), typeRole),
  space: z.record(z.string(), z.number().nonnegative()),
  radius: z.record(z.string(), z.number().nonnegative()),
  shadow: z.object({ light: shadowSet, dark: shadowSet }).strict(),
  size: z.object({
    icon: z.record(z.string(), z.number()),
    control: z.record(z.string(), z.number()),
    switch: z.record(z.string(), z.tuple([z.number(), z.number()])),
    avatar: z.record(z.string(), z.number()),
    checkbox: z.record(z.string(), z.number()),
  }).strict(),
  motion: z.object({ duration: z.record(z.string(), z.number()), easing: z.record(z.string(), z.string()) }).strict(),
  layout: z.record(z.string(), z.unknown()),
}).strict();

export type Tokens = z.infer<typeof TokensSchema>;
export { colorRoles };
