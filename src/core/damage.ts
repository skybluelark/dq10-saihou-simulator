// ダメージ計算 (SPEC §3.2)
// 丸め = 正方向丸め (Math.ceil)、括弧を閉じるたびに適用。

import type { Power } from './data-types';

/** ぬいパワー係数 (SPEC §3.2)。？ は抽選済みの実効パワーで参照する。 */
export const POWER_COEFF: Record<Power, number> = {
  weak: 0.5,
  normal: 1,
  critx2: 1, // 会心×2 は係数1(ダメージ2倍は会心処理で別途)
  strong: 1.5,
  strongest: 2,
  unknown: 1, // 実効パワーに解決後は参照されない想定
};

/** 正方向の最も近い整数へ丸める(正の無限大方向 = Math.ceil)。 */
export function roundPositive(x: number): number {
  return Math.ceil(x);
}

/**
 * 縫い(糸ほぐし以外)の1マス基礎ダメージ。
 * ダメージ = ((基礎値 × 特技倍率) × ぬいパワー係数) × マス補正
 * 括弧を閉じるたびに丸める。
 *
 * @param baseValue 12〜18 の出目
 * @param skillMultiplier 特技倍率(かげん0.5, ぬう1, 2倍ぬい2 など)
 * @param power 実効ぬいパワー(？は解決済み)
 * @param cellCorrection マス補正(通常1, しつけ/光で2, 重複で4)
 */
export function sewDamage(
  baseValue: number,
  skillMultiplier: number,
  power: Power,
  cellCorrection: number,
): number {
  const a = roundPositive(baseValue * skillMultiplier);
  const b = roundPositive(a * POWER_COEFF[power]);
  const c = roundPositive(b * cellCorrection);
  return c;
}

/**
 * 糸ほぐし(負のダメージ)の1マス回復量(負値で返す)。
 * ダメージ = (基礎値 × ぬいパワー係数 × マス補正) ※基礎値が負(-6〜-9)
 * マス補正は括弧の内側。丸めは共通(ceil)。
 *
 * @param baseValue -6〜-9 の出目
 * @param power 実効ぬいパワー
 * @param cellCorrection マス補正
 */
export function hogushiDamage(
  baseValue: number,
  power: Power,
  cellCorrection: number,
): number {
  return roundPositive(baseValue * POWER_COEFF[power] * cellCorrection);
}
