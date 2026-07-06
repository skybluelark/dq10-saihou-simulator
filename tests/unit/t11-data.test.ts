// T11. データ検証 (DATA_DESIGN)

import { describe, expect, it } from 'vitest';
import {
  loadGameParams,
  loadNeedles,
  loadSkills,
  loadConcentration,
  parseRecipesCsv,
} from '../../src/data';
import {
  NEEDLE_CRIT_TABLE,
  NEEDLE_CONCENTRATION,
  CONCENTRATION_BASE,
  EVALUATION_BOUNDARY,
} from '../fixtures/spec-tables';
import { realRecipesCsv } from '../fixtures/engine-helpers';

const HEADER =
  'id,name,category,cloth_type,rows,cols,cell_r1c1,cell_r1c2,cell_r1c3,cell_r2c1,cell_r2c2,cell_r2c3,cell_r3c1,cell_r3c2,cell_r3c3,power_order,notes';

function csvWith(rows: string[]): string {
  return [HEADER, ...rows].join('\r\n');
}

// 頭(2行×3列のうち凸形4マス)の位置対応:
// cell_r1c1(空), cell_r1c2, cell_r1c3(空), cell_r2c1, cell_r2c2, cell_r2c3, 残り(r3系)は空
const VALID_ROW = 'hat_a,ぼうしA,頭,通常,2,3,,32,,32,30,32,,,,弱い/普通/強い/最強,';

describe('T11 game-params.json が SPEC と一致', () => {
  const p = loadGameParams();
  it('会心式係数', () => {
    expect(p.crit.kotsuBonus).toBe(0.01);
    expect(p.crit.passiveEffective).toBe(0.001);
    expect(p.crit.aimMultiplier).toBe(7);
    expect(p.crit.hissatsuMultiplier).toBe(2);
    expect(p.crit.shiftCritMultiplier).toBe(2);
    expect(p.crit.randomCritMultiplier).toBe(1);
    expect(p.crit.fixedBonus.rainbowCritTurn).toBe(0.24);
    expect(p.crit.fixedBonus.lightGlowCell).toBe(0.24);
  });
  it('必殺基礎値 0.00233', () => {
    expect(p.hissatsuCharge.baseRate).toBe(0.00233);
  });
  it('布特性(周期5/4・再生回復量12〜16・虹初回半減/1.5倍・光補正2)', () => {
    expect(p.clothTrait.firstTurn).toBe(5);
    expect(p.clothTrait.interval).toBe(4);
    expect(p.clothTrait.regenAmounts).toEqual([12, 13, 14, 15, 16]);
    expect(p.clothTrait.rainbowCostHalfFirst).toBe(true);
    expect(p.clothTrait.rainbowCostUpFactor).toBe(1.5);
    expect(p.clothTrait.lightCellCorrection).toBe(2);
  });
  it('集中力自動回復(閾値10・10%・+30・1回)', () => {
    expect(p.concentrationRecovery).toEqual({ threshold: 10, chance: 0.1, amount: 30, oncePerSession: true });
  });
  it('ゲージ(黄色±4・ペナルティ9)', () => {
    expect(p.gauge).toEqual({ yellowRange: 4, penaltyError: 9 });
  });
  it('評価境界がSPEC §3.7と一致', () => {
    for (const [mass, b] of Object.entries(EVALUATION_BOUNDARY)) {
      expect(p.evaluation[mass]).toEqual(b);
    }
  });
});

describe('T11 needles.json が SPEC と一致', () => {
  const n = loadNeedles();
  it('7種・★4段の会心率と集中度', () => {
    expect(n.needles).toHaveLength(7);
    for (const needle of n.needles) {
      expect(needle.critRate).toEqual(NEEDLE_CRIT_TABLE[needle.id]);
      expect(needle.concentration).toBe(NEEDLE_CONCENTRATION[needle.id]);
    }
  });
});

describe('T11 skills.json の構造', () => {
  const s = loadSkills();
  it('全23特技(パッシブ3+必殺1含む)が存在', () => {
    expect(s.skills).toHaveLength(23);
  });
  it('対象パターン8種が定義済み', () => {
    expect(Object.keys(s.targetPatterns).sort()).toEqual(
      ['col2', 'col3', 'diag_down2', 'diag_up2', 'plus5', 'row2', 'row3', 'single'].sort(),
    );
  });
});

describe('T11 concentration.json', () => {
  const c = loadConcentration();
  it('80要素・Lv80=207・SPEC数表一致', () => {
    expect(c.base).toHaveLength(80);
    expect(c.base[79]).toBe(207);
    expect(c.base).toEqual(CONCENTRATION_BASE);
  });
});

