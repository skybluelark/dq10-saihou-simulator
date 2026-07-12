// ソルバー基盤モジュール7〜9: anytime集計・公称プラン・solve統括のテスト

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameState, type SimulatorConfig } from '../../src/core';
import {
  activeCandidates,
  createSolverContext,
  nominalPlan,
  pickGreedy,
  solve,
  wilson,
  type SolverContext,
} from '../../src/stats';
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
    recipeId: 'solver-solve',
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

/** 1マスのみ残り30・他8マスは残り0の盤面(候補分岐がありつつロールアウトが短く済む)。 */
function partialBoard(ctx: SolverContext): GameState {
  return grid3x3(ctx, { concentration: 207 }, (r, c) => (r === 1 && c === 1 ? { cumulative: 70 } : { cumulative: 100 }));
}

describe('solve: 事前条件', () => {
  it('beginTurn 前の state は Error', () => {
    const ctx = makeCtx();
    const state = grid3x3(ctx, { turnStarted: false });
    expect(() => solve(ctx, state)).toThrow();
  });

  it('finished な state は Error', () => {
    const ctx = makeCtx();
    const state = grid3x3(ctx);
    const finished = ctx.engine.applyAction(state, { type: 'finish' }, config, seededRng(1)).state;
    expect(() => solve(ctx, finished)).toThrow();
  });
});

describe('solve: 確定ショートカット', () => {
  it('全マス残り0 → certain=true、先頭がfinish、rate=1', () => {
    const ctx = makeCtx();
    const state = grid3x3(ctx, {}, () => ({ cumulative: 100 }));
    const result = solve(ctx, state);
    expect(result.certain).toBe(true);
    expect(result.ranked[0].scored.candidate.action).toEqual({ type: 'finish' });
    expect(result.ranked[0].rate).toBe(1);
  });
});

describe('solve: 決定論', () => {
  it('同一入力・同一optionsで2回呼んでも ranked の順序・stats が完全一致', () => {
    const ctx = makeCtx();
    const state = partialBoard(ctx);
    const options = { maxRollouts: 60, timeBudgetMs: 60000 };
    const r1 = solve(ctx, state, options);
    const r2 = solve(ctx, state, options);

    expect(r2.ranked.map((rc) => rc.scored.candidate)).toEqual(r1.ranked.map((rc) => rc.scored.candidate));
    expect(r2.ranked.map((rc) => rc.stats)).toEqual(r1.ranked.map((rc) => rc.stats));
    expect(r2.totalRollouts).toBe(r1.totalRollouts);
  });
});

describe('solve: anytime合算', () => {
  it('maxRollouts=30を2回(prior継承)した結果が、maxRollouts=60一発実行と完全一致', () => {
    const ctx = makeCtx();
    const state = partialBoard(ctx);

    const first = solve(ctx, state, { maxRollouts: 30, timeBudgetMs: 60000 });
    const combined = solve(ctx, state, { maxRollouts: 30, timeBudgetMs: 60000, prior: first });
    const oneShot = solve(ctx, state, { maxRollouts: 60, timeBudgetMs: 60000 });

    expect(combined.totalRollouts).toBe(oneShot.totalRollouts);
    expect(combined.ranked.map((rc) => rc.scored.candidate)).toEqual(oneShot.ranked.map((rc) => rc.scored.candidate));
    expect(combined.ranked.map((rc) => rc.stats)).toEqual(oneShot.ranked.map((rc) => rc.stats));
  });
});

describe('wilson', () => {
  it('n=0 → {lo:0, hi:1}', () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it('wilson(100,50): lo≈0.40, hi≈0.60、lo<rate<hi', () => {
    const { lo, hi } = wilson(100, 50);
    expect(lo).toBeCloseTo(0.4, 1);
    expect(hi).toBeCloseTo(0.6, 1);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });
});

describe('racing: eliminated整合性', () => {
  it('eliminated=true の候補は active集合の条件を満たさない', () => {
    const ctx = makeCtx();
    const state = partialBoard(ctx);
    const result = solve(ctx, state, { maxRollouts: 60, timeBudgetMs: 60000 });

    const active = new Set(activeCandidates(result.ranked));
    for (const rc of result.ranked) {
      if (rc.eliminated) {
        expect(active.has(rc)).toBe(false);
      } else {
        expect(active.has(rc)).toBe(true);
      }
    }
  });
});

describe('nominalPlan', () => {
  it('実レシピ開始状態+グリーディ1位の手 → reachedFinish・末尾finish・100手未満・決定論・乱数依存特技を含まない', () => {
    const engine = buildEngine();
    const data = buildEngineData();
    const ctx = createSolverContext(engine, data, config);
    const recipes = loadRealRecipes();
    const recipe = recipes[0];

    const sessionRng = seededRng(1);
    const opened = engine.createSession(recipe, config, sessionRng);
    const begun = engine.beginTurn(opened.state, sessionRng);
    const state = begun.state;
    const firstAction = pickGreedy(ctx, state).candidate.action;

    const plan1 = nominalPlan(ctx, state, firstAction);
    const plan2 = nominalPlan(ctx, state, firstAction);

    expect(plan1.reachedFinish).toBe(true);
    expect(plan1.steps[plan1.steps.length - 1].action).toEqual({ type: 'finish' });
    expect(plan1.steps.length).toBeLessThan(100);
    expect(plan2).toEqual(plan1);

    const excludedIds = new Set(
      engine
        .listSkills()
        .filter((s) => (s.kind === 'sew' && s.target === 'random4') || s.kind === 'hissatsu' || s.effect === 'shiftPower')
        .map((s) => s.id),
    );
    for (const step of plan1.steps.slice(1)) {
      if (step.skillId) expect(excludedIds.has(step.skillId)).toBe(false);
    }
  });
});

describe('solve: 性能計測(実レシピ9マス)', () => {
  it('timeBudgetMs=1000でtotalRolloutsを計測する', () => {
    const engine = buildEngine();
    const data = buildEngineData();
    const ctx = createSolverContext(engine, data, config);
    const recipes = loadRealRecipes();
    const recipe = recipes.find((r) => r.cells.length === 9)!;

    const sessionRng = seededRng(1);
    const opened = engine.createSession(recipe, config, sessionRng);
    const begun = engine.beginTurn(opened.state, sessionRng);
    const state = begun.state;

    const result = solve(ctx, state, { timeBudgetMs: 1000 });
    console.log(`[solve perf] totalRollouts=${result.totalRollouts} elapsedMs=${result.elapsedMs}`);
    expect(result.totalRollouts).toBeGreaterThanOrEqual(50);
  });
});
