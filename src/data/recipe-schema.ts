// レシピ CSV/JSON 共通語彙 (DATA_DESIGN §6)。
// enum ⇔ 日本語トークンの対訳表と、レシピの固定グリッド形状定義。
// recipe-csv.ts (CSV→内部モデル) と recipe-json.ts (JSON検証・CSV書き出し) の双方から参照する。

import type { Category, ClothType, Power } from './types';

// ---- 対訳表(CSV日本語トークン → enum) ----

export const CATEGORY_MAP: Record<string, Category> = {
  頭: 'head',
  体上: 'body_upper',
  体下: 'body_lower',
  腕: 'arm',
  足: 'leg',
  ぬいぐるみ: 'doll',
  ラグ: 'rug',
};

export const CLOTH_MAP: Record<string, ClothType> = {
  通常: 'normal',
  再生: 'regen',
  虹: 'rainbow',
  光: 'light',
};

// power_order トークン(会心×2は不可: V7)
export const POWER_MAP: Record<string, Power> = {
  弱い: 'weak',
  普通: 'normal',
  強い: 'strong',
  最強: 'strongest',
  '？': 'unknown',
};

// ---- 逆引き表(enum → 日本語トークン。CSV書き出し用) ----

function invert<K extends string>(map: Record<string, K>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const [token, value] of Object.entries(map)) {
    out[value] = token;
  }
  return out;
}

export const CATEGORY_TOKEN: Record<Category, string> = invert(CATEGORY_MAP);
export const CLOTH_TOKEN: Record<ClothType, string> = invert(CLOTH_MAP);
// critx2 は静的レシピデータには現れない(実行時にのみ？→会心×2として解決される)が、
// Power の全域を尽くすため対訳を用意しておく(format.ts の表示名と揃える)。
export const POWER_TOKEN: Record<Power, string> = {
  ...invert(POWER_MAP),
  critx2: '会心×2',
};

// category → 固定の rows/cols とマス数(V3, V6)
// 頭は 2行×3列のうち4マス(凸形)。cells は固定位置集合(V3-shape)で検証する。
export const CATEGORY_GRID: Record<Category, { rows: number; cols: number; cells: number }> = {
  head: { rows: 2, cols: 3, cells: 4 },
  leg: { rows: 2, cols: 2, cells: 4 },
  body_upper: { rows: 3, cols: 3, cells: 9 },
  body_lower: { rows: 3, cols: 2, cells: 6 },
  arm: { rows: 2, cols: 3, cells: 6 },
  rug: { rows: 2, cols: 3, cells: 6 },
  doll: { rows: 3, cols: 3, cells: 7 },
};

// 頭の固定形状(凸形): (1,2),(2,1),(2,2),(2,3) の4マスに完全一致すること(V3-shape)。
export const HEAD_SHAPE: ReadonlySet<string> = new Set(['1,2', '2,1', '2,2', '2,3']);

export const HEADER = [
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
