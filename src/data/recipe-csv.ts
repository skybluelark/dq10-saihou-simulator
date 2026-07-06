// recipes.csv パーサ (DATA_DESIGN §6)
// 純関数: CSV文字列 → RecipeDef[] + エラー/警告(行番号つき)。
// fetch には依存しない(DataProvider 側で分離)。BOM付きUTF-8対応。

import type {
  Category,
  ClothType,
  Power,
  RecipeCell,
  RecipeDef,
  RecipeParseResult,
  CsvIssue,
} from './types';

// ---- 対訳表(CSV日本語トークン → enum) ----

const CATEGORY_MAP: Record<string, Category> = {
  頭: 'head',
  体上: 'body_upper',
  体下: 'body_lower',
  腕: 'arm',
  足: 'leg',
  ぬいぐるみ: 'doll',
  ラグ: 'rug',
};

const CLOTH_MAP: Record<string, ClothType> = {
  通常: 'normal',
  再生: 'regen',
  虹: 'rainbow',
  光: 'light',
};

// power_order トークン(会心×2は不可: V7)
const POWER_MAP: Record<string, Power> = {
  弱い: 'weak',
  普通: 'normal',
  強い: 'strong',
  最強: 'strongest',
  '？': 'unknown',
};

// category → 固定の rows/cols とマス数(V3, V6)
// 頭は 2行×3列のうち4マス(凸形)。cells は固定位置集合(V3-shape)で検証する。
const CATEGORY_GRID: Record<Category, { rows: number; cols: number; cells: number }> = {
  head: { rows: 2, cols: 3, cells: 4 },
  leg: { rows: 2, cols: 2, cells: 4 },
  body_upper: { rows: 3, cols: 3, cells: 9 },
  body_lower: { rows: 3, cols: 2, cells: 6 },
  arm: { rows: 2, cols: 3, cells: 6 },
  rug: { rows: 2, cols: 3, cells: 6 },
  doll: { rows: 3, cols: 3, cells: 7 },
};

// 頭の固定形状(凸形): (1,2),(2,1),(2,2),(2,3) の4マスに完全一致すること(V3-shape)。
const HEAD_SHAPE: ReadonlySet<string> = new Set(['1,2', '2,1', '2,2', '2,3']);

const HEADER = [
  'id',
  'name',
  'category',
  'cloth_type',
  'rows',
  'cols',
  'cell_r1c1',
  'cell_r1c2',
  'cell_r1c3',
  'cell_r2c1',
  'cell_r2c2',
  'cell_r2c3',
  'cell_r3c1',
  'cell_r3c2',
  'cell_r3c3',
  'power_order',
  'notes',
];

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
