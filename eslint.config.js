import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  {
    ignores: ['dist', 'coverage', 'node_modules'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      import: importPlugin,
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
    },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/core',
              from: ['./src/data', './src/stats', './src/ui'],
              message: 'src/core は他の層に依存してはいけません(依存方向: ui/data/stats → core)。',
            },
            {
              target: './src/data',
              from: ['./src/ui'],
              message: 'src/data は src/ui に依存してはいけません。',
            },
            {
              target: './src/stats',
              from: ['./src/ui'],
              message: 'src/stats は src/ui に依存してはいけません。',
            },
          ],
        },
      ],
    },
  },
);
