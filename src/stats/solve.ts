// solve統括 (ソルバー基盤モジュール9)
//
// Stage A(静的スコア)の上位 topK 候補にモンテカルロ・ロールアウトを重ね、
// Wilson信頼区間によるracing(劣位候補の打ち切り)で探索を効率化する。
// options.prior を渡すと同一盤面(stateKey一致)の集計を合算できる(anytime)。

import { createRng } from '../core';
import type { Action, GameState } from '../core';
import { activeCandidates, stateKeyOf, wilson } from './anytime';
import { scoreCandidates } from './evaluate';
import { rolloutSeed, runRollout } from './rollout';
import type { CandidateStats, RankedCandidate, SolveOptions, SolveResult, SolverContext } from './types';

/** 候補の対応付け用キー(Candidate.action の決定的シリアライズ)。 */
function actionKey(action: Action): string {
  switch (action.type) {
    case 'finish':
      return 'finish';
    case 'skill':
      return `skill:${action.skillId}`;
    case 'sew':
      return `sew:${action.skillId}:${action.anchor.r},${action.anchor.c}`;
  }
}

function recomputeRateCi(rc: RankedCandidate): void {
  rc.rate = rc.stats.n > 0 ? rc.stats.wins / rc.stats.n : 0;
  rc.ci = wilson(rc.stats.n, rc.stats.wins);
}

/** working配列の eliminated フラグを現在の rate/ci から再計算する。 */
function updateElimination(working: RankedCandidate[]): void {
  const active = new Set(activeCandidates(working));
  for (const rc of working) {
    rc.eliminated = !active.has(rc);
  }
}

/**
 * 候補の「波」番号: 0=まだ minSamples に達していない、k(≥1)=minSamples+k*batchSize まで
 * 到達済み。バッチは常に全量実行される(1試行中の中断は不要)ため、n は必ず
 * minSamples+j*batchSize(j≥0)のいずれかの値をとる前提で計算できる。
 * anytime合算で prior の n を引き継いでも、この波番号を揃えてから処理することで
 * 「同じ量の総ロールアウトなら呼び出しの分割位置によらず結果が一致する」を保証する
 * (呼び出しごとに毎回 candidate0 から処理し直すと、合算後の n が既に高い候補にだけ
 *  追加でバッチが積まれてしまい、一発実行と乖離するため)。
 */
function waveOf(n: number, minSamples: number, batchSize: number): number {
  if (n < minSamples) return 0;
  return 1 + Math.floor((n - minSamples) / batchSize);
}

function targetForWave(wave: number, minSamples: number, batchSize: number): number {
  return wave === 0 ? minSamples : minSamples + wave * batchSize;
}

/** 最終出力順: rate降順 → ci.lo降順 → 静的score降順 → scored.index昇順。 */
function finalSort(ranked: RankedCandidate[]): RankedCandidate[] {
  return [...ranked].sort((a, b) => {
    if (b.rate !== a.rate) return b.rate - a.rate;
    if (b.ci.lo !== a.ci.lo) return b.ci.lo - a.ci.lo;
    if (b.scored.score !== a.scored.score) return b.scored.score - a.scored.score;
    return a.scored.index - b.scored.index;
  });
}

/**
 * ソルバーのトップレベルAPI(ソルバー基盤モジュール9)。
 * state は beginTurn 済み(turnStarted=true)・未終了であること。
 */
export function solve(ctx: SolverContext, state: GameState, options: SolveOptions = {}): SolveResult {
  if (!state.turnStarted) {
    throw new Error('solve: state は beginTurn 済みである必要があります。');
  }
  if (state.finished) {
    throw new Error('solve: 終了済みの state は扱えません。');
  }

  const {
    timeBudgetMs = 1000,
    maxRollouts = Infinity,
    topK = 8,
    minSamples = 30,
    batchSize = 25,
    baseSeed = 0x5eed,
    prior,
  } = options;

  const startedAt = Date.now();
  const stateKey = stateKeyOf(state, ctx.config, ctx.params);
  const scored = scoreCandidates(ctx, state);

  // 確定ショートカット: finish の静的scoreが1(=現盤面が★3)ならロールアウト不要。
  const finishScored = scored.find((s) => s.candidate.action.type === 'finish');
  if (finishScored && finishScored.score === 1) {
    const ranked: RankedCandidate[] = scored.map((s) => {
      const isFinish = s.candidate.action.type === 'finish';
      return {
        scored: s,
        stats: { n: 0, wins: 0, sumErr: 0, sumConc: 0 },
        rate: isFinish ? 1 : 0,
        ci: isFinish ? { lo: 1, hi: 1 } : { lo: 0, hi: 1 },
        eliminated: false,
      };
    });
    return {
      stateKey,
      ranked,
      totalRollouts: 0,
      elapsedMs: Date.now() - startedAt,
      certain: true,
    };
  }

  const topScored = scored.slice(0, topK);

  const priorMap = new Map<string, RankedCandidate>();
  if (prior && prior.stateKey === stateKey) {
    for (const rc of prior.ranked) {
      priorMap.set(actionKey(rc.scored.candidate.action), rc);
    }
  }

  const working: RankedCandidate[] = topScored.map((s) => {
    const priorRc = priorMap.get(actionKey(s.candidate.action));
    const stats: CandidateStats = priorRc
      ? { ...priorRc.stats }
      : { n: 0, wins: 0, sumErr: 0, sumConc: 0 };
    const rc: RankedCandidate = {
      scored: s,
      stats,
      rate: stats.n > 0 ? stats.wins / stats.n : 0,
      ci: wilson(stats.n, stats.wins),
      eliminated: false,
    };
    return rc;
  });
  updateElimination(working);

  let rolloutsThisCall = 0;
  const withinBudget = (): boolean =>
    rolloutsThisCall < maxRollouts && Date.now() - startedAt < timeBudgetMs;

  roundLoop: while (withinBudget()) {
    const active = working.filter((rc) => !rc.eliminated);
    if (active.length <= 1) break;

    // このスイープの目標値 = 現在最も遅れている候補の波に揃える(全員同じ波まで追いつかせる)。
    // 既に先の波へ進んでいる候補(anytime合算でnが高い状態を引き継いだ候補)はスキップする。
    const minWave = Math.min(...active.map((rc) => waveOf(rc.stats.n, minSamples, batchSize)));
    const roundTarget = targetForWave(minWave, minSamples, batchSize);

    for (const rc of active) {
      // 候補ごとのバッチ間で期限チェック(1試行中の中断は不要)
      if (!withinBudget()) break roundLoop;
      if (rc.stats.n >= roundTarget) continue; // 既にこのスイープの目標に到達済み

      while (rc.stats.n < roundTarget) {
        const rng = createRng(rolloutSeed(baseSeed, rc.scored.index, rc.stats.n));
        const result = runRollout(ctx, state, rc.scored.candidate.action, rng);
        rc.stats.n += 1;
        if (result.star3) rc.stats.wins += 1;
        rc.stats.sumErr += result.totalError;
        rc.stats.sumConc += result.concLeft;
        rolloutsThisCall += 1;
      }
      recomputeRateCi(rc);
    }

    updateElimination(working);
  }

  updateElimination(working); // 打ち切り時点でも最終的な整合性を保証する

  const ranked = finalSort(working);
  const totalRollouts = ranked.reduce((sum, rc) => sum + rc.stats.n, 0);

  return {
    stateKey,
    ranked,
    totalRollouts,
    elapsedMs: Date.now() - startedAt,
    certain: false,
  };
}
