// T9. 決定論 (ARCHITECTURE A3/A4)
// - 同一シード+同一行動列 → 状態・イベント完全一致
// - 乱数消費順のゴールデンテスト(消費順が変わると失敗する)
// - リプレイ(シード+設定+レシピ+行動列)の再実行一致

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  Mulberry32,
  type SimulatorConfig,
  type Action,
  type GameState,
  type TurnEvent,
} from '../../src/core';
import {
  buildEngine,
  loadRealRecipes,
  ScriptedRng,
  baseValueRoll,
} from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'miracle', stars: 3 } };

// data/recipes.csv の実レシピでセッションを再生する
function playSession(seed: number, actions: Action[]) {
  const engine = buildEngine();
  const recipes = loadRealRecipes();
  const recipe = recipes.find((r) => r.id === 'kentetsu_koromo_ue')!; // 3×3 虹布・？入りサイクル
  const rng = new Mulberry32(seed);
  const session = engine.createSession(recipe, config, rng);
  const states: GameState[] = [session.state];
  const allEvents: TurnEvent[][] = [session.events];
  let state = session.state;
  for (const action of actions) {
    const res = engine.applyAction(state, action, config, rng);
    state = res.state;
    states.push(res.state);
    allEvents.push(res.events);
  }
  return { states, allEvents };
}

