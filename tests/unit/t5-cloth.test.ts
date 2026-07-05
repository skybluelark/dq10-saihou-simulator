// T5. 布の特性 (SPEC §3.6)

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  isTraitTurn,
  rainbowMode,
  type SimulatorConfig,
  type RecipeDef,
  type ClothType,
} from '../../src/core';
import { loadGameParams } from '../../src/data';
import {
  buildEngine,
  ScriptedRng,
  baseValueRoll,
  CRIT_NO,
  HISSATSU_NO,
} from '../fixtures/engine-helpers';

const params = loadGameParams();
const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

function grid3x3(clothType: ClothType, base = 300): RecipeDef {
  const cells = [];
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) cells.push({ r, c, base });
  return { id: 'c', name: 'c', category: 'body_upper', clothType, rows: 3, cols: 3, cells, powerCycle: ['normal'] };
}

describe('T5 発動タイミング', () => {
  it('5,9,13,17 が発動、それ以外は非発動', () => {
    const on = [5, 9, 13, 17, 21];
    for (let t = 1; t <= 21; t++) {
      expect(isTraitTurn(t, params)).toBe(on.includes(t));
    }
  });
  it('虹モード: 5=half, 9=up, 13=half(交互)', () => {
    expect(rainbowMode(5, params)).toBe('half');
    expect(rainbowMode(9, params)).toBe('up');
    expect(rainbowMode(13, params)).toBe('half');
    expect(rainbowMode(17, params)).toBe('up');
  });
});

describe('T5 虹布: 消費半減/1.5倍の端数切り上げ', () => {
  it('5ターン目=半減(消費7→4), 9ターン目=1.5倍(消費7→11)', () => {
    const engine = buildEngine();
    let { state } = engine.createSession(grid3x3('rainbow', 9999), config, new ScriptedRng([]));
    let concBefore = state.concentration;
    const costs: number[] = [];
    for (let t = 1; t <= 9; t++) {
      const res = engine.applyAction(
        state,
        { type: 'skill', skillId: 'seishin_toitsu' }, // cost7, support(turnDamage0)
        config,
        new ScriptedRng([]),
      );
      // support seishin は power lock するが観測はコストのみ
      costs.push(concBefore - res.state.concentration);
      concBefore = res.state.concentration;
      state = res.state;
    }
    // 精神統一は lockPower するため power は固定されるが、コストは虹補正を受ける
    // T5: 半減 ceil(7*0.5)=4, T9: 1.5倍 ceil(7*1.5)=11
    expect(costs[4]).toBe(4); // 5ターン目
    expect(costs[8]).toBe(11); // 9ターン目
    // 通常ターンは 7
    expect(costs[0]).toBe(7);
  });
});

describe('T5 光布: 発光候補と効果', () => {
  it('候補=残り5以上のマスのみ、発光1マス、補正2と+24%', () => {
    const engine = buildEngine();
    // 全マス base300。4ターン support で進め、5ターン目に発光
    let { state } = engine.createSession(grid3x3('light', 300), config, new ScriptedRng([]));
    for (let t = 0; t < 4; t++) {
      const res = engine.applyAction(
        state,
        { type: 'sew', skillId: 'shitsuke_gake', anchor: { r: 3, c: 3 } }, // support, turnDamage0
        config,
        new ScriptedRng([]),
      );
      state = res.state;
    }
    // 5ターン目: glow抽選(nextInt(候補数)=9マス→index0=(1,1))
    const rng = new ScriptedRng([0.0 /*glow index0*/, baseValueRoll(12), CRIT_NO, HISSATSU_NO]);
    const res = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(res.events.find((e) => e.kind === 'glow')).toMatchObject({ r: 1, c: 1 });
    // (1,1)発光マス縫い: base12普通 補正2 = 24
    expect(res.state.cells.find((c) => c.r === 1 && c.c === 1)!.cumulative).toBe(24);
  });
});

describe('T5 光布: 候補なしなら発光なし', () => {
  it('全マス黄色枠内なら glow イベントなし', () => {
    const engine = buildEngine();
    // base4 → 残り4は黄色枠内(|残り|≤4)。発光候補なし
    const recipe = grid3x3('light', 4);
    let { state } = engine.createSession(recipe, config, new ScriptedRng([]));
    for (let t = 0; t < 4; t++) {
      const res = engine.applyAction(
        state,
        { type: 'sew', skillId: 'shitsuke_gake', anchor: { r: 3, c: 3 } },
        config,
        new ScriptedRng([]),
      );
      state = res.state;
    }
    // 5ターン目: 発光候補なし → glow抽選も消費しない
    const rng = new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]);
    const res = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(res.events.find((e) => e.kind === 'glow')).toBeUndefined();
  });
});

describe('T5 再生布: 対象選定', () => {
  it('累積÷基準値が最大のマス(黄色枠内除外)を回復', () => {
    const engine = buildEngine();
    // マスごとに base 違い、累積を snapshot で設定
    const cells = [
      { r: 1, c: 1, base: 1000, cumulative: 950, shitsuke: false }, // ratio0.95 残り50(枠外)
      { r: 1, c: 2, base: 100, cumulative: 10, shitsuke: false }, // ratio0.1 残り90
      { r: 1, c: 3, base: 100, cumulative: 50, shitsuke: false },
      { r: 2, c: 1, base: 100, cumulative: 2, shitsuke: false }, // 残り98(枠外)ratio0.02
      { r: 2, c: 2, base: 100, cumulative: 99, shitsuke: false }, // ratio0.99 残り1(枠内→除外)
      { r: 2, c: 3, base: 100, cumulative: 30, shitsuke: false },
      { r: 3, c: 1, base: 100, cumulative: 40, shitsuke: false },
      { r: 3, c: 2, base: 100, cumulative: 60, shitsuke: false },
      { r: 3, c: 3, base: 100, cumulative: 70, shitsuke: false },
    ];
    const state = engine.createStateFromSnapshot({
      recipeId: 'regen',
      cells,
      powerCycle: ['normal'],
      clothType: 'regen',
      category: 'body_upper',
      rows: 3,
      cols: 3,
      concentration: 207,
      turn: 4, // 次ターン=5で発動
    });
    // (2,2)はratio0.99だが残り1で黄色枠内→除外。(1,1)ratio0.95が最大で対象
    // 縫いは別マス(1,2)にして (1,1) を枠外に保つ
    const rng = new ScriptedRng([
      baseValueRoll(12), CRIT_NO, // nuu on (1,2): 累積10→22
      // 再生: 最大ratioは(1,1) 単一 → tiebreak 消費なし。回復量ロール: index0=12
      0.0,
      HISSATSU_NO,
    ]);
    const res = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 2 } },
      config,
      rng,
    );
    const regen = res.events.find((e) => e.kind === 'clothRegen');
    // (1,1) 累積950 ratio0.95 が最大 → 対象 (1,1)、12回復 → 938
    expect(regen).toMatchObject({ r: 1, c: 1, amount: 12 });
  });
});
