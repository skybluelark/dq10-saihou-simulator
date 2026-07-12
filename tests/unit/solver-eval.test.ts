// ソルバー基盤モジュール3/4/5: 仕上げテーブル・静的評価・1手グリーディ選択のテスト

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameState, type SimulatorConfig } from '../../src/core';
import {
  createSolverContext,
  evaluateState,
  lookupFinish,
  pickGreedy,
  scoreCandidates,
  type SolverContext,
} from '../../src/stats';
import { buildEngine, buildEngineData } from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

function makeCtx(): SolverContext {
  const engine = buildEngine();
  const data = buildEngineData();
  return createSolverContext(engine, data, config);
}

type CellOverride = { base?: number; cumulative?: number; shitsuke?: boolean };

/** 3×3の9マス盤面(massCount=9、評価境界 star3=8)。既定は base=100・累積0・集中207。 */
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
    recipeId: 'solver-eval',
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

describe('finishing: 仕上げテーブルの妥当性', () => {
  it('r=0: expErr=0・conc=0(放置が最適)', () => {
    const ctx = makeCtx();
    const entry = lookupFinish(ctx, 0, 1, 0);
    expect(entry.expErr).toBe(0);
    expect(entry.conc).toBe(0);
  });

  it('r=3: 弱パワー等の縫いで改善できるため expErr < 3', () => {
    const ctx = makeCtx();
    const entry = lookupFinish(ctx, 3, 1, 0);
    expect(entry.expErr).toBeLessThan(3);
  });

  it('r=-5: 糸ほぐしで改善できるため expErr < 9', () => {
    const ctx = makeCtx();
    const entry = lookupFinish(ctx, -5, 1, 0);
    expect(entry.expErr).toBeLessThan(9);
  });

  it('r=1..4: 放置が常に選べるため悪化しない(expErr <= r)', () => {
    const ctx = makeCtx();
    for (let r = 1; r <= 4; r++) {
      const entry = lookupFinish(ctx, r, 1, 0);
      expect(entry.expErr).toBeLessThanOrEqual(r);
    }
  });
});

describe('finishing: 変種(muga/correction)の違い', () => {
  it('muga=1のテーブルはmuga=0と異なる(会心率上昇の影響)', () => {
    const ctx = makeCtx();
    const withoutMuga = lookupFinish(ctx, 10, 1, 0);
    const withMuga = lookupFinish(ctx, 10, 1, 1);
    expect(withMuga.expErr).not.toBe(withoutMuga.expErr);
  });

  it('correction=2のテーブルはcorrection=1と異なる', () => {
    const ctx = makeCtx();
    const normal = lookupFinish(ctx, 10, 1, 0);
    const shitsuke = lookupFinish(ctx, 10, 2, 0);
    expect(shitsuke.expErr).not.toBe(normal.expErr);
  });
});

describe('evaluateState', () => {
  it('全マス残り0の盤面はマージン=★3境界となりvが高い(>0.8)', () => {
    const ctx = makeCtx();
    const state = grid3x3(ctx, {}, () => ({ cumulative: 100 })); // 残り0
    const result = evaluateState(ctx, state);
    expect(result.totalErr).toBe(0);
    expect(result.v).toBeGreaterThan(0.8);
  });

  it('残りが大きい盤面よりvが高い', () => {
    const ctx = makeCtx();
    const zeroState = grid3x3(ctx, {}, () => ({ cumulative: 100 })); // 残り0
    const farState = grid3x3(ctx, {}, () => ({ cumulative: 40 })); // 残り60(削り工程)
    const zeroResult = evaluateState(ctx, zeroState);
    const farResult = evaluateState(ctx, farState);
    expect(zeroResult.v).toBeGreaterThan(farResult.v);
  });
});

describe('scoreCandidates: finish判定', () => {
  it('全マス残り0ならscoreCandidates先頭がfinish(score=1)', () => {
    const ctx = makeCtx();
    const state = grid3x3(ctx, {}, () => ({ cumulative: 100 }));
    const scored = scoreCandidates(ctx, state);
    expect(scored[0].candidate.action).toEqual({ type: 'finish' });
    expect(scored[0].score).toBe(1);
  });

  it('誤差評価値合計が★3境界ちょうどの盤面でもfinishがscore=1', () => {
    const ctx = makeCtx();
    // massCount=9 の star3 境界=8。黄色ゲージ内(残り4)のマスを2つ、他7マスは残り0 → totalError=4+4=8(境界ちょうど)
    const state = grid3x3(ctx, {}, (r, c) =>
      (r === 1 && c === 1) || (r === 1 && c === 2) ? { cumulative: 96 } : { cumulative: 100 },
    );
    const j = ctx.engine.judge(state);
    expect(j.totalError).toBe(8);
    expect(j.star).toBe('star3');

    const scored = scoreCandidates(ctx, state);
    const finish = scored.find((s) => s.candidate.action.type === 'finish')!;
    expect(finish.score).toBe(1);
  });

  it('★3を外れる盤面ではfinishのscoreは0', () => {
    const ctx = makeCtx();
    const state = grid3x3(ctx); // 全マス残り100(誤差評価値9×9=81 > star0=49)
    const scored = scoreCandidates(ctx, state);
    const finish = scored.find((s) => s.candidate.action.type === 'finish')!;
    expect(finish.score).toBe(0);
  });
});

describe('pickGreedy: 挙動', () => {
  it('1マス残り30・集中力207・cycle=[normal]ではfinishではなく縫い系を選ぶ', () => {
    const ctx = makeCtx();
    const state = grid3x3(
      ctx,
      { concentration: 207 },
      (r, c) => (r === 1 && c === 1 ? { cumulative: 70 } : { cumulative: 100 }), // (1,1)のみ残り30
    );
    const picked = pickGreedy(ctx, state);
    expect(picked.candidate.action.type).not.toBe('finish');
    const skill = ctx.engine.listSkills().find((s) => s.id === picked.candidate.skillId);
    expect(skill?.kind).toBe('sew');
  });

  it('全マス残り0ならfinishを選ぶ', () => {
    const ctx = makeCtx();
    const state = grid3x3(ctx, {}, () => ({ cumulative: 100 }));
    const picked = pickGreedy(ctx, state);
    expect(picked.candidate.action).toEqual({ type: 'finish' });
  });
});

describe('scoreCandidates: 決定論', () => {
  it('同一入力で2回呼んでも同一結果', () => {
    const ctx = makeCtx();
    const state = grid3x3(ctx, {}, (r, c) => (r === 1 && c === 1 ? { cumulative: 70 } : { cumulative: 100 }));
    const s1 = scoreCandidates(ctx, state);
    const s2 = scoreCandidates(ctx, state);
    expect(s2).toEqual(s1);
  });
});
