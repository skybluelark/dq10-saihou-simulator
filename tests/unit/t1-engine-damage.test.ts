// T1(エンジン経由): 会心の頭打ち・縫いすぎ・糸ほぐしの回復頭打ち。

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SimulatorConfig } from '../../src/core';
import {
  buildEngine,
  ScriptedRng,
  baseValueRoll,
  hogushiRoll,
  CRIT_YES,
  CRIT_NO,
  HISSATSU_NO,
  singleCellRecipe,
} from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

describe('T1 会心の頭打ち・縫いすぎ', () => {
  it('会心: 2倍が残りを超えると基準値で頭打ち (残り0, capped)', () => {
    const engine = buildEngine();
    // base=30。ぬう(1倍)普通、base12→ダメ12、会心で24。残り30なので頭打ちなし。
    // base=20 にして base18→18ダメ、会心36 > 残り20 → 頭打ちで20(残り0)
    const recipe = singleCellRecipe(20, ['normal']);
    const { state } = engine.createSession(recipe, config, new ScriptedRng([]));
    const rng = new ScriptedRng([baseValueRoll(18), CRIT_YES, HISSATSU_NO]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    const cell = s2.cells[0];
    expect(cell.base - cell.cumulative).toBe(0);
    const sew = events.find((e) => e.kind === 'sewCell');
    expect(sew).toMatchObject({ crit: true, capped: true, damage: 20 });
  });

  it('会心: 2倍が残り未満なら頭打ちなし', () => {
    const engine = buildEngine();
    const recipe = singleCellRecipe(100, ['normal']);
    const { state } = engine.createSession(recipe, config, new ScriptedRng([]));
    const rng = new ScriptedRng([baseValueRoll(12), CRIT_YES, HISSATSU_NO]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    // base12 → 12ダメ、会心24。残り100-24=76
    expect(s2.cells[0].cumulative).toBe(24);
    expect(events.find((e) => e.kind === 'sewCell')).toMatchObject({ capped: false, damage: 24 });
  });

  it('非会心: 残りを超えても縫いすぎ(マイナス)を許容', () => {
    const engine = buildEngine();
    const recipe = singleCellRecipe(10, ['strongest']);
    const { state } = engine.createSession(recipe, config, new ScriptedRng([]));
    // 最強2倍係数, base18, 倍率1 → 36ダメ。会心なし。残り10-36=-26(縫いすぎ)
    const rng = new ScriptedRng([baseValueRoll(18), CRIT_NO, HISSATSU_NO]);
    const { state: s2 } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(s2.cells[0].base - s2.cells[0].cumulative).toBe(-26);
  });
});

describe('T1 糸ほぐし', () => {
  it('会心判定が呼ばれない(乱数は基礎値のみ消費)', () => {
    const engine = buildEngine();
    const recipe = singleCellRecipe(100, ['normal']);
    let { state } = engine.createSession(recipe, config, new ScriptedRng([]));
    // まず縫って累積を作る: base12普通=12, 非会心
    ({ state } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]),
    ));
    expect(state.cells[0].cumulative).toBe(12);
    // 糸ほぐし: 基礎値のみ1消費(会心判定なし)。使い切りチェックで会心分を入れない
    const rng = new ScriptedRng([hogushiRoll(6)]); // 普通 補正1 base6 → 6回復
    const { state: s2 } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'ito_hogushi', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(rng.consumed()).toBe(1); // 会心判定を消費していない
    expect(s2.cells[0].cumulative).toBe(6);
  });

  it('回復は初期状態(累積0)で頭打ち: 残り3(累積3)に普通糸ほぐし→3回復', () => {
    const engine = buildEngine();
    const recipe = singleCellRecipe(100, ['normal']);
    let { state } = engine.createSession(recipe, config, new ScriptedRng([]));
    // 累積を3にする: かげんぬい(0.5)で base12→ceil(6)→6…では3にならない。
    // 手動で snapshot 構築
    state = engine.createStateFromSnapshot({
      recipeId: recipe.id,
      cells: [{ r: 1, c: 1, base: 100, cumulative: 3, shitsuke: false }],
      powerCycle: ['normal'],
      concentration: 207,
    });
    const rng = new ScriptedRng([hogushiRoll(9)]); // 普通補正1 base9 → 9回復のはずが3で頭打ち
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'ito_hogushi', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(s2.cells[0].cumulative).toBe(0);
    expect(events.find((e) => e.kind === 'sewCell')).toMatchObject({ damage: -3 });
  });
});
