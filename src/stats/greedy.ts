// 1手グリーディ選択 (ソルバー基盤モジュール5)
//
// scoreCandidates の先頭(score最大、タイブレーク済み)を返すだけの薄いラッパ。
// ロールアウトから毎ターン呼ばれる想定のためホットパス: 候補の再列挙・テーブルの
// 再構築は行わない(テーブルは ctx.tables を使い回す)。

import type { GameState } from '../core';
import { scoreCandidates } from './evaluate';
import type { ScoredCandidate, SolverContext } from './types';

/** 現在の盤面で最も score の高い候補を1つ選ぶ。 */
export function pickGreedy(ctx: SolverContext, state: GameState): ScoredCandidate {
  const scored = scoreCandidates(ctx, state);
  return scored[0];
}
