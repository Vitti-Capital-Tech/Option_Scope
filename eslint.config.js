import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // Engine (Node) code. Runs under Node, not the browser, so it gets Node
  // globals — otherwise `process`, `Buffer`, etc. produce false `no-undef`
  // errors that bury the real ones. This block is intentionally narrow: it
  // keeps the critical correctness rules from js.recommended (no-undef,
  // no-const-assign, no-dupe-keys, …) and silences the noisy style rules so
  // `npm run lint:engine` output stays actionable. `no-undef` here is what
  // catches out-of-scope references like the `longCV` live-trading bug.
  {
    files: ['engine/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
])
