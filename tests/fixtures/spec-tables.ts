// SPEC §3.2 ダメージテーブルの転記(テスト期待値フィクスチャ)。
// 「仕様書の表 → フィクスチャ → 実装」の三者一致を担保する。

// 縫い(糸ほぐし以外): 特技倍率6種 × パワー4種 × 基礎値7通り(12→18)。
// マス補正1のテーブル値。会心/しつけ/光はテスト側で ×2, ×4 する。

import type { Power } from '../../src/data/types';

// テーブル列に現れるパワー(critx2 は普通と同係数、unknown は解決済み前提のため列なし)
export type TablePower = 'weak' | 'normal' | 'strong' | 'strongest';

// パワー列の順序: 弱い(0.5), 普通・会心×2(1), 強い(1.5), 最強(2)
export const POWER_COLUMNS: TablePower[] = ['weak', 'normal', 'strong', 'strongest'];

// 基礎値の順序: 12,13,14,15,16,17,18
export const BASE_VALUES = [12, 13, 14, 15, 16, 17, 18];

// key = 特技倍率。value = { power: 7値 }
export const SEW_TABLE: Record<number, Record<TablePower, number[]>> = {
  0.5: {
    weak: [3, 4, 4, 4, 4, 5, 5],
    normal: [6, 7, 7, 8, 8, 9, 9],
    strong: [9, 11, 11, 12, 12, 14, 14],
    strongest: [12, 14, 14, 16, 16, 18, 18],
  },
  0.75: {
    weak: [5, 5, 6, 6, 6, 7, 7],
    normal: [9, 10, 11, 12, 12, 13, 14],
    strong: [14, 15, 17, 18, 18, 20, 21],
    strongest: [18, 20, 22, 24, 24, 26, 28],
  },
  1: {
    weak: [6, 7, 7, 8, 8, 9, 9],
    normal: [12, 13, 14, 15, 16, 17, 18],
    strong: [18, 20, 21, 23, 24, 26, 27],
    strongest: [24, 26, 28, 30, 32, 34, 36],
  },
  1.5: {
    weak: [9, 10, 11, 12, 12, 13, 14],
    normal: [18, 20, 21, 23, 24, 26, 27],
    strong: [27, 30, 32, 35, 36, 39, 41],
    strongest: [36, 40, 42, 46, 48, 52, 54],
  },
  2: {
    weak: [12, 13, 14, 15, 16, 17, 18],
    normal: [24, 26, 28, 30, 32, 34, 36],
    strong: [36, 39, 42, 45, 48, 51, 54],
    strongest: [48, 52, 56, 60, 64, 68, 72],
  },
  3: {
    weak: [18, 20, 21, 23, 24, 26, 27],
    normal: [36, 39, 42, 45, 48, 51, 54],
    strong: [54, 59, 63, 68, 72, 77, 81],
    strongest: [72, 78, 84, 90, 96, 102, 108],
  },
};

// 糸ほぐし: パワー4種 × マス補正2種 × 基礎値4通り(|6|→|9|)。
// 値は回復量(ダメージ絶対値)。基礎値順: 6,7,8,9
export const HOGUSHI_BASE_VALUES = [6, 7, 8, 9];

export const HOGUSHI_TABLE: Record<Power, { corr1: number[]; corr2: number[] }> = {
  weak: { corr1: [3, 3, 4, 4], corr2: [6, 7, 8, 9] },
  normal: { corr1: [6, 7, 8, 9], corr2: [12, 14, 16, 18] },
  strong: { corr1: [9, 10, 12, 13], corr2: [18, 21, 24, 27] },
  strongest: { corr1: [12, 14, 16, 18], corr2: [24, 28, 32, 36] },
  critx2: { corr1: [6, 7, 8, 9], corr2: [12, 14, 16, 18] }, // 会心×2 は係数1(普通と同じ)
  unknown: { corr1: [], corr2: [] },
};

// SPEC §3.5 集中力テーブル(Lv1〜80)
export const CONCENTRATION_BASE = [
  50, 51, 54, 56, 58, 61, 62, 65, 68, 68,
  71, 74, 74, 77, 79, 82, 82, 85, 88, 88,
  91, 94, 94, 97, 100, 100, 103, 105, 108, 108,
  111, 112, 112, 114, 118, 121, 122, 122, 124, 128,
  131, 133, 136, 138, 138, 141, 141, 143, 146, 148,
  151, 151, 153, 156, 158, 161, 161, 163, 166, 168,
  170, 170, 172, 174, 176, 179, 181, 183, 185, 187,
  189, 191, 193, 195, 197, 199, 201, 203, 205, 207,
];

// SPEC §3.4 針テーブル(基礎会心率+道具のできのよさ、★0〜★3)
export const NEEDLE_CRIT_TABLE: Record<string, number[]> = {
  copper: [0.010, 0.011, 0.012, 0.020],
  iron: [0.015, 0.016, 0.017, 0.025],
  silver: [0.020, 0.021, 0.022, 0.030],
  platinum: [0.025, 0.026, 0.027, 0.035],
  super: [0.030, 0.031, 0.032, 0.040],
  miracle: [0.033, 0.034, 0.035, 0.043],
  hikari: [0.036, 0.037, 0.038, 0.046],
};

export const NEEDLE_CONCENTRATION: Record<string, number> = {
  copper: 0,
  iron: 10,
  silver: 15,
  platinum: 25,
  super: 35,
  miracle: 50,
  hikari: 45,
};

// SPEC §3.7 評価境界(マス数 → 境界値)
export const EVALUATION_BOUNDARY: Record<number, { star3: number; star2: number; star1: number; star0: number }> = {
  9: { star3: 8, star2: 17, star1: 36, star0: 49 },
  7: { star3: 5, star2: 17, star1: 27, star0: 30 },
  6: { star3: 4, star2: 11, star1: 24, star0: 39 },
  4: { star3: 2, star2: 7, star1: 16, star0: 29 },
};

// SPEC §3.7 評価境界(誤差制限あり。マス数 → 境界値)。7マスは定義なし(通常表にフォールバック)。
export const EVALUATION_RESTRICTED_BOUNDARY: Record<
  number,
  { star3: number; star2: number; star1: number; star0: number }
> = {
  9: { star3: 6, star2: 13, star1: 36, star0: 49 },
  6: { star3: 3, star2: 8, star1: 24, star0: 39 },
  4: { star3: 1, star2: 5, star1: 16, star0: 29 },
};
