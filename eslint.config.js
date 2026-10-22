import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['.claude/**', '**/dist/**', '**/out/**', '**/release/**', '**/coverage/**', '**/.wrangler/**', '**/.astro/**', 'design/reference/**', 'design/scripts/*.js', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
    },
  },
  // The website's scripts run in the visitor's browser, as plain scripts.
  { files: ['apps/site/public/**/*.js'], languageOptions: { globals: { ...globals.browser }, sourceType: 'script' } },
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      // The composer and dialog inputs take focus on open, on purpose.
      'jsx-a11y/no-autofocus': 'off',
    },
  },
);
