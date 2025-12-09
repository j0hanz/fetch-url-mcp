import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // Global ignores
  {
    ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'reports/**'],
  },

  // Base JS recommended config
  eslint.configs.recommended,

  // TypeScript recommended config
  ...tseslint.configs.recommended,

  // TypeScript strict type-checked config for src files only
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // HIGH: TypeScript strict rules
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // MEDIUM: Clean code
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-require-imports': 'off',

      // Allow floating promises in specific patterns (IIFE in setInterval)
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreVoid: true },
      ],

      // Relax some rules for this project
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false },
      ],

      // Allow deprecated APIs (MCP SDK migration in progress)
      '@typescript-eslint/no-deprecated': 'warn',

      // Async handlers that return sync values are fine
      '@typescript-eslint/require-await': 'off',

      // Allow spread on iterables in objects (intentional pattern)
      '@typescript-eslint/no-misused-spread': 'off',

      // Allow void expressions in arrow functions for cleaner code
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true },
      ],
    },
  },

  // TypeScript config for test files and config files (no type-checking)
  {
    files: ['tests/**/*.ts', '*.config.ts', '*.config.mjs'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },

  // Node.js test scripts (ESM)
  {
    files: ['test-*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Prettier config (must be last to override formatting rules)
  eslintConfigPrettier
);
