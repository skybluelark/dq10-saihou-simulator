// recipes.json 検証(正)と recipes.csv 入出力(インターフェース)の純関数群 (DATA_DESIGN §6)。
// recipes.json がレシピデータの正になったため(ビルド時バンドル)、CSVはこのファイルの
// recipesToCsvText / recipe-csv.ts の parseRecipesCsv を介した入出力インターフェースとして扱う。

import type { Category, ClothType, Power, RecipeCell, RecipeDef } from './types';
import { CATEGORY_GRID, CATEGORY_TOKEN, CLOTH_MAP, CLOTH_TOKEN, HEAD_SHAPE, HEADER, POWER_TOKEN } from './recipe-schema';

export class DataValidationError extends Error {}

const CATEGORY_VALUES: ReadonlySet<Category> = new Set(
  Object.keys(CATEGORY_GRID) as Category[],
);
const CLOTH_VALUES: ReadonlySet<ClothType> = new Set(Object.values(CLOTH_MAP));
const ALLOWED_POWERS: ReadonlySet<Power> = new Set([
  'weak',
  'normal',
  'strong',
  'strongest',
  'unknown',
]);

/**
 * recipes.json の生データを検証し、RecipeDef[] へ変換する。
 * 違反は部分スキップせず全件収集し、1件でもあれば DataValidationError を throw する
 * (メッセージは違反全件を改行連結)。
 */
export function validateRecipesJson(raw: unknown): RecipeDef[] {
  const violations: string[] = [];

  if (typeof raw !== 'object' || raw === null) {
    throw new DataValidationError('recipes.json: ルートがオブジェクトではありません。');
  }
  const obj = raw as { version?: unknown; recipes?: unknown };

  if (obj.version !== '1.0') {
    violations.push(`recipes.json: version が "1.0" ではありません(実際: ${JSON.stringify(obj.version)})。`);
  }

  if (!Array.isArray(obj.recipes)) {
    violations.push('recipes.json: recipes が配列ではありません。');
    throw new DataValidationError(violations.join('\n'));
  }

  const list = obj.recipes as unknown[];
  const recipes: RecipeDef[] = [];
  const seenIds = new Set<string>();

  list.forEach((entry, index) => {
    const errs: string[] = [];
    let label = `index=${index}`;
    const err = (msg: string) => errs.push(`recipes[${index}] (${label}): ${msg}`);

    if (typeof entry !== 'object' || entry === null) {
      violations.push(`recipes[${index}]: オブジェクトではありません。`);
      return;
    }
    const e = entry as Record<string, unknown>;

    const idRaw = e.id;
    if (typeof idRaw === 'string' && idRaw !== '') {
      label = idRaw;
    }

    // id: ^[a-z0-9_]+$ かつ一意
    if (typeof idRaw !== 'string' || !/^[a-z0-9_]+$/.test(idRaw)) {
      err(`id "${String(idRaw)}" は ^[a-z0-9_]+$ に一致しません。`);
    } else if (seenIds.has(idRaw)) {
      err(`id "${idRaw}" が重複しています。`);
    } else {
      seenIds.add(idRaw);
    }
    const id = typeof idRaw === 'string' ? idRaw : '';

    // name: 非空文字列
    const nameRaw = e.name;
    if (typeof nameRaw !== 'string' || nameRaw === '') {
      err('name は非空文字列である必要があります。');
    }
    const name = typeof nameRaw === 'string' ? nameRaw : '';

    // category: enum
    const categoryRaw = e.category;
    const category =
      typeof categoryRaw === 'string' && CATEGORY_VALUES.has(categoryRaw as Category)
        ? (categoryRaw as Category)
        : undefined;
    if (!category) {
      err(`category "${String(categoryRaw)}" は不正です。`);
    }

    // clothType: enum
    const clothRaw = e.clothType;
    const clothType =
      typeof clothRaw === 'string' && CLOTH_VALUES.has(clothRaw as ClothType)
        ? (clothRaw as ClothType)
        : undefined;
    if (!clothType) {
      err(`clothType "${String(clothRaw)}" は不正です。`);
    }

    // cells: category の固定グリッド範囲・マス数・(頭は)凸形・(r,c)昇順
    const cellsRaw = e.cells;
    const cells: RecipeCell[] = [];
    if (!Array.isArray(cellsRaw)) {
      err('cells が配列ではありません。');
    } else if (category) {
      const grid = CATEGORY_GRID[category];
      let prev: { r: number; c: number } | null = null;
      let orderOk = true;
      cellsRaw.forEach((cellRaw, ci) => {
        if (typeof cellRaw !== 'object' || cellRaw === null) {
          err(`cells[${ci}] がオブジェクトではありません。`);
          return;
        }
        const cell = cellRaw as Record<string, unknown>;
        const r = cell.r;
        const c = cell.c;
        const base = cell.base;
        const rOk = typeof r === 'number' && Number.isInteger(r) && r >= 1 && r <= grid.rows;
        const cOk = typeof c === 'number' && Number.isInteger(c) && c >= 1 && c <= grid.cols;
        const baseOk = typeof base === 'number' && Number.isInteger(base) && base > 0;
        if (!rOk || !cOk) {
          err(`cells[${ci}] の r,c (${String(r)},${String(c)}) がグリッド範囲(${grid.rows}×${grid.cols})外です。`);
        }
        if (!baseOk) {
          err(`cells[${ci}] の base "${String(base)}" は正整数ではありません。`);
        }
        if (rOk && cOk) {
          if (prev && (r < prev.r || (r === prev.r && c < prev.c))) {
            orderOk = false;
          }
          prev = { r: r as number, c: c as number };
        }
        if (rOk && cOk && baseOk) {
          cells.push({ r: r as number, c: c as number, base: base as number });
        }
      });
      if (!orderOk) {
        err('cells が (r,c) 昇順(r優先)で並んでいません。');
      }
      if (cells.length !== cellsRaw.length) {
        // 個別マスのエラーは上で報告済み(マス数チェックは有効なマスのみで行うと二重に紛らわしいため省略)
      } else if (cells.length !== grid.cells) {
        err(`マス数 ${cells.length} が category "${category}" の期待値 ${grid.cells} と一致しません。`);
      }
      if (category === 'head' && cells.length === cellsRaw.length) {
        const positions = new Set(cells.map((cell) => `${cell.r},${cell.c}`));
        const matches =
          positions.size === HEAD_SHAPE.size && [...HEAD_SHAPE].every((pos) => positions.has(pos));
        if (!matches) {
          err(
            `頭のマス位置が凸形(1,2)(2,1)(2,2)(2,3)と一致しません(実際: ${[...positions].sort().join('/') || 'なし'})。`,
          );
        }
      }
    }

    // powerCycle: 1要素以上、critx2 不可
    const powerCycleRaw = e.powerCycle;
    const powerCycle: Power[] = [];
    if (!Array.isArray(powerCycleRaw) || powerCycleRaw.length === 0) {
      err('powerCycle は1要素以上の配列である必要があります。');
    } else {
      powerCycleRaw.forEach((p, pi) => {
        if (typeof p !== 'string' || !ALLOWED_POWERS.has(p as Power)) {
          err(`powerCycle[${pi}] "${String(p)}" は不正です(weak/normal/strong/strongest/unknown のみ)。`);
        } else {
          powerCycle.push(p as Power);
        }
      });
    }

    // notes: 省略可、あれば文字列
    const notesRaw = e.notes;
    if (notesRaw !== undefined && typeof notesRaw !== 'string') {
      err('notes は文字列である必要があります。');
    }

    if (errs.length > 0) {
      violations.push(...errs);
      return;
    }

    const grid = CATEGORY_GRID[category!];
    recipes.push({
      id,
      name,
      category: category!,
      clothType: clothType!,
      rows: grid.rows,
      cols: grid.cols,
      cells,
      powerCycle,
      notes: typeof notesRaw === 'string' ? notesRaw : undefined,
    });
  });

  if (violations.length > 0) {
    throw new DataValidationError(violations.join('\n'));
  }

  return recipes;
}

