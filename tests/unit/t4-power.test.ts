// T4. ターン進行・ぬいパワー (SPEC §3.2) + 精神統一・シフト (§3.3)

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SimulatorConfig, type RecipeDef, type Power } from '../../src/core';
import {
  buildEngine,
  ScriptedRng,
  baseValueRoll,
  CRIT_NO,
  HISSATSU_NO,
  singleCellRecipe,
} from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

function recipe(cycle: Power[]): RecipeDef {
  return { ...singleCellRecipe(9999, cycle), id: 'r' };
}

// 各ターンの turnStart イベントの power を取り出す
function playAndCollectPowers(cycle: Power[], turns: number, rngValues: () => number[]): Power[] {
  const engine = buildEngine();
  let { state } = engine.createSession(recipe(cycle), config, new ScriptedRng([]));
  const powers: Power[] = [];
  for (let t = 0; t < turns; t++) {
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng(rngValues()),
    );
    const ts = events.find((e) => e.kind === 'turnStart');
    if (ts && ts.kind === 'turnStart') powers.push(ts.power);
    state = s2;
  }
  return powers;
}

describe('T4 サイクルのループ', () => {
  it('末尾→先頭へループ', () => {
    const powers = playAndCollectPowers(
      ['weak', 'strong', 'strongest'],
      7,
      () => [baseValueRoll(12), CRIT_NO, HISSATSU_NO],
    );
    expect(powers).toEqual([
      'weak', 'strong', 'strongest',
      'weak', 'strong', 'strongest',
      'weak',
    ]);
  });
});

describe('T4 「？」の抽選', () => {
  it('ターン開始時に他5種へ変化(nextInt(5)で決まる)', () => {
    const engine = buildEngine();
    const { state } = engine.createSession(recipe(['unknown']), config, new ScriptedRng([]));
    // unknown 抽選: nextInt(5)=floor(x*5)。x=0.5→index2=strong
    const rng = new ScriptedRng([0.5, baseValueRoll(12), CRIT_NO, HISSATSU_NO]);
    const { events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    const ts = events.find((e) => e.kind === 'turnStart');
    expect(ts).toMatchObject({ power: 'strong', drawnPower: 'strong' });
  });

  it('？→critx2 はランダム会心(会心率への補正なし。会心確定ではない)', () => {
    const engine = buildEngine();
    // 銅★0+コツ+パッシブ = 0.010+0.010+0.001 = 0.021。ランダム会心は補正なしのまま。
    const { state } = engine.createSession(recipe(['unknown']), config, new ScriptedRng([]));
    // nextInt(5): critx2 は index4 → x=0.9→floor(4.5)=4
    // 会心ロール 0.03 > 0.021 → 不発(補正なしを確認。シフト会心なら×2=0.042で会心になる値)
    const rng = new ScriptedRng([0.9, baseValueRoll(12), 0.03, HISSATSU_NO]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    const ts = events.find((e) => e.kind === 'turnStart');
    expect(ts).toMatchObject({ power: 'critx2' });
    // 不発 → critx2 の係数は1なので base12 のまま
    expect(s2.cells[0].cumulative).toBe(12);
    const sew = events.find((e) => e.kind === 'sewCell');
    expect(sew).toMatchObject({ crit: false });
  });

  it('？→critx2 でも会心率どおりに会心は発生し得る', () => {
    const engine = buildEngine();
    const { state } = engine.createSession(recipe(['unknown']), config, new ScriptedRng([]));
    // 会心ロール 0.02 < 0.021 → 会心 → 12×2=24
    const rng = new ScriptedRng([0.9, baseValueRoll(12), 0.02, HISSATSU_NO]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(s2.cells[0].cumulative).toBe(24);
    expect(events.find((e) => e.kind === 'sewCell')).toMatchObject({ crit: true });
  });
});

describe('T4 精神統一', () => {
  it('3ターン固定: ？ターンで抽選後のパワーを固定', () => {
    const engine = buildEngine();
    // サイクル: unknown, weak, strong, strongest ...
    const { state } = engine.createSession(
      recipe(['unknown', 'weak', 'strong', 'strongest']),
      config,
      new ScriptedRng([]),
    );
    // T1: unknown抽選→strong(index2, x=0.5), 精神統一(support, turnDamage0)
    const r1 = new ScriptedRng([0.5]);
    const { state: s1, events: e1 } = engine.applyAction(
      state,
      { type: 'skill', skillId: 'seishin_toitsu' },
      config,
      r1,
    );
    expect(e1.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'strong' });
    expect(e1.find((e) => e.kind === 'powerLock')).toMatchObject({ power: 'strong', turns: 3 });

    // T2,T3,T4: strong 固定(抽選なし)。ぬうで縫う
    let s = s1;
    for (let t = 0; t < 3; t++) {
      const { state: sn, events } = engine.applyAction(
        s,
        { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
        config,
        new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]),
      );
      // 精神統一のターン(T1)を含めると固定は T1..T3。T2/T3 は strong、T4 で解除されサイクル進行
      const ts = events.find((e) => e.kind === 'turnStart');
      if (t < 2) {
        expect(ts).toMatchObject({ power: 'strong' });
      }
      s = sn;
    }
  });
});

describe('T4 ぬいパワーシフト', () => {
  it('使用ターンのパワーを除く5種から選ぶ、critx2選択でシフト会心', () => {
    const engine = buildEngine();
    // サイクル weak: 使用ターン=weak。候補=[normal,strong,strongest,critx2](weak除外)
    const { state } = engine.createSession(recipe(['weak', 'normal']), config, new ScriptedRng([]));
    // shift候補は4種。critx2はindex3 → nextInt(4): x=0.9→floor(3.6)=3
    const r1 = new ScriptedRng([0.9]);
    const { state: s1, events: e1 } = engine.applyAction(
      state,
      { type: 'skill', skillId: 'power_shift' },
      config,
      r1,
    );
    expect(e1.find((e) => e.kind === 'powerShift')).toMatchObject({ from: 'weak', to: 'critx2', shiftCrit: true });

    // 次ターン: forcedNextPower=critx2 → シフト会心 = 会心率×2(会心確定ではない)
    // 銅★0+コツ+パッシブ=0.021、シフト会心×2=0.042。
    // 会心ロール 0.03 は「補正なしなら不発(>0.021)、シフト会心なら会心(<0.042)」の境界値。
    const r2 = new ScriptedRng([baseValueRoll(12), 0.03, HISSATSU_NO]);
    const { state: s2, events: e2 } = engine.applyAction(
      s1,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      r2,
    );
    expect(e2.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'critx2' });
    expect(e2.find((e) => e.kind === 'sewCell')).toMatchObject({ crit: true });
    expect(s2.cells[0].cumulative).toBe(24); // 会心2倍(×2補正が効いている証跡)
  });
});
