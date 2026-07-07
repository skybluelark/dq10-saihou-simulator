/// <reference types="vitest/config" />
import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * data/recipes.csv をビルド成果物(dist/data/)へコピーする。
 * アプリは実行時に fetch("data/recipes.csv") で読むため(ARCHITECTURE A5)、
 * 開発サーバではプロジェクト直下の実ファイルが配信されるが、
 * ビルド配信(vite preview / 静的ホスティング)では dist に同梱する必要がある。
 */
function copyRecipesCsv(): Plugin {
  return {
    name: 'copy-recipes-csv',
    apply: 'build',
    closeBundle() {
      mkdirSync('dist/data', { recursive: true });
      copyFileSync('data/recipes.csv', 'dist/data/recipes.csv');
    },
  };
}

export default defineConfig({
  plugins: [react(), copyRecipesCsv()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
