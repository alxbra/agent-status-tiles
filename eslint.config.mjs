import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['out/**', 'release/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': 'warn',
    },
  },
);