describe('T11 recipes.csv 正常系(実データ9件)', () => {
  const result = parseRecipesCsv(realRecipesCsv());

  it('9件全件ロード・エラーなし', () => {
    expect(result.errors).toEqual([]);
    expect(result.recipes).toHaveLength(9);
  });

  it('ウェディの人形・男: 7マス(r1c1/r1c3欠け)', () => {
    const doll = result.recipes.find((r) => r.id === 'wedi_doll_m')!;
    expect(doll.category).toBe('doll');
    expect(doll.clothType).toBe('rainbow');
    expect(doll.cells).toHaveLength(7);
    expect(doll.cells.find((c) => c.r === 1 && c.c === 1)).toBeUndefined();
    expect(doll.cells.find((c) => c.r === 1 && c.c === 3)).toBeUndefined();
    expect(doll.powerCycle).toEqual(['normal', 'unknown', 'weak', 'strongest']);
  });

  it('賢哲のターバン: 頭2行3列(凸形)・虹・基準値231×4', () => {
    const t = result.recipes.find((r) => r.id === 'kentetsu_turban')!;
    expect(t.category).toBe('head');
    expect(t.clothType).toBe('rainbow');
    expect(t.rows).toBe(2);
    expect(t.cols).toBe(3);
    expect(t.cells.map((c) => ({ r: c.r, c: c.c, base: c.base }))).toEqual([
      { r: 1, c: 2, base: 231 },
      { r: 2, c: 1, base: 231 },
      { r: 2, c: 2, base: 231 },
      { r: 2, c: 3, base: 231 },
    ]);
    expect(t.powerCycle).toEqual(['normal', 'unknown', 'weak', 'unknown', 'strongest']);
  });

  it('ソポスのころも下: 体下3行2列・6マス', () => {
    const s = result.recipes.find((r) => r.id === 'sopos_koromo_shita')!;
    expect(s.rows).toBe(3);
    expect(s.cols).toBe(2);
    expect(s.cells).toHaveLength(6);
  });

  it('大怪傑のグローブ: 腕2行3列・6マス', () => {
    const g = result.recipes.find((r) => r.id === 'daikaiketsu_glove')!;
    expect(g.rows).toBe(2);
    expect(g.cols).toBe(3);
    expect(g.cells).toHaveLength(6);
  });

  it('BOM付きCSVも同一結果', () => {
    const withBom = '\uFEFF' + realRecipesCsv().replace(/^\uFEFF/, '');
    const r2 = parseRecipesCsv(withBom);
    expect(r2.recipes).toEqual(result.recipes);
  });
});

