/**
 * "Atelier Light" and "Atelier Dark": original Shiki syntax themes whose every color is one of our
 * design-token colors (packages/ui/theme/colors.json, generated from design/tokens/tokens.json). The `code-*`
 * roles keep the brand hues dark (or light) enough for 4.5:1 on code and diff backgrounds.
 */
import type { ThemeRegistration } from 'shiki/core';
import colors from '../../../theme/colors.json';

/** The token roles a syntax theme draws from. All of them are hex colors in both themes. */
type Role =
  | 'background'
  | 'text-primary'
  | 'text-secondary'
  | 'interactive-text'
  | 'warning-text'
  | 'danger-text'
  | 'diff-added'
  | 'diff-removed'
  | 'diff-modified'
  | 'code-keyword'
  | 'code-type'
  | 'code-string'
  | 'code-comment';

export type CodePalette = Record<Role, string>;

/** TextMate scopes → token role (+ font style). Later rules win for more specific scopes. */
const RULES: [scopes: string[], role: Role, fontStyle?: string][] = [
  [['comment', 'punctuation.definition.comment', 'string.comment'], 'code-comment', 'italic'],
  [
    ['punctuation', 'meta.brace', 'keyword.operator', 'punctuation.definition.tag', 'punctuation.separator'],
    'text-secondary',
  ],
  [['variable', 'variable.other', 'meta.object-literal.key', 'entity.name.variable'], 'text-primary'],
  [
    [
      'keyword',
      'storage',
      'storage.type',
      'storage.modifier',
      'keyword.control',
      'keyword.operator.new',
      'keyword.operator.expression',
      'keyword.operator.logical.python',
    ],
    'code-keyword',
  ],
  [['variable.language', 'support.variable.language'], 'code-keyword', 'italic'],
  [['string', 'punctuation.definition.string', 'markup.inline.raw', 'markup.fenced_code'], 'code-string'],
  [['string.regexp', 'constant.character.escape', 'constant.other.placeholder', 'invalid'], 'danger-text'],
  [
    [
      'constant',
      'constant.numeric',
      'constant.language',
      'support.constant',
      'variable.other.enummember',
      'entity.other.attribute-name',
    ],
    'warning-text',
  ],
  [
    [
      'entity.name.function',
      'support.function',
      'meta.function-call entity.name.function',
      'support.type.property-name',
      'markup.underline.link',
      'markup.link',
    ],
    'interactive-text',
  ],
  [
    [
      'entity.name.type',
      'entity.name.class',
      'entity.other.inherited-class',
      'support.type',
      'support.class',
      'entity.name.namespace',
      'storage.type.primitive',
    ],
    'code-type',
  ],
  [['entity.name.tag'], 'diff-removed'],
  [['markup.heading', 'entity.name.section'], 'code-keyword', 'bold'],
  [['markup.bold'], 'text-primary', 'bold'],
  [['markup.italic'], 'text-primary', 'italic'],
  [['markup.inserted'], 'diff-added'],
  [['markup.deleted'], 'diff-removed'],
  [['markup.changed'], 'diff-modified'],
];

export function buildCodeTheme(name: string, displayName: string, type: 'light' | 'dark', palette: CodePalette): ThemeRegistration {
  return {
    name,
    displayName,
    type,
    fg: palette['text-primary'],
    bg: palette.background,
    colors: { 'editor.foreground': palette['text-primary'], 'editor.background': palette.background },
    tokenColors: RULES.map(([scope, role, fontStyle]) => ({
      scope,
      settings: { foreground: palette[role], ...(fontStyle ? { fontStyle } : {}) },
    })),
  };
}

/** Named by id like Shiki's bundled themes, so settings store either kind the same way. */
export const atelierLight = buildCodeTheme('atelier-light', 'Atelier Light', 'light', colors.light);
export const atelierDark = buildCodeTheme('atelier-dark', 'Atelier Dark', 'dark', colors.dark);