/** RecipeDef[] を recipes.json のテキスト表現へ整形する(2スペースインデント・末尾改行あり)。 */
export function recipesToJsonText(recipes: RecipeDef[]): string {
  const json = {
    version: '1.0',
    recipes: recipes.map((r) => {
      const out: Record<string, unknown> = {
        id: r.id,
        name: r.name,
        category: r.category,
        clothType: r.clothType,
        cells: r.cells.map((cell) => ({ r: cell.r, c: cell.c, base: cell.base })),
        powerCycle: r.powerCycle,
      };
      if (r.notes !== undefined) {
        out.notes = r.notes;
      }
      return out;
    }),
  };
  return JSON.stringify(json, null, 2) + '\n';
}

// ---- CSV 書き出し(既存フォーマット。data/recipes.csv 互換) ----

const CELL_POSITIONS: Array<{ r: number; c: number }> = [
  { r: 1, c: 1 },
  { r: 1, c: 2 },
  { r: 1, c: 3 },
  { r: 2, c: 1 },
  { r: 2, c: 2 },
  { r: 2, c: 3 },
  { r: 3, c: 1 },
  { r: 3, c: 2 },
  { r: 3, c: 3 },
];

function recipeToCsvRow(r: RecipeDef): string {
  const cellByPos = new Map(r.cells.map((cell) => [`${cell.r},${cell.c}`, cell.base]));
  const cellCols = CELL_POSITIONS.map((pos) => {
    const base = cellByPos.get(`${pos.r},${pos.c}`);
    return base === undefined ? '' : String(base);
  });
  const cols = [
    r.id,
    r.name,
    CATEGORY_TOKEN[r.category],
    CLOTH_TOKEN[r.clothType],
    String(r.rows),
    String(r.cols),
    ...cellCols,
    r.powerCycle.map((p) => POWER_TOKEN[p]).join('/'),
    r.notes ?? '',
  ];
  return cols.join(',');
}

/** RecipeDef[] を recipes.csv のテキスト表現へ整形する(BOM付き・CRLF・末尾改行あり)。 */
export function recipesToCsvText(recipes: RecipeDef[]): string {
  const BOM = '\uFEFF';
  const lines = [HEADER.join(','), ...recipes.map(recipeToCsvRow)];
  return BOM + lines.join('\r\n') + '\r\n';
}
