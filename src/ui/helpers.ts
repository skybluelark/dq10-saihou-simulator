// UI表示用の派生値計算。core のエクスポート(isTraitTurn / rainbowMode / targetPatterns)
// から導出する表示ロジックのみで、ゲーム状態遷移は含まない(依存方向 ui → core)。

import { isTraitTurn, rainbowMode } from '../core';
import type { GameParams, GameState, SkillDef, SkillsFile } from '../core';

/** 対象マス不要でボタン押下のみで即実行する特技か(精神統一・シフト・みだれ・無我)。 */
export function isTargetless(skill: SkillDef): boolean {
  if (skill.kind === 'hissatsu') return true;
  if (skill.target === 'random4') return true; // みだれぬい
  if (skill.kind === 'support') return skill.effect !== 'cellCorrection'; // しつけがけ以外
  return false;
}

/**
 * 当ターンの表示用消費集中力。虹布の発動ターンは補正後コスト
 * (Engine.effectiveCost と同じ式。半減/1.5倍・端数切り上げ)。
 */
export function displayCost(skill: SkillDef, state: GameState, params: GameParams): number {
  if (skill.kind === 'hissatsu') return 0;
  const base = skill.cost ?? 0;
  if (state.clothType !== 'rainbow') return base;
  const turnNo = state.turn + 1; // 進行中ターン
  if (!isTraitTurn(turnNo, params)) return base;
  const factor =
    rainbowMode(turnNo, params) === 'half' ? 0.5 : params.clothTrait.rainbowCostUpFactor;
  return Math.ceil(base * factor);
}

/** アンカーから対象パターンで対象マスを解決(布内に存在するマスのみ。布外は無視)。 */
export function resolveTargetCells(
  skills: SkillsFile,
  skill: SkillDef,
  anchor: { r: number; c: number },
  state: GameState,
): { r: number; c: number }[] {
  const pattern = skill.target;
  if (!pattern || pattern === 'random4') return [];
  const offsets = skills.targetPatterns[pattern] ?? [];
  return offsets
    .map(([dr, dc]) => ({ r: anchor.r + dr, c: anchor.c + dc }))
    .filter((t) => state.cells.some((cell) => cell.r === t.r && cell.c === t.c));
}

/** 次の布特性発動ターン(currentTurn 自身が発動ターンならそれを返す)。 */
export function nextTraitTurn(currentTurn: number, params: GameParams): number {
  const { firstTurn, interval } = params.clothTrait;
  if (currentTurn <= firstTurn) return firstTurn;
  const k = Math.ceil((currentTurn - firstTurn) / interval);
  return firstTurn + k * interval;
}
