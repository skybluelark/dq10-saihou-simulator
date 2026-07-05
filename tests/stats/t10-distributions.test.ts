// T10. 統計的検証 (TEST_PLAN §3)
// シード固定の大量試行で分布を検証。判定は理論値 ±3σ。
// 実行: npm run test:stats

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  Mulberry32,
  type SimulatorConfig,
  type GameState,
  type Power,
} from '../../src/core';
import { buildEngine, singleCellRecipe } from '../fixtures/engine-helpers';

const engine = buildEngine();
const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

/** 二項分布の 3σ 内か検証。 */
function expectWithin3Sigma(observed: number, n: number, p: number, label: string) {
  const sigma = Math.sqrt((p * (1 - p)) / n);
  const diff = Math.abs(observed / n - p);
  expect(diff, `${label}: observed=${(observed / n).toFixed(5)} expected=${p.toFixed(5)} 3σ=${(3 * sigma).toFixed(5)}`).toBeLessThanOrEqual(3 * sigma);
}

function snapshot4(over: Partial<GameState> = {}): GameState {
  return engine.createStateFromSnapshot({
    recipeId: 's',
    category: 'head',
    rows: 2,
    cols: 2,
    cells: [
      { r: 1, c: 1, base: 100000, cumulative: 50000, shitsuke: false },
      { r: 1, c: 2, base: 100000, cumulative: 50000, shitsuke: false },
      { r: 2, c: 1, base: 100000, cumulative: 50000, shitsuke: false },
      { r: 2, c: 2, base: 100000, cumulative: 50000, shitsuke: false },
    ],
    powerCycle: ['normal'],
    concentration: 207,
    ...over,
  });
}

describe('T10 基礎値の分布', () => {
  it('縫い 12〜18 が各1/7 (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1001);
    const state = snapshot4();
    const counts = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      const { events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      const sew = events.find((e) => e.kind === 'sewCell');
      if (sew && sew.kind === 'sewCell' && !sew.crit) {
        counts.set(sew.damage, (counts.get(sew.damage) ?? 0) + 1);
      }
    }
    // 非会心のみ集計(会心判定は基礎値と独立のため分布は不変)
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    for (let v = 12; v <= 18; v++) {
      expectWithin3Sigma(counts.get(v) ?? 0, total, 1 / 7, `基礎値${v}`);
    }
  });

  it('糸ほぐし 6〜9 が各1/4 (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1002);
    const state = snapshot4();
    const counts = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      const { events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'ito_hogushi', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      const sew = events.find((e) => e.kind === 'sewCell');
      if (sew && sew.kind === 'sewCell') {
        counts.set(-sew.damage, (counts.get(-sew.damage) ?? 0) + 1);
      }
    }
    for (let v = 6; v <= 9; v++) {
      expectWithin3Sigma(counts.get(v) ?? 0, N, 1 / 4, `回復量${v}`);
    }
  });
});

describe('T10 「？」の変化先', () => {
  it('5種へ各1/5 (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1003);
    const state = snapshot4({ powerCycle: ['unknown'] });
    const counts = new Map<Power, number>();
    for (let i = 0; i < N; i++) {
      const { events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      const ts = events.find((e) => e.kind === 'turnStart');
      if (ts && ts.kind === 'turnStart' && ts.drawnPower) {
        counts.set(ts.drawnPower, (counts.get(ts.drawnPower) ?? 0) + 1);
      }
    }
    const candidates: Power[] = ['weak', 'normal', 'strong', 'strongest', 'critx2'];
    for (const p of candidates) {
      expectWithin3Sigma(counts.get(p) ?? 0, N, 1 / 5, `？→${p}`);
    }
  });
});

describe('T10 ぬいパワーシフトの変更先', () => {
  it('使用パワーを除く4種へ各1/4 (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1004);
    const state = snapshot4({ powerCycle: ['weak'] });
    const counts = new Map<Power, number>();
    for (let i = 0; i < N; i++) {
      const { events } = engine.applyAction(state, { type: 'skill', skillId: 'power_shift' }, config, rng);
      const shift = events.find((e) => e.kind === 'powerShift');
      if (shift && shift.kind === 'powerShift') {
        counts.set(shift.to, (counts.get(shift.to) ?? 0) + 1);
      }
    }
    expect(counts.get('weak')).toBeUndefined(); // 使用ターンのパワーは候補外
    const candidates: Power[] = ['normal', 'strong', 'strongest', 'critx2'];
    for (const p of candidates) {
      expectWithin3Sigma(counts.get(p) ?? 0, N, 1 / 4, `シフト→${p}`);
    }
  });
});

