// data/recipes.csv → src/data/recipes.json への変換スクリプト (DATA_DESIGN §6)。
// recipes.json がレシピデータの正になったため、CSVはこのスクリプト経由の入力インターフェース。
// 実行: npm run recipes:import (= vite-node scripts/recipes-import.ts)
// エラーがあれば書き込みを行わず、全件表示して exitCode=1 で終了する。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseRecipesCsv } from '../src/data/recipe-csv';
import { recipesToJsonText } from '../src/data/recipe-json';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const csvPath = resolve(root, 'data/recipes.csv');
const jsonPath = resolve(root, 'src/data/recipes.json');

function main(): void {
  const csv = readFileSync(csvPath, 'utf8'); // BOM除去はパーサ側で行う
  const { recipes, errors, warnings } = parseRecipesCsv(csv);

  for (const w of warnings) {
    console.warn(`[warn] L${w.line} ${w.rule}: ${w.message}`);
  }

  if (errors.length > 0) {
    console.error(`recipes.csv に ${errors.length} 件のエラーがあります(書き込みを中止しました):`);
    for (const e of errors) {
      console.error(`  L${e.line} ${e.rule}: ${e.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const json = recipesToJsonText(recipes);
  writeFileSync(jsonPath, json, 'utf8');
  console.log(`recipes.json を書き込みました(${recipes.length}件): ${jsonPath}`);
}

main();
