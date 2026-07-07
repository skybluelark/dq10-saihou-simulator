// src/data/recipes.json → data/recipes.csv への書き出しスクリプト (DATA_DESIGN §6)。
// recipes.json (正) の内容を CSV(ユーザー編集用インターフェース)へ反映したいときに使う。
// 実行: npm run recipes:export (= vite-node scripts/recipes-export.ts)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRecipes } from '../src/data/loaders';
import { recipesToCsvText } from '../src/data/recipe-json';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const csvPath = resolve(root, 'data/recipes.csv');

function main(): void {
  const recipes = loadRecipes();
  const csv = recipesToCsvText(recipes);
  writeFileSync(csvPath, csv, 'utf8');
  console.log(`recipes.csv を書き込みました(${recipes.length}件): ${csvPath}`);
}

main();
