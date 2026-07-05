// T7. 必殺 (SPEC §3.3)

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SimulatorConfig } from '../../src/core';
import { loadGameParams, loadNeedles } from '../../src/data';
import {
  buildEngine,
  ScriptedRng,
  baseValueRoll,
  CRIT_NO,
  singleCellRecipe,
} from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

function fourCellSnapshot(engine: ReturnType<typeof buildEngine>, over: Record<string, unknown> = {}) {
  return engine.createStateFromSnapshot({
    recipeId: 'x',
    category: 'head',
    rows: 2,
    cols: 2,
    cells: [
      { r: 1, c: 1, base: 999, cumulative: 0, shitsuke: false },
      { r: 1, c: 2, base: 999, cumulative: 0, shitsuke: false },
      { r: 2, c: 1, base: 999, cumulative: 0, shitsuke: false },
      { r: 2, c: 2, base: 999, cumulative: 0, shitsuke: false },
    ],
    powerCycle: ['normal'],
    concentration: 207,
    ...over,
  });
}

describe('T7 チャージ判定', () => {
  it('与ダメージ>0のターン終了時に判定、率=基礎値×与ダメ×針会心率', () => {
    const engine = buildEngine();
    const params = loadGameParams();
    const state = fourCellSnapshot(engine);
    // nuu base12 普通 = 12ダメ。率 = 0.00233 × 12 × 0.010 ≈ 0.00028
    const rate = params.hissatsuCharge.baseRate * 12 * 0.010;
    // チャージロール: rate 未満なら発動
    const rng = new ScriptedRng([baseValueRoll(12), CRIT_NO, rate * 0.5]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(events.find((e) => e.kind === 'hissatsuCharge')).toMatchObject({ source: 'turnEnd' });
    expect(s2.hissatsuCharged).toBe(true);
  });

  it('率をわずかに超えるロールでは発動しない', () => {
    const engine = buildEngine();
    const params = loadGameParams();
    const state = fourCellSnapshot(engine);
    const rate = params.hissatsuCharge.baseRate * 12 * 0.010;
    const rng = new ScriptedRng([baseValueRoll(12), CRIT_NO, rate * 1.01]);
    const { state: s2 } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(s2.hissatsuCharged).toBe(false);
  });

  it('与ダメージ0のターン(精神統一)は判定なし(乱数を消費しない)', () => {
    const engine = buildEngine();
    const state = fourCellSnapshot(engine);
    const rng = new ScriptedRng([]); // 何も消費しないはず
    const { state: s2 } = engine.applyAction(
      state,
      { type: 'skill', skillId: 'seishin_toitsu' },
      config,
      rng,
    );
    expect(rng.consumed()).toBe(0);
    expect(s2.hissatsuCharged).toBe(false);
  });

  it('糸ほぐしのターンは判定なし', () => {
    const engine = buildEngine();
    const state = fourCellSnapshot(engine, {
      cells: [
        { r: 1, c: 1, base: 999, cumulative: 100, shitsuke: false },
        { r: 1, c: 2, base: 999, cumulative: 0, shitsuke: false },
        { r: 2, c: 1, base: 999, cumulative: 0, shitsuke: false },
        { r: 2, c: 2, base: 999, cumulative: 0, shitsuke: false },
      ],
    });
    // 糸ほぐし: 基礎値ロールのみ1消費、チャージ判定なし
    const rng = new ScriptedRng([0.5]);
    const { state: s2 } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'ito_hogushi', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(rng.consumed()).toBe(1);
    expect(s2.hissatsuCharged).toBe(false);
  });

  it('チャージ保持中は再判定なし(乱数を消費しない)', () => {
    const engine = buildEngine();
    const state = fourCellSnapshot(engine, { hissatsuCharged: true });
    // nuu: 基礎値+会心のみ2消費(チャージ判定なし)
    const rng = new ScriptedRng([baseValueRoll(12), CRIT_NO]);
    const { state: s2 } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(rng.consumed()).toBe(2);
    expect(s2.hissatsuCharged).toBe(true);
  });
});

describe('T7 光針の開幕チャージ (10%)', () => {
  it('発動 (x<0.1)', () => {
    const engine = buildEngine();
    const cfg: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'hikari', stars: 0 } };
    const { state, events } = engine.createSession(singleCellRecipe(100), cfg, new ScriptedRng([0.05]));
    expect(state.hissatsuCharged).toBe(true);
    expect(events.find((e) => e.kind === 'hissatsuCharge')).toMatchObject({ source: 'opening' });
  });
  it('不発 (x=0.5)', () => {
    const engine = buildEngine();
    const cfg: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'hikari', stars: 0 } };
    const { state } = engine.createSession(singleCellRecipe(100), cfg, new ScriptedRng([0.5]));
    expect(state.hissatsuCharged).toBe(false);
  });
  it('needles.json の開幕効果定義', () => {
    const needles = loadNeedles();
    const hikari = needles.needles.find((n) => n.id === 'hikari')!;
    expect(hikari.openingEffect).toEqual({ type: 'hissatsuCharge', chance: 0.1 });
    const miracle = needles.needles.find((n) => n.id === 'miracle')!;
    expect(miracle.openingEffect).toEqual({ type: 'concentration', chance: 0.3, amount: 30 });
  });
});

describe('T7 無我の境地', () => {
  it('チャージ状態でのみ使用可(未チャージは例外)', () => {
    const engine = buildEngine();
    const state = fourCellSnapshot(engine, { hissatsuCharged: false });
    expect(() =>
      engine.applyAction(state, { type: 'skill', skillId: 'muga_no_kyochi' }, config, new ScriptedRng([])),
    ).toThrow();
  });

  it('消費0・1ターン消費(パワーが進む)・会心率×2がセッション終了まで持続', () => {
    const engine = buildEngine();
    const state = fourCellSnapshot(engine, {
      hissatsuCharged: true,
      powerCycle: ['weak', 'strong'],
    });
    const before = state.concentration;
    const { state: s1, events: e1 } = engine.applyAction(
      state,
      { type: 'skill', skillId: 'muga_no_kyochi' },
      config,
      new ScriptedRng([]),
    );
    expect(e1.find((e) => e.kind === 'muga')).toBeDefined();
    expect(s1.concentration).toBe(before); // 消費0
    expect(s1.turn).toBe(1); // 1ターン消費
    expect(s1.cycleIndex).toBe(1); // パワーが次に移動
    expect(s1.mugaActive).toBe(true);
    expect(s1.hissatsuCharged).toBe(false);
    expect(s1.hissatsuUsed).toBe(true);

    // 会心率×2の実効確認: copper★0 = 0.010 + コツ0.01 + パッシブ0.001 = 0.021 → ×2 = 0.042
    // ロール 0.03: 通常なら非会心、無我中は会心
    const rng = new ScriptedRng([baseValueRoll(12), 0.03]);
    const { events: e2 } = engine.applyAction(
      s1,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    const sew = e2.find((e) => e.kind === 'sewCell');
    expect(sew).toMatchObject({ crit: true });
  });

  it('使用後の再チャージなし(与ダメージターンでも判定なし)', () => {
    const engine = buildEngine();
    const state = fourCellSnapshot(engine, { hissatsuUsed: true });
    // nuu: 基礎値+会心のみ2消費(hissatsuUsed のためチャージ判定なし)
    const rng = new ScriptedRng([baseValueRoll(12), CRIT_NO]);
    const { state: s2 } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(rng.consumed()).toBe(2);
    expect(s2.hissatsuCharged).toBe(false);
  });
});
