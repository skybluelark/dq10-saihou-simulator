// T4. ターン進行・ぬいパワー (SPEC §3.2) + 精神統一・シフト (§3.3)

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  peekNextPower,
  type SimulatorConfig,
  type RecipeDef,
  type Power,
} from '../../src/core';
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

    // 使用ターン(T1)で1ターン経過し、次のターンから3ターン(T2〜T4)固定。
    let s = s1;
    for (let t = 0; t < 3; t++) {
      const { state: sn, events } = engine.applyAction(
        s,
        { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
        config,
        new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]),
      );
      const ts = events.find((e) => e.kind === 'turnStart');
      expect(ts).toMatchObject({ power: 'strong' }); // T2/T3/T4 すべて固定
      s = sn;
    }

    // T5: 固定解除。サイクルは停止していたため続き(idx1=weak)から再開
    const { events: e5 } = engine.applyAction(
      s,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]),
    );
    expect(e5.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'weak' });
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

describe('T4 「次に来るぬいパワー」(peekNextPower, SPEC §4.3)', () => {
  it('通常時はサイクルの次エントリを返す', () => {
    const engine = buildEngine();
    const created = engine.createSession(recipe(['weak', 'strong', 'normal']), config, new ScriptedRng([]));
    // 開幕処理(beginTurn)で currentPower=weak(idx0) が確定。次に来る=strong(idx1)。
    const { state } = engine.beginTurn(created.state, new ScriptedRng([]));
    expect(state.currentPower).toBe('weak');
    expect(peekNextPower(state)).toBe('strong');
  });
});

describe('T4 「会心×2」の内部区別と精神統一の固定 (SPEC §3.3/§3.4, 実機確認 2026-07-07)', () => {
  it('シフト会心ターンを固定すると、固定中も会心率×2補正が持続する', () => {
    const engine = buildEngine();
    // サイクル: weak, normal, strong
    const { state } = engine.createSession(
      recipe(['weak', 'normal', 'strong']),
      config,
      new ScriptedRng([]),
    );

    // T1(weak): ぬいパワーシフト。候補[normal,strong,strongest,critx2]、0.9→critx2。
    const { state: s1 } = engine.applyAction(
      state,
      { type: 'skill', skillId: 'power_shift' },
      config,
      new ScriptedRng([0.9]),
    );

    // T2(シフト会心 critx2): 精神統一 → シフト会心の区別ごと固定される。
    const { state: s2, events: e2 } = engine.applyAction(
      s1,
      { type: 'skill', skillId: 'seishin_toitsu' },
      config,
      new ScriptedRng([]),
    );
    expect(e2.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'critx2' });
    expect(e2.find((e) => e.kind === 'powerLock')).toMatchObject({ power: 'critx2', turns: 3 });

    // T3(固定中): 会心率×2が持続。銅★0+コツ+パッシブ=0.021、×2=0.042。
    // ロール0.03は「補正なしなら不発(>0.021)、シフト会心なら会心(<0.042)」の境界値。
    const { state: s3, events: e3 } = engine.applyAction(
      s2,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng([baseValueRoll(12), 0.03, HISSATSU_NO]),
    );
    expect(e3.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'critx2' });
    expect(e3.find((e) => e.kind === 'sewCell')).toMatchObject({ crit: true, damage: 24 });

    // T4(固定中): 補正込みでも上回るロール(0.05>0.042)は不発 = 会心確定ではない。
    const { events: e4 } = engine.applyAction(
      s3,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng([baseValueRoll(12), 0.05, HISSATSU_NO]),
    );
    expect(e4.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'critx2' });
    expect(e4.find((e) => e.kind === 'sewCell')).toMatchObject({ crit: false });
  });

  it('ランダム会心ターンを固定すると、補正なしの「会心×2」が続く', () => {
    const engine = buildEngine();
    const { state } = engine.createSession(recipe(['unknown']), config, new ScriptedRng([]));

    // T1: ？抽選 0.9 → critx2(ランダム会心)。精神統一で固定。
    const { state: s1, events: e1 } = engine.applyAction(
      state,
      { type: 'skill', skillId: 'seishin_toitsu' },
      config,
      new ScriptedRng([0.9]),
    );
    expect(e1.find((e) => e.kind === 'powerLock')).toMatchObject({ power: 'critx2', turns: 3 });

    // T2(固定中): 補正なし。ロール0.03 > 0.021 → 不発(シフト会心なら会心になる値)。
    const { events: e2 } = engine.applyAction(
      s1,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng([baseValueRoll(12), 0.03, HISSATSU_NO]),
    );
    expect(e2.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'critx2' });
    expect(e2.find((e) => e.kind === 'sewCell')).toMatchObject({ crit: false, damage: 12 });
  });
});

describe('T4 精神統一固定中のぬいパワーシフト (SPEC §3.3/§4.3)', () => {
  it('固定解除後に実行されるパワーが変わり、シフト会心はその実行ターンに乗る', () => {
    const engine = buildEngine();
    // サイクル: strong, weak, normal
    const { state } = engine.createSession(
      recipe(['strong', 'weak', 'normal']),
      config,
      new ScriptedRng([]),
    );

    // T1: currentPower=strong を精神統一で固定(T2〜T4)。
    const { state: s1, events: e1 } = engine.applyAction(
      state,
      { type: 'skill', skillId: 'seishin_toitsu' },
      config,
      new ScriptedRng([]),
    );
    expect(e1.find((e) => e.kind === 'powerLock')).toMatchObject({ power: 'strong', turns: 3 });
    // 固定中の「次に来るパワー」= 固定解除後のサイクル続き(weak)。
    expect(peekNextPower(s1)).toBe('weak');

    // T2(固定中=strong): ぬいパワーシフト。from=strong、候補[weak,normal,strongest,critx2]。
    // critx2 は index3 → nextInt(4): 0.9→3。
    const { state: s2, events: e2 } = engine.applyAction(
      s1,
      { type: 'skill', skillId: 'power_shift' },
      config,
      new ScriptedRng([0.9]),
    );
    expect(e2.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'strong' }); // 固定中
    expect(e2.find((e) => e.kind === 'powerShift')).toMatchObject({
      from: 'strong',
      to: 'critx2',
      shiftCrit: true,
    });
    // シフト後、「次に来るパワー」= 固定解除後に実行される critx2 に変わる。
    expect(peekNextPower(s2)).toBe('critx2');

    // T3・T4(固定中=strong)。シフト会心フラグはここでは消費されない。
    let s = s2;
    for (let t = 0; t < 2; t++) {
      const { state: sn, events } = engine.applyAction(
        s,
        { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
        config,
        new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]),
      );
      expect(events.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'strong' });
      s = sn;
    }

    // T5: 固定解除。forcedNextPower=critx2 が実行され、シフト会心×2 が「このターン」に乗る。
    // 銅★0+コツ+パッシブ=0.021、シフト会心×2=0.042。会心ロール0.03 は
    // 「補正なしなら不発(>0.021)、シフト会心なら会心(<0.042)」の境界値。
    const { events: e5 } = engine.applyAction(
      s,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng([baseValueRoll(12), 0.03, HISSATSU_NO]),
    );
    expect(e5.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'critx2' });
    expect(e5.find((e) => e.kind === 'sewCell')).toMatchObject({ crit: true, damage: 24 });
  });
});
