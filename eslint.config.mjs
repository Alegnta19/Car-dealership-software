// FBL-000 lint baseline. typescript-eslint recommended (non-type-checked: deterministic
// and fast in CI), with the current violation count ratcheted by
// scripts/quality-ratchet.ts — existing findings are recorded debt, new ones fail CI.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Tool configuration in CommonJS (.cjs) is legitimate require/module territory.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    rules: {
      // Counted as debt, not banned outright in FBL-000: the service layer leans on
      // `any` for row shapes. The ratchet blocks growth; typed rows arrive with the
      // architecture shell (FBL-010+), not as a mass edit here.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
