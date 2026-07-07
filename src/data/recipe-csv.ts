// recipes.csv パーサ (DATA_DESIGN §6)
// 純関数: CSV文字列 → RecipeDef[] + エラー/警告(行番号つき)。
// recipes.json がレシピデータの正になったため(ARCHITECTURE A5)、
// このパーサは scripts/recipes-import.ts からの取り込み用インターフェースとして使われる。BOM付きUTF-8対応。

import type {
  Power,
  RecipeCell,
  RecipeDef,
  RecipeParseResult,
  CsvIssue,
} from './types';
import {
  CATEGORY_MAP,
  CLOTH_MAP,
  POWER_MAP,
  CATEGORY_GRID,
  HEAD_SHAPE,
  HEADER,
} from './recipe-schema';

const CELL_START = 6; // cell_r1c1 の列インデックス
const CELL_COUNT = 9;

/** 1行を素朴に分割(このCSVはクオート/エスケープ非対応の固定フォーマット)。 */
function splitLine(line: string): string[] {
  return line.split(',').map((s) => s.trim());
}

/** BOM除去 + 行分割(CRLF/CR/LF対応)。 */
function toLines(csv: string): string[] {
  const stripped = csv.replace(/^\uFEFF/, '');
  return stripped.split(/\r\n|\r|\n/);
}

/**
 * recipes.csv をパースする純関数。
 * 行番号は 1 始まり(ヘッダ行=1)で報告する。
 */
export function parseRecipesCsv(csv: string): RecipeParseResult {
  const errors: CsvIssue[] = [];
  const warnings: CsvIssue[] = [];
  const recipes: RecipeDef[] = [];
  const seenIds = new Set<string>();

  const lines = toLines(csv);
  if (lines.length === 0) {
    return { recipes, errors, warnings };
  }

  // ヘッダ検証(行1)
  const header = splitLine(lines[0]);
  if (header.length < HEADER.length || HEADER.some((h, i) => header[i] !== h)) {
    errors.push({
      line: 1,
      rule: 'HEADER',
      message: `ヘッダが不正です。期待: ${HEADER.join(',')}`,
    });
    return { recipes, errors, warnings };
  }

  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];

    // V8: 空行・全列空はスキップ(警告)。ただし末尾の完全な空行は無警告で無視。
    if (raw.trim() === '') {
      if (i === lines.length - 1) continue; // 末尾改行由来の空行
      warnings.push({ line: lineNo, rule: 'V8', message: '空行をスキップしました。' });
      continue;
    }

    const cols = splitLine(raw);
    if (cols.every((c) => c === '')) {
      warnings.push({ line: lineNo, rule: 'V8', message: '全列が空の行をスキップしました。' });
      continue;
    }

    const rowErrors: CsvIssue[] = [];
    const err = (rule: string, message: string) =>
      rowErrors.push({ line: lineNo, rule, message });

    const id = cols[0] ?? '';
    const name = cols[1] ?? '';
    const categoryRaw = cols[2] ?? '';
    const clothRaw = cols[3] ?? '';
    const rowsRaw = cols[4] ?? '';
    const colsRaw = cols[5] ?? '';
    const powerRaw = cols[15] ?? '';
    const notes = cols[16] ?? '';

    // V1: id 形式 + 一意
    if (!/^[a-z0-9_]+$/.test(id)) {
      err('V1', `id "${id}" は ^[a-z0-9_]+$ に一致しません。`);
    } else if (seenIds.has(id)) {
      err('V1', `id "${id}" が重複しています。`);
    }

    // V2: category / cloth_type が enum に含まれる
    const category = CATEGORY_MAP[categoryRaw];
    if (!category) {
      err('V2', `category "${categoryRaw}" は不正です。`);
    }
    const clothType = CLOTH_MAP[clothRaw];
    if (!clothType) {
      err('V2', `cloth_type "${clothRaw}" は不正です。`);
    }

    const rows = Number(rowsRaw);
    const colsN = Number(colsRaw);

    // V3: rows/cols が category の固定値と一致
    if (category) {
      const grid = CATEGORY_GRID[category];
      if (rows !== grid.rows || colsN !== grid.cols) {
        err(
          'V3',
          `rows/cols (${rowsRaw}×${colsRaw}) が category "${categoryRaw}" の固定値 ${grid.rows}×${grid.cols} と一致しません。`,
        );
      }
    }

    // セル解析(V5: rows×cols 範囲内のみ存在、値は正整数)
    const cells: RecipeCell[] = [];
    let cellCount = 0;
    for (let ci = 0; ci < CELL_COUNT; ci++) {
      const r = Math.floor(ci / 3) + 1; // 1..3
      const c = (ci % 3) + 1; // 1..3
      const v = (cols[CELL_START + ci] ?? '').trim();
      const inGrid = category ? r <= rows && c <= colsN : true;
      if (v === '') {
        continue; // 空欄 = マスなし
      }
      cellCount++;
      if (!inGrid) {
        err('V5', `cell_r${r}c${c} はグリッド範囲外(${rows}×${colsN})に値があります。`);
        continue;
      }
      const num = Number(v);
      if (!Number.isInteger(num) || num <= 0) {
        err('V5', `cell_r${r}c${c} の値 "${v}" は正整数ではありません。`);
        continue;
      }
      cells.push({ r, c, base: num });
    }

    // V6: マス数が category と一致
    if (category) {
      const expected = CATEGORY_GRID[category].cells;
      if (cellCount !== expected) {
        err('V6', `マス数 ${cellCount} が category "${categoryRaw}" の期待値 ${expected} と一致しません。`);
      }
    }

    // V3-shape: 頭は凸形((1,2),(2,1),(2,2),(2,3))のマス位置に完全一致すること
    if (category === 'head') {
      const positions = new Set(cells.map((cell) => `${cell.r},${cell.c}`));
      const matches =
        positions.size === HEAD_SHAPE.size &&
        [...HEAD_SHAPE].every((pos) => positions.has(pos));
      if (!matches) {
        err(
          'V3-shape',
          `頭のマス位置が凸形(1,2)(2,1)(2,2)(2,3)と一致しません(実際: ${[...positions].sort().join('/') || 'なし'})。`,
        );
      }
    }

    // V7: power_order は1トークン以上、トークンは 弱い/普通/強い/最強/？ のみ
    const powerCycle: Power[] = [];
    const tokens = powerRaw === '' ? [] : powerRaw.split('/').map((t) => t.trim());
    if (tokens.length === 0) {
      err('V7', 'power_order にトークンがありません(1トークン以上必要)。');
    } else {
      for (const t of tokens) {
        const p = POWER_MAP[t];
        if (!p) {
          err('V7', `power_order のトークン "${t}" は不正です(弱い/普通/強い/最強/？ のみ)。`);
        } else {
          powerCycle.push(p);
        }
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue; // エラー行は読み込み対象から除外
    }

    // 検証通過: id が重複しないことは V1 で確認済み
    seenIds.add(id);
    recipes.push({
      id,
      name,
      category: category!,
      clothType: clothType!,
      rows,
      cols: colsN,
      cells,
      powerCycle,
      notes: notes || undefined,
    });
  }

  return { recipes, errors, warnings };
}
