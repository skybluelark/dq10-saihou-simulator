// ソルバー基盤モジュール2: 1手の結果分布 (sewCellPmf / hogushiCellPmf / actionDistribution) のテスト
//
// 核となる検証: RNGスタブで全分岐を列挙し、applyAction の実結果と PMF が一致すること。

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Engine, type GameState, type SimulatorConfig } from '../../src/core';
import {
  actionDistribution,
  enumerateCandidates,
  hogushiCellPmf,
  sewCellPmf,
  type CellPmf,
} from '../../src/stats';
import { buildEngine, ScriptedRng, baseValueRoll, hogushiRoll, CRIT_YES, CRIT_NO } from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

const BV_RANGE = [12, 13, 14, 15, 16, 17, 18];

/** 単一マスの盤面。ターン開始処理済み・必殺使用済み(乱数非消費)に固定する。 */
function singleCellState(
  engine: Engine,
  base: number,
  cumulative: number,
  currentPower: GameState['currentPower'] = 'normal',
): GameState {
  return engine.createStateFromSnapshot({
    recipeId: 'solver-dist',
    category: 'test',
    rows: 1,
    cols: 1,
    cells: [{ r: 1, c: 1, base, cumulative, shitsuke: false }],
    powerCycle: ['normal'],
    concentration: 207,
    turnStarted: true,
    currentPower,
    hissatsuUsed: true,
  });
}

/** 期待マップ(remaining→確率)と実際のPMFが一致することを検証する。 */
function expectPmfMatches(actual: CellPmf, expected: Map<number, number>) {
  const actualMap = new Map(actual.map((p) => [p.remaining, p.prob]));
  expect(actualMap.size).toBe(expected.size);
  for (const [remaining, prob] of expected) {
    expect(actualMap.has(remaining)).toBe(true);
    expect(actualMap.get(remaining)!).toBeCloseTo(prob, 9);
  }
}

function pmfSum(pmf: CellPmf): number {
  return pmf.reduce((acc, p) => acc + p.prob, 0);
}

