// ソルバー基盤モジュール6: モンテカルロ・ロールアウト (runRollout / rolloutSeed) のテスト

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, createRng, type GameState, type SimulatorConfig } from '../../src/core';
import { createSolverContext, pickGreedy, runRollout, rolloutSeed, type SolverContext } from '../../src/stats';
import { buildEngine, buildEngineData, loadRealRecipes, seededRng } from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

function makeCtx(): SolverContext {
  const engine = buildEngine();
  const data = buildEngineData();
  return createSolverContext(engine, data, config);
}

type CellOverride = { base?: number; cumulative?: number; shitsuke?: boolean };

/** 3×3の9マス盤面(massCount=9)。既定は base=100・累積0・集中207。 */
function grid3x3(
  ctx: SolverContext,
  stateOver: Record<string, unknown> = {},
  cellOver: (r: number, c: number) => CellOverride = () => ({}),
): GameState {
  const cells = [];
  for (let r = 1; r <= 3; r++) {
    for (let c = 1; c <= 3; c++) {
      cells.push({ r, c, base: 100, cumulative: 0, shitsuke: false, ...cellOver(r, c) });
    }
  }
  return ctx.engine.createStateFromSnapshot({
    recipeId: 'solver-rollout',
    category: 'test',
    rows: 3,
    cols: 3,
    cells,
    powerCycle: ['normal'],
    concentration: 207,
    turnStarted: true,
    currentPower: 'normal',
    hissatsuUsed: true,
    ...stateOver,
  });
}

describe('runRollout: 決定論', () => {
  it('同一 state・同一シードで2回呼んでも完全同一の結果', () => {
    const ctx = makeCtx();
    const state = grid3x3(ctx, { concentration: 207 }, (r, c) => (r === 1 && c === 1 ? { cumulative: 70 } : { cumulative: 100 }));
    const firstAction = pickGreedy(ctx, state).candidate.action;

    const r1 = runRollout(ctx, state, firstAction, createRng(12345));
    const r2 = runRollout(ctx, state, firstAction, createRng(12345));

    expect(r2).toEqual(r1);
  });
});

describe('runRollout: 終局性', () => {
  it.each([
    { label: '先頭レシピ', pick: (recipes: ReturnType<typeof loadRealRecipes>) => recipes[0] },
    { label: '9マスレシピ', pick: (recipes: ReturnType<typeof loadRealRecipes>) => recipes.find((r) => r.cells.length === 9)! },
  ])('$label: 先頭手(グリーディ1位)から100手以内に finished へ到達し concLeft>=0', ({ pick }) => {
    const engine = buildEngine();
    const data = buildEngineData();
    const ctx = createSolverContext(engine, data, config);
    const recipes = loadRealRecipes();
    const recipe = pick(recipes);

    const sessionRng = seededRng(1);
    const opened = engine.createSession(recipe, config, sessionRng);
    const begun = engine.beginTurn(opened.state, sessionRng);
    const state = begun.state;

    const firstAction = pickGreedy(ctx, state).candidate.action;
    const result = runRollout(ctx, state, firstAction, createRng(777));

    expect(result.actions).toBeLessThanOrEqual(100);
    expect(result.concLeft).toBeGreaterThanOrEqual(0);
  });
});

describe('runRollout: 全マス残り0 + firstAction=finish', () => {
  it('star3=true', () => {
    const ctx = makeCtx();
    const state = grid3x3(ctx, {}, () => ({ cumulative: 100 }));
    const result = runRollout(ctx, state, { type: 'finish' }, createRng(1));
    expect(result.star3).toBe(true);
    expect(result.actions).toBe(1);
  });
});

describe('rolloutSeed', () => {
  it('決定的: 同一引数から同一シード', () => {
    expect(rolloutSeed(0x5eed, 3, 7)).toBe(rolloutSeed(0x5eed, 3, 7));
  });

  it('(candidateIndex, sampleIndex)が異なれば原則衝突しない(数十組で確認)', () => {
    const seeds = new Set<number>();
    let total = 0;
    for (let candidateIndex = 0; candidateIndex < 8; candidateIndex++) {
      for (let sampleIndex = 0; sampleIndex < 10; sampleIndex++) {
        seeds.add(rolloutSeed(0x5eed, candidateIndex, sampleIndex));
        total += 1;
      }
    }
    expect(seeds.size).toBe(total);
  });
});
