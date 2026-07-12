// 公称プラン (ソルバー基盤モジュール8)
//
// 「中央値決め打ち」の乱数(NominalRng)でグリーディを終局まで回し、乱数依存性の低い
// 目安の行動列(公称プラン)を作る。乱数依存特技(みだれぬい・ぬいパワーシフト・無我の境地)
// は2手目以降の選択から除外する(結果が乱数の偏りに左右されやすいため)。

import type { Action, Engine, GameState, Rng } from '../core';
import { scoreCandidates } from './evaluate';
import type { NominalPlan, PlanStep, ScoredCandidate, SolverContext } from './types';

/**
 * 公称乱数: 中央値決め打ち。
 * next()=0.9(確率90%未満のイベントは発生しない)、nextInt(n)=floor((n-1)/2)(中央値)。
 */
export class NominalRng implements Rng {
  next(): number {
    return 0.9;
  }
  nextInt(max: number): number {
    return Math.floor((max - 1) / 2);
  }
  getState(): number {
    return 0;
  }
}

/** みだれぬい・ぬいパワーシフト・無我の境地(乱数依存の大きい特技)を除外する。 */
function isNominalEligible(engine: Engine, scored: ScoredCandidate): boolean {
  const { candidate } = scored;
  if (candidate.action.type === 'finish') return true;
  const skill = engine.listSkills().find((s) => s.id === candidate.skillId);
  if (!skill) return true;
  if (skill.kind === 'sew' && skill.target === 'random4') return false; // みだれぬい
  if (skill.kind === 'hissatsu') return false; // 無我の境地
  if (skill.effect === 'shiftPower') return false; // ぬいパワーシフト
  return true;
}

/** 保険用の手数上限。到達しなければ reachedFinish=false でその時点の盤面を返す。 */
const MAX_STEPS = 100;

/**
 * 公称プラン: firstAction を適用後、乱数依存特技を除いたグリーディを NominalRng で
 * 終局まで回した行動列を返す(ソルバー基盤モジュール8)。
 * firstAction 自体は除外判定の対象外(そのまま適用する)。
 */
export function nominalPlan(ctx: SolverContext, state: GameState, firstAction: Action): NominalPlan {
  const { engine, config } = ctx;
  const rng = new NominalRng();
  const steps: PlanStep[] = [];
  let current = state;

  const applyStep = (action: Action, skillId: string | null): void => {
    const turn = current.turn + 1;
    const power = current.currentPower;
    const result = engine.applyAction(current, action, config, rng);
    current = result.state;
    steps.push({
      turn,
      power,
      action,
      skillId,
      concAfter: current.concentration,
      cells: current.cells.map((c) => ({ r: c.r, c: c.c, remaining: c.base - c.cumulative })),
    });
  };

  const firstSkillId = firstAction.type === 'sew' || firstAction.type === 'skill' ? firstAction.skillId : null;
  applyStep(firstAction, firstSkillId);

  let iterations = 1;
  while (!current.finished && iterations < MAX_STEPS) {
    const begun = engine.beginTurn(current, rng);
    current = begun.state;

    const scored = scoreCandidates(ctx, current);
    const filtered = scored.filter((s) => isNominalEligible(engine, s));
    const picked = filtered[0] ?? scored[0];

    applyStep(picked.candidate.action, picked.candidate.skillId);
    iterations += 1;
  }

  const j = engine.judge(current);
  return {
    steps,
    star: j.star,
    totalError: j.totalError,
    reachedFinish: current.finished,
  };
}