describe('sewCellPmf: applyAction 全分岐との一致', () => {
  it('残り>0のマス(base=30): 基礎値12〜18×会心yes/noの14分岐がPMFと一致', () => {
    const engine = buildEngine();
    const state = singleCellState(engine, 30, 0, 'normal');
    const cell = state.cells[0];
    const p = engine.critRate(state, cell, config, false);

    const expected = new Map<number, number>();
    for (const bv of BV_RANGE) {
      for (const crit of [true, false]) {
        const rng = new ScriptedRng([baseValueRoll(bv), crit ? CRIT_YES : CRIT_NO]);
        const { state: s2 } = engine.applyAction(
          state,
          { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
          config,
          rng,
        );
        const remaining = s2.cells[0].base - s2.cells[0].cumulative;
        const prob = (1 / 7) * (crit ? p : 1 - p);
        expected.set(remaining, (expected.get(remaining) ?? 0) + prob);
      }
    }

    const pmf = sewCellPmf(engine, state, cell, 1, config, false);
    expectPmfMatches(pmf, expected);
    expect(pmfSum(pmf)).toBeCloseTo(1, 9);
  });

  it('会心頭打ち(base=10): 会心時に残りちょうど0で止まる分岐がPMFに反映される', () => {
    const engine = buildEngine();
    const state = singleCellState(engine, 10, 0, 'normal');
    const cell = state.cells[0];
    const p = engine.critRate(state, cell, config, false);

    const expected = new Map<number, number>();
    for (const bv of BV_RANGE) {
      for (const crit of [true, false]) {
        const rng = new ScriptedRng([baseValueRoll(bv), crit ? CRIT_YES : CRIT_NO]);
        const { state: s2 } = engine.applyAction(
          state,
          { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
          config,
          rng,
        );
        const remaining = s2.cells[0].base - s2.cells[0].cumulative;
        const prob = (1 / 7) * (crit ? p : 1 - p);
        expected.set(remaining, (expected.get(remaining) ?? 0) + prob);
      }
    }

    // bv=18・会心なら damage0=18, 2倍=36 > remainingBefore(10) → 頭打ちで残り0
    expect(expected.has(0)).toBe(true);

    const pmf = sewCellPmf(engine, state, cell, 1, config, false);
    expectPmfMatches(pmf, expected);
    expect(pmfSum(pmf)).toBeCloseTo(1, 9);
  });

  it('残り≤0のマス: 会心分岐がなく7点のみ(乱数消費は1回)', () => {
    const engine = buildEngine();
    const state = singleCellState(engine, 10, 15, 'normal'); // remainingBefore = -5
    const cell = state.cells[0];

    const expected = new Map<number, number>();
    for (const bv of BV_RANGE) {
      const rng = new ScriptedRng([baseValueRoll(bv)]); // 基礎値ロールのみ
      const { state: s2 } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      expect(rng.consumed()).toBe(1); // 会心判定は行われない
      const remaining = s2.cells[0].base - s2.cells[0].cumulative;
      expected.set(remaining, (expected.get(remaining) ?? 0) + 1 / 7);
    }

    const pmf = sewCellPmf(engine, state, cell, 1, config, false);
    expect(pmf).toHaveLength(7);
    expectPmfMatches(pmf, expected);
    expect(pmfSum(pmf)).toBeCloseTo(1, 9);
  });

  it('ぬいパワー=weak(弱)でもapplyActionと一致', () => {
    const engine = buildEngine();
    const state = singleCellState(engine, 40, 0, 'weak');
    const cell = state.cells[0];
    const p = engine.critRate(state, cell, config, false);

    const expected = new Map<number, number>();
    for (const bv of BV_RANGE) {
      for (const crit of [true, false]) {
        const rng = new ScriptedRng([baseValueRoll(bv), crit ? CRIT_YES : CRIT_NO]);
        const { state: s2 } = engine.applyAction(
          state,
          { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
          config,
          rng,
        );
        const remaining = s2.cells[0].base - s2.cells[0].cumulative;
        const prob = (1 / 7) * (crit ? p : 1 - p);
        expected.set(remaining, (expected.get(remaining) ?? 0) + prob);
      }
    }

    const pmf = sewCellPmf(engine, state, cell, 1, config, false);
    expectPmfMatches(pmf, expected);
    expect(pmfSum(pmf)).toBeCloseTo(1, 9);
  });

  it('ぬいパワー=strongest(最強)でもapplyActionと一致', () => {
    const engine = buildEngine();
    const state = singleCellState(engine, 80, 0, 'strongest');
    const cell = state.cells[0];
    const p = engine.critRate(state, cell, config, false);

    const expected = new Map<number, number>();
    for (const bv of BV_RANGE) {
      for (const crit of [true, false]) {
        const rng = new ScriptedRng([baseValueRoll(bv), crit ? CRIT_YES : CRIT_NO]);
        const { state: s2 } = engine.applyAction(
          state,
          { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
          config,
          rng,
        );
        const remaining = s2.cells[0].base - s2.cells[0].cumulative;
        const prob = (1 / 7) * (crit ? p : 1 - p);
        expected.set(remaining, (expected.get(remaining) ?? 0) + prob);
      }
    }

    const pmf = sewCellPmf(engine, state, cell, 1, config, false);
    expectPmfMatches(pmf, expected);
    expect(pmfSum(pmf)).toBeCloseTo(1, 9);
  });

  it('ねらいぬい(aim=true): 会心率がねらいなしと異なり、applyActionと一致', () => {
    const engine = buildEngine();
    const state = singleCellState(engine, 40, 0, 'normal');
    const cell = state.cells[0];
    const pAim = engine.critRate(state, cell, config, true);
    const pNoAim = engine.critRate(state, cell, config, false);
    expect(pAim).not.toBeCloseTo(pNoAim, 5); // ねらいぬいで会心率が変わることを確認

    const expected = new Map<number, number>();
    for (const bv of BV_RANGE) {
      for (const crit of [true, false]) {
        const rng = new ScriptedRng([baseValueRoll(bv), crit ? CRIT_YES : CRIT_NO]);
        const { state: s2 } = engine.applyAction(
          state,
          { type: 'sew', skillId: 'nerai_nui', anchor: { r: 1, c: 1 } },
          config,
          rng,
        );
        const remaining = s2.cells[0].base - s2.cells[0].cumulative;
        const prob = (1 / 7) * (crit ? pAim : 1 - pAim);
        expected.set(remaining, (expected.get(remaining) ?? 0) + prob);
      }
    }

    const pmf = sewCellPmf(engine, state, cell, 1, config, true);
    expectPmfMatches(pmf, expected);
    expect(pmfSum(pmf)).toBeCloseTo(1, 9);
  });
});

describe('hogushiCellPmf: applyAction 全分岐との一致', () => {
  it('通常回復(cumulative=20): 出目6〜9の4分岐が一致(乱数消費は1回)', () => {
    const engine = buildEngine();
    const state = singleCellState(engine, 999, 20, 'normal');
    const cell = state.cells[0];

    const expected = new Map<number, number>();
    for (const roll of [6, 7, 8, 9]) {
      const rng = new ScriptedRng([hogushiRoll(roll)]);
      const { state: s2 } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'ito_hogushi', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      expect(rng.consumed()).toBe(1);
      const remaining = s2.cells[0].base - s2.cells[0].cumulative;
      expected.set(remaining, (expected.get(remaining) ?? 0) + 1 / 4);
    }

    const pmf = hogushiCellPmf(engine, state, cell);
    expectPmfMatches(pmf, expected);
    expect(pmfSum(pmf)).toBeCloseTo(1, 9);
  });

  it('初期状態頭打ち(cumulative=3): 一部の出目が累積0で止まる分岐が一致', () => {
    const engine = buildEngine();
    const state = singleCellState(engine, 999, 3, 'normal');
    const cell = state.cells[0];

    const expected = new Map<number, number>();
    for (const roll of [6, 7, 8, 9]) {
      const rng = new ScriptedRng([hogushiRoll(roll)]);
      const { state: s2 } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'ito_hogushi', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      expect(rng.consumed()).toBe(1);
      const remaining = s2.cells[0].base - s2.cells[0].cumulative;
      expected.set(remaining, (expected.get(remaining) ?? 0) + 1 / 4);
    }

    // cumulative=3のため、出目6以上の回復量はすべて頭打ち(累積0)される
    expect(expected.size).toBe(1);
    expect(expected.has(999)).toBe(true); // base - 0

    const pmf = hogushiCellPmf(engine, state, cell);
    expectPmfMatches(pmf, expected);
    expect(pmfSum(pmf)).toBeCloseTo(1, 9);
  });
});

describe('actionDistribution: パイプライン統合', () => {
  it('候補列挙→分布計算がsewCellPmf単体呼び出しと一致する', () => {
    const engine = buildEngine();
    const state = singleCellState(engine, 30, 0, 'normal');
    const candidates = enumerateCandidates(engine, state, config);
    const nuu = candidates.find((c) => c.skillId === 'nuu')!;
    expect(nuu).toBeDefined();

    const dist = actionDistribution(engine, state, config, nuu);
    expect(dist.cells).toHaveLength(1);
    const expectedPmf = sewCellPmf(engine, state, state.cells[0], 1, config, false);
    expectPmfMatches(dist.cells[0].pmf, new Map(expectedPmf.map((p) => [p.remaining, p.prob])));
  });

  it('support(精神統一)・finish は分布なし(cells: [])', () => {
    const engine = buildEngine();
    const state = singleCellState(engine, 30, 0, 'normal');
    const candidates = enumerateCandidates(engine, state, config);

    const finish = candidates.find((c) => c.skillId === null)!;
    expect(actionDistribution(engine, state, config, finish)).toEqual({ cells: [] });

    const seishin = candidates.find((c) => c.skillId === 'seishin_toitsu')!;
    expect(actionDistribution(engine, state, config, seishin)).toEqual({ cells: [] });
  });
});

describe('actionDistribution: みだれぬいの周辺分布近似', () => {
  it('無変化確率=1-4/n、4倍率の混合確率の合計=4/n(2×3の6マス盤面)', () => {
    const engine = buildEngine();
    const cells = [];
    for (let r = 1; r <= 2; r++) {
      for (let c = 1; c <= 3; c++) {
        cells.push({ r, c, base: 1000, cumulative: 0, shitsuke: false });
      }
    }
    const state = engine.createStateFromSnapshot({
      recipeId: 'solver-dist-midare',
      category: 'test',
      rows: 2,
      cols: 3,
      cells,
      powerCycle: ['normal'],
      concentration: 207,
      turnStarted: true,
      currentPower: 'normal',
      hissatsuUsed: true,
    });
    const n = state.cells.length; // 6

    const candidates = enumerateCandidates(engine, state, config);
    const midare = candidates.find((c) => c.skillId === 'midare_nui')!;
    expect(midare).toBeDefined();
    expect(midare.targetCells).toEqual([]);

    const dist = actionDistribution(engine, state, config, midare);
    expect(dist.cells).toHaveLength(n);

    for (const cellDist of dist.cells) {
      const remainingBefore = 1000; // base=1000, cumulative=0
      const noChangeEntry = cellDist.pmf.find((p) => p.remaining === remainingBefore);
      expect(noChangeEntry?.prob).toBeCloseTo(1 - 4 / n, 9);

      const changedMass = cellDist.pmf
        .filter((p) => p.remaining !== remainingBefore)
        .reduce((acc, p) => acc + p.prob, 0);
      expect(changedMass).toBeCloseTo(4 / n, 9);

      expect(pmfSum(cellDist.pmf)).toBeCloseTo(1, 9);
    }
  });
});
