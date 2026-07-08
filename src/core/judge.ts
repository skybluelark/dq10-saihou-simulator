// できのよさ判定 (SPEC §3.7)

import type { EvaluationBoundary, GameParams, Star } from './data-types';
import type { GameState, JudgeResult } from './types';

/**
 * マス誤差の評価値:
 *   誤差≤4 → 誤差 / 5≤誤差<9 → 9 / 誤差≥9 → 誤差
 * (黄色ゲージ=基準値±4 の外にあれば 9 未満でも 9 として扱う)
 */
export function cellErrorScore(remaining: number, yellowRange: number, penaltyError: number): number {
  const err = Math.abs(remaining);
  if (err <= yellowRange) return err;
  if (err < penaltyError) return penaltyError;
  return err;
}

/** GameState からできのよさを判定する。 */
export function judge(state: GameState, params: GameParams): JudgeResult {
  const yellow = params.gauge.yellowRange;
  const penalty = params.gauge.penaltyError;

  let total = 0;
  let raw = 0;
  for (const cell of state.cells) {
    const remaining = cell.base - cell.cumulative;
    raw += Math.abs(remaining);
    total += cellErrorScore(remaining, yellow, penalty);
  }

  const star = starForError(total, state.massCount, state.errorLimit, params);
  return { star, totalError: total, rawTotalError: raw };
}

/**
 * マス数・誤差制限フラグから評価境界を選ぶ(SPEC §3.7)。
 * errorLimit=true の場合は evaluationRestricted を優先するが、そのマス数が
 * 定義されていない場合(7マス=ぬいぐるみ)は evaluation にフォールバックする。
 */
export function boundsFor(massCount: number, errorLimit: boolean, params: GameParams): EvaluationBoundary {
  const restricted = errorLimit ? params.evaluationRestricted[String(massCount)] : undefined;
  const b = restricted ?? params.evaluation[String(massCount)];
  if (!b) throw new Error(`evaluation 境界が未定義: massCount=${massCount}`);
  return b;
}

/** 誤差合計・マス数・誤差制限フラグから評価(★)を決める。 */
export function starForError(total: number, massCount: number, errorLimit: boolean, params: GameParams): Star {
  const b = boundsFor(massCount, errorLimit, params);
  if (total <= b.star3) return 'star3';
  if (total <= b.star2) return 'star2';
  if (total <= b.star1) return 'star1';
  if (total <= b.star0) return 'star0';
  return 'fail';
}
