// T9(ARCHITECTURE A6): リプレイ形式モジュール core/replay の検証
// serialize → parse → runReplay の往復一致・チェックサム照合・不正入力の拒否。

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  makeReplayCheck,
  matchesReplayCheck,
  parseReplay,
  runReplay,
  serializeReplay,
  type Action,
  type ReplayData,
  type SimulatorConfig,
} from '../../src/core';
import { buildEngine, parseRealRecipes } from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'miracle', stars: 3 } };

const ACTIONS: Action[] = [
  { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
  { type: 'skill', skillId: 'midare_nui' },
  { type: 'sew', skillId: 'ito_hogushi', anchor: { r: 2, c: 2 } },
  { type: 'finish' },
];

function fixture() {
  const engine = buildEngine();
  const { recipes } = parseRealRecipes();
  const recipe = recipes.find((r) => r.id === 'kentetsu_koromo_ue')!; // 3×3 虹布
  const replay: ReplayData = {
    v: 1,
    seed: 20260707,
    recipeId: recipe.id,
    config,
    actions: ACTIONS,
  };
  return { engine, recipe, recipes, replay };
}

describe('T9 リプレイモジュール (A6)', () => {
  it('serialize → parse → runReplay で再実行が完全一致し、check も照合できる', () => {
    const { engine, recipe, replay } = fixture();
    const run1 = runReplay(engine, recipe, replay);
    const withCheck: ReplayData = {
      ...replay,
      check: makeReplayCheck(engine.judge(run1.final), run1.final),
    };
    const parsed = parseReplay(serializeReplay(withCheck));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.replay).toEqual(withCheck);
    const run2 = runReplay(engine, recipe, parsed.replay);
    expect(run2.states).toEqual(run1.states);
    expect(run2.allEvents).toEqual(run1.allEvents);
    expect(
      matchesReplayCheck(parsed.replay.check!, engine.judge(run2.final), run2.final),
    ).toBe(true);
  });

  it('check の不一致を検出する(★・誤差評価値・ターン数のいずれの差でも失敗)', () => {
    const { engine, recipe, replay } = fixture();
    const run = runReplay(engine, recipe, replay);
    const judge = engine.judge(run.final);
    const check = makeReplayCheck(judge, run.final);
    expect(matchesReplayCheck(check, judge, run.final)).toBe(true);
    expect(
      matchesReplayCheck({ ...check, totalError: check.totalError + 1 }, judge, run.final),
    ).toBe(false);
    expect(matchesReplayCheck({ ...check, turn: check.turn + 1 }, judge, run.final)).toBe(false);
    expect(
      matchesReplayCheck(
        { ...check, star: check.star === 'fail' ? 'star0' : 'fail' },
        judge,
        run.final,
      ),
    ).toBe(false);
  });

  it('parseReplay: 不正入力を拒否する', () => {
    const bad = (text: string): string => {
      const r = parseReplay(text);
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.error;
    };
    expect(bad('{')).toContain('JSON');
    expect(bad('123')).toContain('リプレイ形式');
    expect(bad(JSON.stringify({ v: 2, seed: 1, recipeId: 'x', config, actions: [] }))).toContain(
      'バージョン',
    );
    expect(bad(JSON.stringify({ v: 1, recipeId: 'x', config, actions: [] }))).toContain('seed');
    expect(bad(JSON.stringify({ v: 1, seed: 1, config, actions: [] }))).toContain('recipeId');
    expect(
      bad(JSON.stringify({ v: 1, seed: 1, recipeId: 'x', config: { level: 80 }, actions: [] })),
    ).toContain('config');
    expect(
      bad(JSON.stringify({ v: 1, seed: 1, recipeId: 'x', config, actions: [{ type: 'sew' }] })),
    ).toContain('actions');
    expect(
      bad(
        JSON.stringify({
          v: 1,
          seed: 1,
          recipeId: 'x',
          config,
          actions: [],
          check: { star: 'star9', totalError: 0, turn: 1 },
        }),
      ),
    ).toContain('check');
  });

  it('runReplay: レシピidの不一致はエラー', () => {
    const { engine, recipes, replay } = fixture();
    const other = recipes.find((r) => r.id !== replay.recipeId)!;
    expect(() => runReplay(engine, other, replay)).toThrow('レシピid');
  });
});