const ACTIONS: Action[] = [
  { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
  { type: 'sew', skillId: 'nibai_nui', anchor: { r: 2, c: 2 } },
  { type: 'sew', skillId: 'yoko_nui', anchor: { r: 1, c: 2 } },
  { type: 'skill', skillId: 'seishin_toitsu' },
  { type: 'sew', skillId: 'makikomi_nui', anchor: { r: 2, c: 2 } },
  { type: 'sew', skillId: 'suihei_nui', anchor: { r: 3, c: 2 } },
  { type: 'skill', skillId: 'midare_nui' },
  { type: 'sew', skillId: 'shitsuke_gake', anchor: { r: 3, c: 3 } },
  { type: 'sew', skillId: 'sanbai_nui', anchor: { r: 3, c: 3 } },
  { type: 'sew', skillId: 'ito_hogushi', anchor: { r: 2, c: 2 } },
  { type: 'skill', skillId: 'power_shift' },
  { type: 'sew', skillId: 'nerai_nui', anchor: { r: 1, c: 3 } },
  { type: 'finish' },
];

describe('T9 同一シード+同一行動列の完全一致', () => {
  it('全ターンの状態・イベント・最終結果が一致', () => {
    const run1 = playSession(20260706, ACTIONS);
    const run2 = playSession(20260706, ACTIONS);
    expect(run2.states).toEqual(run1.states);
    expect(run2.allEvents).toEqual(run1.allEvents);
  });

  it('異なるシードでは(高確率で)異なる結果', () => {
    const run1 = playSession(1, ACTIONS);
    const run2 = playSession(2, ACTIONS);
    expect(run2.states.at(-1)).not.toEqual(run1.states.at(-1));
  });

  it('最終状態のスナップショット(ゴールデン)', () => {
    const { states } = playSession(20260706, ACTIONS);
    const last = states.at(-1)!;
    // 実装変更で乱数消費順・計算が変わると一致しなくなる
    expect({
      turn: last.turn,
      concentration: last.concentration,
      cells: last.cells.map((c) => ({ r: c.r, c: c.c, remaining: c.base - c.cumulative })),
      finished: last.finished,
    }).toMatchSnapshot();
  });
});

describe('T9 乱数消費順のゴールデンテスト (ARCHITECTURE A4)', () => {
  it('ターン開始[？抽選→光発光→集中回復] → 縫い[基礎値→会心] → ターン終了[必殺]', () => {
    const engine = buildEngine();
    // 光布・？サイクル・残集中8・ターン4経過(次=5ターン目で光発動)
    const state = engine.createStateFromSnapshot({
      recipeId: 'g',
      category: 'head',
      rows: 2,
      cols: 2,
      clothType: 'light',
      cells: [
        { r: 1, c: 1, base: 100, cumulative: 0, shitsuke: false },
        { r: 1, c: 2, base: 100, cumulative: 0, shitsuke: false },
        { r: 2, c: 1, base: 100, cumulative: 0, shitsuke: false },
        { r: 2, c: 2, base: 100, cumulative: 0, shitsuke: false },
      ],
      powerCycle: ['unknown'],
      concentration: 8,
      turn: 4,
    });
    // 期待消費順(6個):
    //  1. ？抽選 nextInt(5): 0.5 → strong
    //  2. 光発光 nextInt(4候補): 0.3 → index1 = (1,2)
    //  3. 集中回復判定: 0.05 → 発動 (+30)
    //  4. 基礎値 nextInt(7): baseValueRoll(12)
    //  5. 会心判定: 0.9(非会心)
    //  6. 必殺チャージ判定: 0.9(不発)
    const rng = new ScriptedRng([0.5, 0.3, 0.05, baseValueRoll(12), 0.9, 0.9]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 2 } },
      config,
      rng,
    );
    expect(rng.consumed()).toBe(6); // 消費数が変わったら順序変更を疑う
    // 各消費が意図どおりのスロットに入ったことを結果で確認
    expect(events.find((e) => e.kind === 'turnStart')).toMatchObject({ power: 'strong' }); // 1
    expect(events.find((e) => e.kind === 'glow')).toMatchObject({ r: 1, c: 2 }); // 2
    expect(events.find((e) => e.kind === 'concRecovery')).toMatchObject({ amount: 30 }); // 3
    // 4-5: 発光マス(1,2)を縫い base12 強い(1.5) 補正2 → ceil(12*1)=12, ceil(12*1.5)=18, ceil(18*2)=36
    expect(events.find((e) => e.kind === 'sewCell')).toMatchObject({ r: 1, c: 2, damage: 36, crit: false });
    expect(s2.hissatsuCharged).toBe(false); // 6
  });

  it('みだれぬい: [対象4マス選択×4] → [基礎値→会心]×4 → ソート適用', () => {
    const engine = buildEngine();
    const state = engine.createStateFromSnapshot({
      recipeId: 'm',
      category: 'head',
      rows: 2,
      cols: 2,
      cells: [
        { r: 1, c: 1, base: 500, cumulative: 0, shitsuke: false },
        { r: 1, c: 2, base: 500, cumulative: 0, shitsuke: false },
        { r: 2, c: 1, base: 500, cumulative: 0, shitsuke: false },
        { r: 2, c: 2, base: 500, cumulative: 0, shitsuke: false },
      ],
      powerCycle: ['normal'],
      concentration: 207,
    });
    // 消費: 選択4 + (基礎+会心)×4 + 必殺1 = 13
    const rng = new ScriptedRng([
      0.1, 0.1, 0.1, 0.1, // 対象選択(4マス布=全マス)
      baseValueRoll(12), 0.9, // 1打目 2倍 → 24
      baseValueRoll(12), 0.9, // 2打目 1倍 → 12
      baseValueRoll(18), 0.9, // 3打目 1倍 → 18
      baseValueRoll(12), 0.9, // 4打目 0.5倍 → 6
      0.9, // 必殺
    ]);
    const { events } = engine.applyAction(state, { type: 'skill', skillId: 'midare_nui' }, config, rng);
    expect(rng.consumed()).toBe(13);
    const sews = events.filter((e) => e.kind === 'sewCell');
    expect(sews).toHaveLength(4);
    // 会心2倍適用後の値で降順ソート: 24,18,12,6
    expect(sews.map((e) => (e.kind === 'sewCell' ? e.damage : 0))).toEqual([24, 18, 12, 6]);
    // 4マス布では全マスが対象(重複なし)
    const targets = sews.map((e) => (e.kind === 'sewCell' ? `${e.r},${e.c}` : ''));
    expect(new Set(targets).size).toBe(4);
  });

  it('再生布(発動ターンの行動前): [対象タイブレーク] → [回復量ロール] → 縫い[基礎値→会心]', () => {
    const engine = buildEngine();
    // 同率2マス(累積/基準が同値)でタイブレークが発生する状況
    const state = engine.createStateFromSnapshot({
      recipeId: 'r',
      category: 'head',
      rows: 2,
      cols: 2,
      clothType: 'regen',
      cells: [
        { r: 1, c: 1, base: 100, cumulative: 50, shitsuke: false }, // ratio 0.5 同率
        { r: 1, c: 2, base: 200, cumulative: 100, shitsuke: false }, // ratio 0.5 同率
        { r: 2, c: 1, base: 100, cumulative: 10, shitsuke: false },
        { r: 2, c: 2, base: 100, cumulative: 10, shitsuke: false },
      ],
      powerCycle: ['normal'],
      concentration: 207,
      turn: 4, // 次=5ターン目で発動
    });
    // 再生布の回復は発動ターンの行動前(ターン開始側)で適用される(ARCHITECTURE A4 v1.1)。
    // 消費順: タイブレーク → 回復量 → 縫い[基礎値→会心] → 必殺 = 5
    const rng = new ScriptedRng([
      0.6, // タイブレーク nextInt(2)=1 → (1,2)
      0.3, // 回復量 nextInt(5)=1 → 13
      baseValueRoll(12), 0.9, // (2,1) を縫う: 累積10→22
      0.9, // 必殺
    ]);
    const { events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 2, c: 1 } },
      config,
      rng,
    );
    expect(rng.consumed()).toBe(5);
    expect(events.find((e) => e.kind === 'clothRegen')).toMatchObject({ r: 1, c: 2, amount: 13 });
  });
});

describe('T9 リプレイ再実行一致 (ARCHITECTURE A6)', () => {
  it('リプレイJSON(シード+設定+レシピid+行動列)から再実行して一致', () => {
    // リプレイ形式のシリアライズ→デシリアライズを挟んで一致を確認
    const replay = {
      seed: 987654321,
      config,
      recipeId: 'kentetsu_koromo_ue',
      actions: ACTIONS,
    };
    const json = JSON.stringify(replay);
    const restored = JSON.parse(json) as typeof replay;

    const run1 = playSession(replay.seed, replay.actions);
    const run2 = playSession(restored.seed, restored.actions);
    expect(run2.states).toEqual(run1.states);
    expect(run2.allEvents).toEqual(run1.allEvents);
    // 最終結果値のチェックサム相当(誤差合計)も一致
    const engine = buildEngine();
    const j1 = engine.judge(run1.states.at(-1)!);
    const j2 = engine.judge(run2.states.at(-1)!);
    expect(j2).toEqual(j1);
  });
});