describe('T10 会心率の収束', () => {
  it('通常縫い: 銅★0+コツ+パッシブ = 2.1% (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1005);
    const state = snapshot4();
    let crits = 0;
    for (let i = 0; i < N; i++) {
      const { events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      const sew = events.find((e) => e.kind === 'sewCell');
      if (sew && sew.kind === 'sewCell' && sew.crit) crits++;
    }
    expectWithin3Sigma(crits, N, 0.021, '通常会心率');
  });

  it('ねらいぬい: (2.1%)×7 = 14.7% (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1006);
    const state = snapshot4();
    let crits = 0;
    for (let i = 0; i < N; i++) {
      const { events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'nerai_nui', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      const sew = events.find((e) => e.kind === 'sewCell');
      if (sew && sew.kind === 'sewCell' && sew.crit) crits++;
    }
    expectWithin3Sigma(crits, N, 0.021 * 7, 'ねらい会心率');
  });

  it('無我+光発光マス: ((2.1%)+24%)×2 (n=100000)', () => {
    // 光布の発光ターン+無我: (0.021 + 0.24) × 2 = 0.522
    const N = 100000;
    const rng = new Mulberry32(1007);
    const state = snapshot4({ clothType: 'light', mugaActive: true, hissatsuUsed: true, turn: 4 });
    let crits = 0;
    let total = 0;
    for (let i = 0; i < N; i++) {
      const { events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      const glow = events.find((e) => e.kind === 'glow');
      if (!(glow && glow.kind === 'glow' && glow.r === 1 && glow.c === 1)) continue; // 発光マスを縫ったケースのみ
      const sew = events.find((e) => e.kind === 'sewCell');
      if (sew && sew.kind === 'sewCell') {
        total++;
        if (sew.crit) crits++;
      }
    }
    expectWithin3Sigma(crits, total, (0.021 + 0.24) * 2, '無我+発光会心率');
  });
});

describe('T10 対象選択の等確率性', () => {
  it('みだれぬい: 9マス布で各マス選択率 4/9 (n=20000)', () => {
    const N = 20000;
    const rng = new Mulberry32(1008);
    const cells = [];
    for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) cells.push({ r, c, base: 100000, cumulative: 0, shitsuke: false });
    const state = engine.createStateFromSnapshot({
      recipeId: 'm9',
      category: 'body_upper',
      rows: 3,
      cols: 3,
      cells,
      powerCycle: ['normal'],
      concentration: 207,
    });
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const { events } = engine.applyAction(state, { type: 'skill', skillId: 'midare_nui' }, config, rng);
      for (const e of events) {
        if (e.kind === 'sewCell') {
          const key = `${e.r},${e.c}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    for (const [key, count] of counts) {
      expectWithin3Sigma(count, N, 4 / 9, `みだれ対象${key}`);
    }
    expect(counts.size).toBe(9);
  });

  it('光布の発光対象: 候補4マスで各1/4 (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1009);
    const state = snapshot4({ clothType: 'light', turn: 4 });
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const { events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      const glow = events.find((e) => e.kind === 'glow');
      if (glow && glow.kind === 'glow') {
        const key = `${glow.r},${glow.c}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of counts) {
      expectWithin3Sigma(count, N, 1 / 4, `発光対象${key}`);
    }
    expect(counts.size).toBe(4);
  });

  it('再生布のタイブレーク: 同率2マスで各1/2、回復量12〜16各1/5 (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1010);
    const state = engine.createStateFromSnapshot({
      recipeId: 'rg',
      category: 'head',
      rows: 2,
      cols: 2,
      clothType: 'regen',
      cells: [
        { r: 1, c: 1, base: 1000, cumulative: 500, shitsuke: false }, // ratio 0.5
        { r: 1, c: 2, base: 2000, cumulative: 1000, shitsuke: false }, // ratio 0.5
        { r: 2, c: 1, base: 1000, cumulative: 100, shitsuke: false },
        { r: 2, c: 2, base: 1000, cumulative: 100, shitsuke: false },
      ],
      powerCycle: ['normal'],
      concentration: 207,
      turn: 4, // 次ターン=5で発動
    });
    const targetCounts = new Map<string, number>();
    const amountCounts = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      // 精神統一(与ダメ0)で特性のみ観測
      const { events } = engine.applyAction(state, { type: 'skill', skillId: 'seishin_toitsu' }, config, rng);
      const regen = events.find((e) => e.kind === 'clothRegen');
      if (regen && regen.kind === 'clothRegen') {
        targetCounts.set(`${regen.r},${regen.c}`, (targetCounts.get(`${regen.r},${regen.c}`) ?? 0) + 1);
        amountCounts.set(regen.amount, (amountCounts.get(regen.amount) ?? 0) + 1);
      }
    }
    expectWithin3Sigma(targetCounts.get('1,1') ?? 0, N, 1 / 2, '再生対象(1,1)');
    expectWithin3Sigma(targetCounts.get('1,2') ?? 0, N, 1 / 2, '再生対象(1,2)');
    expect(targetCounts.size).toBe(2);
    for (const amount of [12, 13, 14, 15, 16]) {
      expectWithin3Sigma(amountCounts.get(amount) ?? 0, N, 1 / 5, `回復量${amount}`);
    }
  });
});

describe('T10 開幕効果・自動回復の確率', () => {
  it('奇跡針の開幕 +30 は 30% (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1011);
    const cfg: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'miracle', stars: 0 } };
    const recipe = singleCellRecipe(100);
    let fired = 0;
    for (let i = 0; i < N; i++) {
      const { state } = engine.createSession(recipe, cfg, rng);
      if (state.concentration === 207 + 50 + 30) fired++;
    }
    expectWithin3Sigma(fired, N, 0.3, '奇跡開幕');
  });

  it('光針の開幕チャージは 10% (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1012);
    const cfg: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'hikari', stars: 0 } };
    const recipe = singleCellRecipe(100);
    let fired = 0;
    for (let i = 0; i < N; i++) {
      const { state } = engine.createSession(recipe, cfg, rng);
      if (state.hissatsuCharged) fired++;
    }
    expectWithin3Sigma(fired, N, 0.1, '光開幕');
  });

  it('集中力自動回復は 10% (n=100000)', () => {
    const N = 100000;
    const rng = new Mulberry32(1013);
    const state = snapshot4({ concentration: 8 });
    let fired = 0;
    for (let i = 0; i < N; i++) {
      const { events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
        config,
        rng,
      );
      if (events.some((e) => e.kind === 'concRecovery')) fired++;
    }
    expectWithin3Sigma(fired, N, 0.1, '自動回復');
  });
});
