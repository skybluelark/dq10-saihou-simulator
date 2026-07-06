// UI表示用の派生値計算。core のエクスポート(isTraitTurn / rainbowMode / targetPatterns)
// から導出する表示ロジックのみで、ゲーム状態遷移は含まない(依存方向 ui → core)。

import { clampAnchorForPattern, isTraitTurn, rainbowMode } from '../core';
import type { GameParams, GameState, SkillDef, SkillsFile, TurnEvent } from '../core';

// ---- ダメージ/回復バルーン(一時表示) ----

export type BalloonKind = 'damage' | 'crit' | 'heal';

export interface Balloon {
  id: number;
  r: number;
  c: number;
  text: string;
  kind: BalloonKind;
}

let balloonSeq = 0;

/**
 * TurnEvent列(sewCell/clothRegen)からマス上に一時表示するバルーンを生成する。
 * 複数マス特技(ヨコぬい・みだれぬい等)は各マスごとに1個生成される。
 */
export function deriveBalloons(events: TurnEvent[]): Balloon[] {
  const balloons: Balloon[] = [];
  for (const e of events) {
    if (e.kind === 'sewCell') {
      const isHeal = e.damage < 0;
      const kind: BalloonKind = isHeal ? 'heal' : e.crit ? 'crit' : 'damage';
      // 数値は符号なし・文字なし(「会心!」等は付けない)。配色のみで区別する(SPEC)。
      const text = `${Math.abs(e.damage)}`;
      balloons.push({ id: ++balloonSeq, r: e.r, c: e.c, text, kind });
    } else if (e.kind === 'clothRegen') {
      if (e.amount === 0) continue;
      balloons.push({ id: ++balloonSeq, r: e.r, c: e.c, text: `${Math.abs(e.amount)}`, kind: 'heal' });
    }
  }
  return balloons;
}

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

/**
 * アンカーから対象パターンで対象マスを解決(布内に存在するマスのみ。布外は無視)。
 * ライン系特技はコアと同じアンカー自動置換(clampAnchorForPattern)を適用するため、
 * プレビューは実行時(Engine.resolveTargets)と同一の対象範囲になる。
 * 対象0件(単マス特技で空き位置など)は空配列 = 実行不成立。
 */
export function resolveTargetCells(
  skills: SkillsFile,
  skill: SkillDef,
  anchor: { r: number; c: number },
  state: GameState,
): { r: number; c: number }[] {
  const pattern = skill.target;
  if (!pattern || pattern === 'random4') return [];
  const offsets = skills.targetPatterns[pattern] ?? [];
  const clamped = clampAnchorForPattern(pattern, offsets, anchor, state.rows, state.cols);
  return offsets
    .map(([dr, dc]) => ({ r: clamped.r + dr, c: clamped.c + dc }))
    .filter((t) => state.cells.some((cell) => cell.r === t.r && cell.c === t.c));
}

/** 次の布特性発動ターン(currentTurn 自身が発動ターンならそれを返す)。 */
export function nextTraitTurn(currentTurn: number, params: GameParams): number {
  const { firstTurn, interval } = params.clothTrait;
  if (currentTurn <= firstTurn) return firstTurn;
  const k = Math.ceil((currentTurn - firstTurn) / interval);
  return firstTurn + k * interval;
}
