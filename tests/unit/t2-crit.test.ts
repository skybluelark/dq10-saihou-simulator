// T2. 会心率 (SPEC §3.4)

import { describe, expect, it } from 'vitest';
import { computeCritRate, type CritContext } from '../../src/core';
import { loadGameParams, loadNeedles } from '../../src/data';
import { NEEDLE_CRIT_TABLE } from '../fixtures/spec-tables';

const params = loadGameParams();

function ctx(over: Partial<CritContext>): CritContext {
  return {
    needleCritRate: 0.02, // 銀★0
    kotsu: false,
    passiveCritUp: false,
    aim: false,
    rainbowCritTurn: false,
    lightGlowCell: false,
    mugaActive: false,
    shiftCrit: false,
    ...over,
  };
}

const EPS = 1e-9;

describe('T2 会心率の各項', () => {
  it('基礎のみ = 針会心率', () => {
    expect(computeCritRate(params, ctx({ needleCritRate: 0.02 }))).toBeCloseTo(0.02, 9);
  });
  it('コツ +1%', () => {
    expect(computeCritRate(params, ctx({ needleCritRate: 0.02, kotsu: true }))).toBeCloseTo(0.03, 9);
  });
  it('パッシブ実効 +0.1%', () => {
    expect(computeCritRate(params, ctx({ needleCritRate: 0.02, passiveCritUp: true }))).toBeCloseTo(0.021, 9);
  });
  it('ねらい倍率 7 は (基礎+コツ+パッシブ) に乗る', () => {
    // (0.02+0.01+0.001)*7 = 0.217
    const r = computeCritRate(params, ctx({ needleCritRate: 0.02, kotsu: true, passiveCritUp: true, aim: true }));
    expect(r).toBeCloseTo((0.02 + 0.01 + 0.001) * 7, 9);
  });
  it('虹布会心ターン +24% は固定値上昇(倍率の後)', () => {
    // (0.02)*1 + 0.24 = 0.26
    expect(computeCritRate(params, ctx({ needleCritRate: 0.02, rainbowCritTurn: true }))).toBeCloseTo(0.26, 9);
  });
  it('光布発光マス +24%', () => {
    expect(computeCritRate(params, ctx({ needleCritRate: 0.02, lightGlowCell: true }))).toBeCloseTo(0.26, 9);
  });
  it('固定値は加算(虹+光の両方=+48%)', () => {
    expect(
      computeCritRate(params, ctx({ needleCritRate: 0.02, rainbowCritTurn: true, lightGlowCell: true })),
    ).toBeCloseTo(0.5, 9);
  });
  it('必殺(無我) ×2', () => {
    expect(computeCritRate(params, ctx({ needleCritRate: 0.02, mugaActive: true }))).toBeCloseTo(0.04, 9);
  });
  it('シフト会心 ×2', () => {
    expect(computeCritRate(params, ctx({ needleCritRate: 0.02, shiftCrit: true }))).toBeCloseTo(0.04, 9);
  });
  it('必殺+シフト併用 ×4', () => {
    expect(
      computeCritRate(params, ctx({ needleCritRate: 0.02, mugaActive: true, shiftCrit: true })),
    ).toBeCloseTo(0.08, 9);
  });
  it('固定値上昇は倍率の内側でなく外(ねらい後に加算)', () => {
    // (0.02*7) + 0.24 = 0.38
    expect(computeCritRate(params, ctx({ needleCritRate: 0.02, aim: true, rainbowCritTurn: true }))).toBeCloseTo(0.38, 9);
  });
  it('必殺補正は固定値上昇後の全体に乗る', () => {
    // ((0.02)+0.24)*2 = 0.52
    expect(
      computeCritRate(params, ctx({ needleCritRate: 0.02, rainbowCritTurn: true, mugaActive: true })),
    ).toBeCloseTo(0.52, 9);
  });
  it('ランダム会心は補正なし(randomCritMultiplier=1)', () => {
    expect(params.crit.randomCritMultiplier).toBe(1);
  });
  void EPS;
});

describe('T2 針テーブルが SPEC と一致', () => {
  const needles = loadNeedles();
  for (const n of needles.needles) {
    it(`${n.id} の★別会心率`, () => {
      expect(n.critRate).toEqual(NEEDLE_CRIT_TABLE[n.id]);
    });
  }
});
