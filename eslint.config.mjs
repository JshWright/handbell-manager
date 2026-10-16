import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['.vite/**', 'out/**', 'dist/**', 'test/.build/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.electron,
  importX.flatConfigs.typescript,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
);
