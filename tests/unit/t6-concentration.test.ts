// T6. 集中力 (SPEC §3.5)

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SimulatorConfig } from '../../src/core';
import { loadConcentration } from '../../src/data';
import {
  buildEngine,
  ScriptedRng,
  baseValueRoll,
  CRIT_NO,
  HISSATSU_NO,
  singleCellRecipe,
} from '../fixtures/engine-helpers';
import { CONCENTRATION_BASE } from '../fixtures/spec-tables';

describe('T6 開始集中力', () => {
  it('Lv80基礎207 + 銅0 = 207', () => {
    const engine = buildEngine();
    const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };
    const { state } = engine.createSession(singleCellRecipe(100), config, new ScriptedRng([]));
    expect(state.concentration).toBe(207);
  });

  it('Lv80基礎207 + 銀15 = 222', () => {
    const engine = buildEngine();
    const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'silver', stars: 0 } };
    const { state } = engine.createSession(singleCellRecipe(100), config, new ScriptedRng([]));
    expect(state.concentration).toBe(222);
  });

  it('奇跡針: 開幕30%判定で+30(発動時 207+50+30=287)', () => {
    const engine = buildEngine();
    const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'miracle', stars: 0 } };
    // 開幕ロール: x<0.3 で発動。x=0.0 → 発動
    const { state } = engine.createSession(singleCellRecipe(100), config, new ScriptedRng([0.0]));
    expect(state.concentration).toBe(207 + 50 + 30);
  });

  it('奇跡針: 開幕不発(x=0.5)なら +30なし(207+50=257)', () => {
    const engine = buildEngine();
    const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'miracle', stars: 0 } };
    const { state } = engine.createSession(singleCellRecipe(100), config, new ScriptedRng([0.5]));
    expect(state.concentration).toBe(207 + 50);
  });
});

describe('T6 集中力テーブル', () => {
  const c = loadConcentration();
  it('80要素', () => {
    expect(c.base).toHaveLength(80);
  });
  it('Lv80=207', () => {
    expect(c.base[79]).toBe(207);
  });
  it('SPEC の数表と全一致', () => {
    expect(c.base).toEqual(CONCENTRATION_BASE);
  });
});

// 2×2=4マスのスナップショット用セル(judge の評価境界はマス数4/6/7/9のみ定義)
function fourCells(base: number) {
  return [
    { r: 1, c: 1, base, cumulative: 0, shitsuke: false },
    { r: 1, c: 2, base, cumulative: 0, shitsuke: false },
    { r: 2, c: 1, base, cumulative: 0, shitsuke: false },
    { r: 2, c: 2, base, cumulative: 0, shitsuke: false },
  ];
}

describe('T6 不足時の挙動', () => {
  it('コスト超の特技は使用不可(集中力据え置き・ターン非消費)', () => {
    const engine = buildEngine();
    const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };
    // 集中力5に設定(4マス)。ぬう(5)は可、ヨコ(8)は不可
    const state = engine.createStateFromSnapshot({
      recipeId: 'x',
      category: 'head',
      rows: 2,
      cols: 2,
      cells: fourCells(100),
      powerCycle: ['normal'],
      concentration: 5,
    });
    // 残10以下のためターン開始時に自動回復判定ロールが1つ走る(不発=0.9)
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'yoko_nui', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng([0.9]),
    );
    expect(events.find((e) => e.kind === 'insufficientConcentration')).toBeDefined();
    expect(s2.concentration).toBe(5); // 据え置き
    expect(s2.turn).toBe(0); // ターン消費なし
  });

  it('しあげる(finish)は消費0で常に可能', () => {
    const engine = buildEngine();
    const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };
    const state = engine.createStateFromSnapshot({
      recipeId: 'x',
      category: 'head',
      rows: 2,
      cols: 2,
      cells: fourCells(100),
      powerCycle: ['normal'],
      concentration: 0,
    });
    const { state: s2, events } = engine.applyAction(state, { type: 'finish' }, config, new ScriptedRng([]));
    expect(s2.finished).toBe(true);
    expect(events.find((e) => e.kind === 'finish')).toBeDefined();
  });
});

describe('T6 集中力の自動回復', () => {
  it('残10以下のターン開始時、10%で+30、1セッション1回', () => {
    const engine = buildEngine();
    const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };
    const state = engine.createStateFromSnapshot({
      recipeId: 'x',
      cells: [{ r: 1, c: 1, base: 999, cumulative: 0, shitsuke: false }],
      powerCycle: ['normal'],
      concentration: 8, // 残10以下
    });
    // ターン開始: 回復ロール x<0.1 → 発動 +30 → 38。ぬう5消費 → 33
    const rng = new ScriptedRng([0.05 /*回復*/, baseValueRoll(12), CRIT_NO, HISSATSU_NO]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(events.find((e) => e.kind === 'concRecovery')).toMatchObject({ amount: 30 });
    expect(s2.concentration).toBe(8 + 30 - 5);
    expect(s2.concRecoveryUsed).toBe(true);
  });

  it('2回目は発動しない(1セッション1回)', () => {
    const engine = buildEngine();
    const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };
    // 既に回復使用済み
    let state = engine.createStateFromSnapshot({
      recipeId: 'x',
      cells: [{ r: 1, c: 1, base: 999, cumulative: 0, shitsuke: false }],
      powerCycle: ['normal'],
      concentration: 8,
      concRecoveryUsed: true,
    });
    // 回復ロールは消費されない(concRecoveryUsed=true)
    const rng = new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]);
    const res = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    state = res.state;
    expect(res.events.find((e) => e.kind === 'concRecovery')).toBeUndefined();
    expect(state.concentration).toBe(8 - 5);
  });

  it('不発の場合はフラグを立てず、次の条件成立ターンで再抽選される(SPEC v1.1)', () => {
    const engine = buildEngine();
    const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };
    let state = engine.createStateFromSnapshot({
      recipeId: 'x',
      cells: [{ r: 1, c: 1, base: 9999, cumulative: 0, shitsuke: false }],
      powerCycle: ['normal'],
      concentration: 8, // 残10以下
    });
    // ターン1: 回復ロール不発(x=0.9 ≥ 0.1) → concRecoveryUsedは立たない
    let res = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng([0.9 /*回復不発*/, baseValueRoll(12), CRIT_NO, HISSATSU_NO]),
    );
    state = res.state;
    expect(res.events.find((e) => e.kind === 'concRecovery')).toBeUndefined();
    expect(state.concRecoveryUsed).toBe(false); // 不発ではフラグを立てない
    expect(state.concentration).toBe(3); // 8-5

    // ターン2: 残3(依然≤10) → 再度回復ロールが行われ、成功する
    res = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng([0.05 /*回復成功*/, baseValueRoll(12), CRIT_NO, HISSATSU_NO]),
    );
    state = res.state;
    expect(res.events.find((e) => e.kind === 'concRecovery')).toMatchObject({ amount: 30 });
    expect(state.concRecoveryUsed).toBe(true);
    expect(state.concentration).toBe(3 + 30 - 5); // 28

    // ターン3: 成功済みのため、残10以下でも以後は抽選されない(回復ロールを消費しない)
    const rng3 = new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]); // 回復ロールなし
    res = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng3,
    );
    expect(res.events.find((e) => e.kind === 'concRecovery')).toBeUndefined();
    expect(rng3.consumed()).toBe(3); // 基礎値+会心+必殺の3回のみ
  });
});