describe('T11 recipes.csv バリデーション異常系 (V1〜V8)', () => {
  it('V1: id形式不正(大文字)', () => {
    const r = parseRecipesCsv(csvWith(['Hat_A,ぼうし,頭,通常,2,3,,32,,32,30,32,,,,弱い/普通,']));
    expect(r.errors.some((e) => e.rule === 'V1' && e.line === 2)).toBe(true);
    expect(r.recipes).toHaveLength(0);
  });

  it('V1: id重複', () => {
    const r = parseRecipesCsv(csvWith([VALID_ROW, VALID_ROW]));
    expect(r.errors.some((e) => e.rule === 'V1' && e.line === 3)).toBe(true);
    expect(r.recipes).toHaveLength(1); // 先勝ち
  });

  it('V2: category不正', () => {
    const r = parseRecipesCsv(csvWith(['hat_b,ぼうし,かぶと,通常,2,3,,32,,32,30,32,,,,弱い/普通,']));
    expect(r.errors.some((e) => e.rule === 'V2' && e.line === 2)).toBe(true);
  });

  it('V2: cloth_type不正', () => {
    const r = parseRecipesCsv(csvWith(['hat_b,ぼうし,頭,金,2,3,,32,,32,30,32,,,,弱い/普通,']));
    expect(r.errors.some((e) => e.rule === 'V2' && e.line === 2)).toBe(true);
  });

  it('V3: rows/colsがcategory固定値と不一致(頭で3×3)', () => {
    const r = parseRecipesCsv(csvWith(['hat_b,ぼうし,頭,通常,3,3,30,32,30,32,50,50,50,50,50,弱い/普通,']));
    expect(r.errors.some((e) => e.rule === 'V3' && e.line === 2)).toBe(true);
  });

  it('V5: グリッド範囲外にセル値(頭2行3列で r3c1 に値)', () => {
    const r = parseRecipesCsv(csvWith(['hat_b,ぼうし,頭,通常,2,3,,32,,32,30,32,99,,,弱い/普通,']));
    expect(r.errors.some((e) => e.rule === 'V5' && e.line === 2)).toBe(true);
  });

  it('V5ではなくV3-shape: 頭のグリッド内欠け位置(r1c1)に値', () => {
    // r1c1 は 2×3 グリッドの範囲内(V5対象外)だが、凸形の欠け位置なので V3-shape で検出する
    const r = parseRecipesCsv(csvWith(['hat_b,ぼうし,頭,通常,2,3,99,32,,32,30,32,,,,弱い/普通,']));
    expect(r.errors.some((e) => e.rule === 'V5')).toBe(false);
    expect(r.errors.some((e) => e.rule === 'V3-shape' && e.line === 2)).toBe(true);
  });

  it('V5: セル値が正整数でない(0・負・小数・文字)', () => {
    for (const bad of ['0', '-5', '3.5', 'abc']) {
      const r = parseRecipesCsv(csvWith([`hat_b,ぼうし,頭,通常,2,3,,${bad},,32,30,32,,,,弱い/普通,`]));
      expect(r.errors.some((e) => e.rule === 'V5' && e.line === 2)).toBe(true);
    }
  });

  it('V6: マス数不一致(頭で3マスのみ)', () => {
    const r = parseRecipesCsv(csvWith(['hat_b,ぼうし,頭,通常,2,3,,32,,32,30,,,,,弱い/普通,']));
    expect(r.errors.some((e) => e.rule === 'V6' && e.line === 2)).toBe(true);
  });

  it('V7: power_order空', () => {
    const r = parseRecipesCsv(csvWith(['hat_b,ぼうし,頭,通常,2,3,,32,,32,30,32,,,,,']));
    expect(r.errors.some((e) => e.rule === 'V7' && e.line === 2)).toBe(true);
  });

  it('V7: 不正トークン(会心×2 はサイクル不可)', () => {
    const r = parseRecipesCsv(csvWith(['hat_b,ぼうし,頭,通常,2,3,,32,,32,30,32,,,,弱い/会心×2,']));
    expect(r.errors.some((e) => e.rule === 'V7' && e.line === 2)).toBe(true);
  });

  it('V3-shape: 頭のマス位置が凸形と不一致(2×2詰め配置)', () => {
    // rows=2,cols=3 だが値が旧2×2詰め位置(r1c1,r1c2,r2c1,r2c2)にある = 凸形と不一致
    const r = parseRecipesCsv(csvWith(['hat_b,ぼうし,頭,通常,2,3,30,32,,32,30,,,,,弱い/普通,']));
    expect(r.errors.some((e) => e.rule === 'V3-shape' && e.line === 2)).toBe(true);
  });

  it('V3-shape: 頭の凸形が正しい配置は通る', () => {
    const r = parseRecipesCsv(csvWith(['hat_b,ぼうし,頭,通常,2,3,,32,,32,30,32,,,,弱い/普通,']));
    expect(r.errors).toEqual([]);
    expect(r.recipes).toHaveLength(1);
    expect(r.recipes[0].cells.map((c) => `${c.r},${c.c}`).sort()).toEqual(['1,2', '2,1', '2,2', '2,3']);
  });

  it('V8: 空行・全列空はスキップ(警告・行番号つき)', () => {
    const r = parseRecipesCsv(csvWith([VALID_ROW, '', ',,,,,,,,,,,,,,,,', VALID_ROW.replace('hat_a', 'hat_b')]));
    expect(r.warnings.some((w) => w.rule === 'V8' && w.line === 3)).toBe(true);
    expect(r.warnings.some((w) => w.rule === 'V8' && w.line === 4)).toBe(true);
    expect(r.recipes).toHaveLength(2);
    expect(r.errors).toEqual([]);
  });

  it('エラー行は除外され、正常行は読み込まれる', () => {
    const r = parseRecipesCsv(
      csvWith([VALID_ROW, 'BAD_ID,x,頭,通常,2,3,,32,,32,30,32,,,,弱い,', VALID_ROW.replace('hat_a', 'hat_c')]),
    );
    expect(r.recipes.map((x) => x.id)).toEqual(['hat_a', 'hat_c']);
    expect(r.errors.some((e) => e.line === 3)).toBe(true);
  });

  it('ヘッダ不正は全体エラー', () => {
    const r = parseRecipesCsv('foo,bar\n' + VALID_ROW);
    expect(r.errors.some((e) => e.rule === 'HEADER' && e.line === 1)).toBe(true);
    expect(r.recipes).toHaveLength(0);
  });
});
