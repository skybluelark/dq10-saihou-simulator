// anytime集計 (ソルバー基盤モジュール7)
//
// Wilson信頼区間・盤面キー(anytime合算/prior継承の照合キー)・racing(候補打ち切り)判定を提供する。

import type { GameState, SimulatorConfig } from '../core';
import type { RankedCandidate, SolverParams } from './types';

/** stateKeyOf に埋め込むソルバー版数(仕様・パラメータ解釈が変わったら上げる)。 */
// v2: ロールアウト既定ポリシーを pickGreedy→pickExpert に変更(旧版priorと混在させないため)。
// v3: エキスパートポリシーv2(調整フェーズを厳密DPスコアリングへ置換・精神統一ルール反転・
//     個別ルール修正。SOLVER_POLICY.md §10)。同一盤面でも選択順位が変わるため旧版priorとは
//     合算不可。
export const SOLVER_VERSION = 3;

/** Wilson score interval(95%既定)。n=0 は {lo:0, hi:1}。 */
export function wilson(n: number, wins: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const lo = (center - margin) / denom;
  const hi = (center + margin) / denom;
  return { lo: Math.max(0, lo), hi: Math.min(1, hi) };
}

/**
 * 盤面の決定的キー(anytime合算・prior継承の照合に使う)。
 * 判定に関わる明示フィールドのみを固定順で直列化する(state のフィールド追加に引きずられない)。
 */
export function stateKeyOf(state: GameState, config: SimulatorConfig, params: SolverParams): string {
  const cellsSorted = [...state.cells].sort((a, b) => a.r - b.r || a.c - b.c);
  const key = {
    v: SOLVER_VERSION,
    recipeId: state.recipeId,
    cells: cellsSorted.map((c) => ({
      r: c.r,
      c: c.c,
      base: c.base,
      cumulative: c.cumulative,
      shitsuke: c.shitsuke,
    })),
    massCount: state.massCount,
    errorLimit: state.errorLimit,
    powerCycle: state.powerCycle,
    cycleIndex: state.cycleIndex,
    turn: state.turn,
    concentration: state.concentration,
    currentPower: state.currentPower,
    lockPowerRemaining: state.lockPowerRemaining,
    lockedPower: state.lockedPower,
    lockedShiftCrit: state.lockedShiftCrit,
    forcedNextPower: state.forcedNextPower,
    shiftCritThisTurn: state.shiftCritThisTurn,
    randomCritThisTurn: state.randomCritThisTurn,
    hissatsuCharged: state.hissatsuCharged,
    hissatsuUsed: state.hissatsuUsed,
    mugaActive: state.mugaActive,
    concRecoveryUsed: state.concRecoveryUsed,
    glowCell: state.glowCell,
    clothType: state.clothType,
    config: {
      level: config.level,
      kotsu: config.kotsu,
      passives: { critUp: config.passives.critUp, hissatsuUp: config.passives.hissatsuUp },
      needle: { type: config.needle.type, stars: config.needle.stars },
    },
    params: {
      fineLimit: params.fineLimit,
      fineTarget: params.fineTarget,
      dpDepth: params.dpDepth,
      scheduleHorizon: params.scheduleHorizon,
      unknownCoeff: params.unknownCoeff,
      sigmoidScale: params.sigmoidScale,
      concPenalty: params.concPenalty,
      rMin: params.rMin,
      rMax: params.rMax,
    },
  };
  return JSON.stringify(key);
}

/**
 * racing判定: 首位(rate最大、同率は wilson.lo 最大)の wilson.lo 以上の wilson.hi を持つ候補
 * (自分含む)を active として返す。それ以外は呼び出し側で eliminated=true とする。
 */
export function activeCandidates(ranked: RankedCandidate[]): RankedCandidate[] {
  if (ranked.length === 0) return [];
  let leader = ranked[0];
  for (const r of ranked) {
    if (r.rate > leader.rate || (r.rate === leader.rate && r.ci.lo > leader.ci.lo)) {
      leader = r;
    }
  }
  const threshold = leader.ci.lo;
  return ranked.filter((r) => r.ci.hi >= threshold);
}
