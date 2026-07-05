// 会心率計算 (SPEC §3.4)
//
// 会心率 = ((基礎会心率+道具のできのよさ + コツ + スキル) × ねらい倍率 + 固定値上昇)
//          × 必殺補正 × シフト会心補正
//
// - ランダム会心は補正なし(randomCritMultiplier=1、仮定§6-3)
// - 必殺(無我)とシフトは併用で ×4

import type { GameParams } from './data-types';

export interface CritContext {
  needleCritRate: number; // 針テーブルの ★別値(基礎会心率+道具のできのよさ)
  kotsu: boolean; // コツ取得済み
  passiveCritUp: boolean; // パッシブ会心率アップ取得済み
  aim: boolean; // ねらいぬい
  rainbowCritTurn: boolean; // 虹布の会心ターン(+24%)
  lightGlowCell: boolean; // 光布の発光マス(+24%)
  mugaActive: boolean; // 無我の境地の×2が有効
  shiftCrit: boolean; // シフト会心ターン(×2)
}

/**
 * 会心率(0〜1)を算出する。critx2 パワー(会心確定)の扱いは呼び出し側。
 */
export function computeCritRate(params: GameParams, ctx: CritContext): number {
  const c = params.crit;

  let base = ctx.needleCritRate;
  if (ctx.kotsu) base += c.kotsuBonus;
  if (ctx.passiveCritUp) base += c.passiveEffective;

  const aimMul = ctx.aim ? c.aimMultiplier : 1;

  let fixed = 0;
  if (ctx.rainbowCritTurn) fixed += c.fixedBonus.rainbowCritTurn;
  if (ctx.lightGlowCell) fixed += c.fixedBonus.lightGlowCell;

  let rate = base * aimMul + fixed;

  if (ctx.mugaActive) rate *= c.hissatsuMultiplier;
  if (ctx.shiftCrit) rate *= c.shiftCritMultiplier;

  return rate;
}
