// モンテカルロ・ロールアウト (ソルバー基盤モジュール6)
//
// 1試行: firstAction を適用後、グリーディ(pickGreedy)で終局までプレイし結果を得る。
// 探索用乱数はセッション乱数と完全分離(呼び出し側が createRng で都度払い出す)。
// state は beginTurn 済み(turnStarted=true)を前提とする。

import type { Action, GameState, Rng, TurnEvent } from '../core';
import { pickGreedy } from './greedy';
import type { SolverContext } from './types';

/** 保険用の行動数上限(通常は列挙の性質上、この上限に達する前に finish が選ばれる想定)。 */
const MAX_ACTIONS = 100;

export interface RolloutResult {
  star3: boolean;
  totalError: number;
  concLeft: number;
  actions: number;
}

/**
 * 1試行分のロールアウトを実行する(ソルバー基盤モジュール6)。
 * firstAction 適用 → (未終了なら) beginTurn → pickGreedy → applyAction を終局まで繰り返す。
 */
export function runRollout(
  ctx: SolverContext,
  state: GameState,
  firstAction: Action,
  rng: Rng,
): RolloutResult {
  const { engine, config } = ctx;
  let current = state;
  let actions = 0;
  let lastEvents: TurnEvent[] = [];

  const apply = (action: Action): void => {
    const result = engine.applyAction(current, action, config, rng);
    current = result.state;
    lastEvents = result.events;
    actions += 1;
  };

  apply(firstAction);

  while (!current.finished) {
    // 保険: 行動数上限、または列挙漏れによる行動失敗イベントを検知したら finish で打ち切る
    // (通常は候補列挙で除外済みのため発生しない想定)。
    const insurance =
      actions >= MAX_ACTIONS ||
      lastEvents.some((e) => e.kind === 'insufficientConcentration' || e.kind === 'invalidTarget');
    if (insurance) {
      apply({ type: 'finish' });
      break;
    }

    const begun = engine.beginTurn(current, rng);
    current = begun.state;
    const picked = pickGreedy(ctx, current);
    apply(picked.candidate.action);
  }

  const j = engine.judge(current);
  return {
    star3: j.star === 'star3',
    totalError: j.totalError,
    concLeft: current.concentration,
    actions,
  };
}

/**
 * 候補番号・試行番号から決定的にロールアウトシードを導出する(32bit mix)。
 * 同一 (candidateIndex, sampleIndex) からは常に同一シードが得られる。
 */
export function rolloutSeed(baseSeed: number, candidateIndex: number, sampleIndex: number): number {
  let h = baseSeed ^ Math.imul(candidateIndex + 1, 0x9e3779b1) ^ Math.imul(sampleIndex + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}
