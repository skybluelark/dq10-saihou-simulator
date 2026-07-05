// T12. beginTurn の公開API (M2: UIのターン開始表示用)
// - beginTurn→applyAction の順で呼んでも、applyAction 単独と
//   乱数消費・状態・イベントが完全一致すること(turnStarted ガード)
// - 開始済み状態への beginTurn は no-op(乱数消費なし)
// - beginTurn は入力状態を変更しない(イミュータブル)

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  Mulberry32,
  type Action,
  type GameState,
  type SimulatorConfig,
  type TurnEvent,
} from '../../src/core';
import { buildEngine, parseRealRecipes, ScriptedRng } from '../fixtures/engine-helpers';

// 光針(開幕チャージ抽選あり)+ 光布・？入りサイクルのレシピで、
// ターン開始時の乱数消費(？抽選・発光選定)が多発する条件にする。
const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'hikari', stars: 3 } };

function lightRecipe() {
  const { recipes } = parseRealRecipes();
  return recipes.find((r) => r.id === 'kyosho_turban')!; // 頭 2×2 光布・？×2サイクル
}

// 布特性ターン(5, 9)をまたぎ、支援・回復・みだれも含む行動列(しあげるは含めない。
// しあげるはターン開始処理を行わないため、単独実行との等価比較の対象外)
const ACTIONS: Action[] = [
  { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
  { type: 'sew', skillId: 'nibai_nui', anchor: { r: 2, c: 1 } },
  { type: 'skill', skillId: 'seishin_toitsu' },
  { type: 'sew', skillId: 'yoko_nui', anchor: { r: 1, c: 1 } },
  { type: 'sew', skillId: 'shitsuke_gake', anchor: { r: 2, c: 1 } },
  { type: 'sew', skillId: 'sanbai_nui', anchor: { r: 2, c: 1 } },
  { type: 'skill', skillId: 'power_shift' },
  { type: 'skill', skillId: 'midare_nui' },
  { type: 'sew', skillId: 'ito_hogushi', anchor: { r: 2, c: 1 } },
  { type: 'sew', skillId: 'taki_nobori', anchor: { r: 2, c: 2 } },
  { type: 'sew', skillId: 'nerai_nui', anchor: { r: 1, c: 2 } },
];

describe('T12 beginTurn 公開API', () => {
  it('beginTurn→applyAction が applyAction 単独と乱数消費・結果・イベントで完全一致', () => {
    for (const seed of [20260706, 1, 424242]) {
      // Run A: applyAction 単独(従来どおり)
      const engineA = buildEngine();
      const rngA = new Mulberry32(seed);
      let stateA = engineA.createSession(lightRecipe(), config, rngA).state;
      const statesA: GameState[] = [];
      const eventsA: TurnEvent[][] = [];
      const rngStatesA: number[] = [];
      for (const action of ACTIONS) {
        const res = engineA.applyAction(stateA, action, config, rngA);
        stateA = res.state;
        statesA.push(res.state);
        eventsA.push(res.events);
        rngStatesA.push(rngA.getState());
      }

      // Run B: beginTurn → applyAction(UIの呼び方)
      const engineB = buildEngine();
      const rngB = new Mulberry32(seed);
      let stateB = engineB.createSession(lightRecipe(), config, rngB).state;
      ACTIONS.forEach((action, i) => {
        const begun = engineB.beginTurn(stateB, rngB);
        const res = engineB.applyAction(begun.state, action, config, rngB);
        stateB = res.state;
        // 状態・乱数内部状態が一致
        expect(res.state).toEqual(statesA[i]);
        expect(rngB.getState()).toBe(rngStatesA[i]);
        // イベントは beginTurn 分 + applyAction 分の連結が単独実行と一致
        expect([...begun.events, ...res.events]).toEqual(eventsA[i]);
      });
    }
  });

  it('開始済み(turnStarted)状態への beginTurn は no-op で乱数を消費しない', () => {
    const engine = buildEngine();
    const rng = new Mulberry32(7);
    const { state } = engine.createSession(lightRecipe(), config, rng);
    const first = engine.beginTurn(state, rng);
    expect(first.state.turnStarted).toBe(true);
    expect(first.events.some((e) => e.kind === 'turnStart')).toBe(true);

    // 2回目: 乱数を一切消費せず、状態も変わらない
    const empty = new ScriptedRng([]); // 消費したら例外
    const second = engine.beginTurn(first.state, empty);
    expect(second.state).toEqual(first.state);
    expect(second.events).toEqual([]);
    expect(empty.consumed()).toBe(0);
  });

  it('beginTurn は入力状態を変更しない(finished 状態でも乱数を消費しない)', () => {
    const engine = buildEngine();
    const rng = new Mulberry32(99);
    const { state } = engine.createSession(lightRecipe(), config, rng);
    const snapshot = JSON.parse(JSON.stringify(state));
    engine.beginTurn(state, rng);
    expect(state).toEqual(snapshot);

    // finished 状態: 乱数消費なし・イベントなし
    const finished = engine.applyAction(state, { type: 'finish' }, config, rng).state;
    const empty = new ScriptedRng([]);
    const res = engine.beginTurn(finished, empty);
    expect(res.events).toEqual([]);
    expect(empty.consumed()).toBe(0);
    expect(res.state).toEqual(finished);
  });
});
