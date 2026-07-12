// 静的評価関数 V(state) と候補スコアリング (ソルバー基盤モジュール4)
//
// 仕上げテーブル(finishing.ts)を用いて盤面の期待誤差評価値合計・所要集中力を見積もり、
// ★3到達確率の近似値 v(マージンのシグモイド − 集中力不足ペナルティ)を算出する。
// 候補ごとに v を求め、finish は judge の実測値をそのまま使う(常に厳密)。

import { POWER_COEFF, boundsFor } from '../core';
import type { GameState, Power } from '../core';
import { enumerateCandidates } from './actions';
import { actionDistribution } from './distribution';
import { lookupFinish } from './finishing';
import type { Candidate, CellPmf, FinishEntry, ScoredCandidate, SolverContext } from './types';

/** ぬいパワーシフトの抽選候補(現在パワーを除く4種を等確率で評価する)。 */
const SHIFT_CANDIDATES: Power[] = ['weak', 'normal', 'strong', 'strongest', 'critx2'];

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** avgCoeff 計算用の仮想パワースケジュール。lockPower/shiftPower候補の評価で差し替える。 */
interface ScheduleState {
  lockPowerRemaining: number;
  lockedPower: Power | null;
  forcedNextPower: Power | null;
  cycleIndex: number;
  powerCycle: Power[];
}

function scheduleFromState(state: GameState): ScheduleState {
  return {
    lockPowerRemaining: state.lockPowerRemaining,
    lockedPower: state.lockedPower,
    forcedNextPower: state.forcedNextPower,
    cycleIndex: state.cycleIndex,
    powerCycle: state.powerCycle,
  };
}

/** 実効パワー係数('？'=unknownCoeff、会心×2=1)。 */
function coeffFor(ctx: SolverContext, power: Power): number {
  if (power === 'unknown') return ctx.params.unknownCoeff;
  if (power === 'critx2') return 1;
  return POWER_COEFF[power];
}

/** 今後 scheduleHorizon ターンの実効パワー係数の平均。 */
function avgCoeff(ctx: SolverContext, schedule: ScheduleState): number {
  const horizon = ctx.params.scheduleHorizon;
  let remainingLock = schedule.lockPowerRemaining;
  let forcedPending = schedule.forcedNextPower !== null;
  const forced = schedule.forcedNextPower;
  let cycleIdx = schedule.cycleIndex;
  const cycle = schedule.powerCycle;

  let sum = 0;
  for (let t = 0; t < horizon; t++) {
    let power: Power;
    if (remainingLock > 0) {
      power = schedule.lockedPower ?? 'normal';
      remainingLock -= 1;
    } else if (forcedPending) {
      power = forced!;
      forcedPending = false;
    } else {
      power = cycle.length > 0 ? cycle[cycleIdx % cycle.length] : 'normal';
      if (cycle.length > 0) cycleIdx = (cycleIdx + 1) % cycle.length;
    }
    sum += coeffFor(ctx, power);
  }
  return sum / horizon;
}

/** 削り工程(r > fineLimit)の合成値。仕上げテーブル r=8..16 の平均に削り分の見積もりを加える。 */
function roughCompose(ctx: SolverContext, r: number, muga: 0 | 1, schedule: ScheduleState): FinishEntry {
  const { data, config, params } = ctx;
  const sewSkills = data.skills.skills.filter(
    (s) => s.kind === 'sew' && s.target === 'single' && (s.learnLv === undefined || s.learnLv <= config.level),
  );
  let maxSkill = sewSkills[0];
  for (const s of sewSkills) {
    if ((s.multiplier ?? 0) > (maxSkill?.multiplier ?? 0)) maxSkill = s;
  }
  const Mmax = maxSkill?.multiplier ?? 1;
  const bigCost = maxSkill?.cost ?? 0;

  const coeff = avgCoeff(ctx, schedule);
  const bigAvg = 15 * Mmax * coeff; // 基礎値平均15
  const kBig = bigAvg > 0 ? Math.max(0, Math.ceil((r - params.fineTarget) / bigAvg)) : 0;

  const lo = 8;
  const hi = 16;
  let sumErr = 0;
  let sumAct = 0;
  let sumConc = 0;
  for (let rr = lo; rr <= hi; rr++) {
    const e = lookupFinish(ctx, rr, 1, muga);
    sumErr += e.expErr;
    sumAct += e.actions;
    sumConc += e.conc;
  }
  const n = hi - lo + 1;

  return {
    expErr: sumErr / n,
    actions: kBig + sumAct / n,
    conc: kBig * bigCost + sumConc / n,
  };
}

/** マス1つ分の期待値(仕上げテーブル参照 or 削り合成)。 */
function cellValue(
  ctx: SolverContext,
  r: number,
  correction: 1 | 2,
  muga: 0 | 1,
  schedule: ScheduleState,
): { expErr: number; conc: number } {
  if (r <= ctx.params.fineLimit) {
    const e = lookupFinish(ctx, r, correction, muga);
    return { expErr: e.expErr, conc: e.conc };
  }
  const e = roughCompose(ctx, r, muga, schedule);
  return { expErr: e.expErr, conc: e.conc };
}

/**
 * 盤面全マスの totalErr・concNeed を積算する。
 * forceCorrection2 が指定されたマスは(shitsuke の状態によらず)correction=2 で評価する
 * (しつけがけ候補の評価用)。
 */
function accumulate(
  ctx: SolverContext,
  state: GameState,
  schedule: ScheduleState,
  muga: 0 | 1,
  forceCorrection2?: { r: number; c: number },
): { totalErr: number; concNeed: number } {
  let totalErr = 0;
  let concNeed = 0;
  for (const cell of state.cells) {
    const r = cell.base - cell.cumulative;
    const isForced = forceCorrection2 !== undefined && cell.r === forceCorrection2.r && cell.c === forceCorrection2.c;
    const correction: 1 | 2 = isForced || cell.shitsuke ? 2 : 1;
    const v = cellValue(ctx, r, correction, muga, schedule);
    totalErr += v.expErr;
    concNeed += v.conc;
  }
  return { totalErr, concNeed };
}

/** マージン・所要集中力から v = sigmoid(margin/s0) - concPenalty*shortfall を算出する。 */
function toV(ctx: SolverContext, totalErr: number, concNeed: number, concAvailable: number, star3: number): number {
  const margin = star3 - totalErr;
  const shortfall = Math.max(0, concNeed - concAvailable);
  return sigmoid(margin / ctx.params.sigmoidScale) - ctx.params.concPenalty * shortfall;
}

/** 盤面の静的評価 V(state)。 */
export function evaluateState(
  ctx: SolverContext,
  state: GameState,
): { v: number; totalErr: number; concNeed: number } {
  if (state.finished) {
    const j = ctx.engine.judge(state);
    return { v: j.star === 'star3' ? 1 : 0, totalErr: j.totalError, concNeed: 0 };
  }

  const schedule = scheduleFromState(state);
  const muga: 0 | 1 = state.mugaActive ? 1 : 0;
  const { totalErr, concNeed } = accumulate(ctx, state, schedule, muga);

  const boundary = boundsFor(state.massCount, state.errorLimit, ctx.data.params);
  const v = toV(ctx, totalErr, concNeed, state.concentration, boundary.star3);
  return { v, totalErr, concNeed };
}

// ---- 候補スコアリング ----

function scoreFinish(ctx: SolverContext, state: GameState, candidate: Candidate, index: number): ScoredCandidate {
  const j = ctx.engine.judge(state);
  return {
    candidate,
    index,
    score: j.star === 'star3' ? 1 : 0,
    expTotalErr: j.totalError,
    expConcNeed: 0,
  };
}

/** sew/recover/みだれ: actionDistribution の PMF で対象マスを置き換えて期待値を合算する。 */
function scoreDistribution(
  ctx: SolverContext,
  state: GameState,
  candidate: Candidate,
  index: number,
): ScoredCandidate {
  const dist = actionDistribution(ctx.engine, state, ctx.config, candidate);
  const schedule = scheduleFromState(state);
  const muga: 0 | 1 = state.mugaActive ? 1 : 0;
  const targetPmf = new Map<string, CellPmf>(dist.cells.map((d) => [`${d.r},${d.c}`, d.pmf]));

  let totalErr = 0;
  let concNeed = 0;
  for (const cell of state.cells) {
    const correction: 1 | 2 = cell.shitsuke ? 2 : 1;
    const pmf = targetPmf.get(`${cell.r},${cell.c}`);
    if (pmf) {
      let expErr = 0;
      let conc = 0;
      for (const { remaining, prob } of pmf) {
        const v = cellValue(ctx, remaining, correction, muga, schedule);
        expErr += prob * v.expErr;
        conc += prob * v.conc;
      }
      totalErr += expErr;
      concNeed += conc;
    } else {
      const r = cell.base - cell.cumulative;
      const v = cellValue(ctx, r, correction, muga, schedule);
      totalErr += v.expErr;
      concNeed += v.conc;
    }
  }

  const concAvailable = state.concentration - candidate.cost;
  const boundary = boundsFor(state.massCount, state.errorLimit, ctx.data.params);
  const v = toV(ctx, totalErr, concNeed, concAvailable, boundary.star3);

  return { candidate, index, score: v, expTotalErr: totalErr, expConcNeed: candidate.cost + concNeed };
}

/** 無我の境地: muga=1 変種で評価する(集中力は変化しない)。 */
function scoreMuga(ctx: SolverContext, state: GameState, candidate: Candidate, index: number): ScoredCandidate {
  const schedule = scheduleFromState(state);
  const { totalErr, concNeed } = accumulate(ctx, state, schedule, 1);
  const concAvailable = state.concentration - candidate.cost;
  const boundary = boundsFor(state.massCount, state.errorLimit, ctx.data.params);
  const v = toV(ctx, totalErr, concNeed, concAvailable, boundary.star3);
  return { candidate, index, score: v, expTotalErr: totalErr, expConcNeed: candidate.cost + concNeed };
}

/** しつけがけ: 対象マスのみ correction=2 で評価する。 */
function scoreShitsuke(ctx: SolverContext, state: GameState, candidate: Candidate, index: number): ScoredCandidate {
  const target = candidate.targetCells[0];
  const schedule = scheduleFromState(state);
  const muga: 0 | 1 = state.mugaActive ? 1 : 0;
  const { totalErr, concNeed } = accumulate(ctx, state, schedule, muga, target);
  const concAvailable = state.concentration - candidate.cost;
  const boundary = boundsFor(state.massCount, state.errorLimit, ctx.data.params);
  const v = toV(ctx, totalErr, concNeed, concAvailable, boundary.star3);
  return { candidate, index, score: v, expTotalErr: totalErr, expConcNeed: candidate.cost + concNeed };
}

/** 精神統一: 現在パワーを duration ターン固定した仮スケジュールで評価する。 */
function scoreLockPower(
  ctx: SolverContext,
  state: GameState,
  candidate: Candidate,
  duration: number,
  index: number,
): ScoredCandidate {
  const schedule: ScheduleState = {
    lockPowerRemaining: duration,
    lockedPower: state.currentPower,
    forcedNextPower: state.forcedNextPower,
    cycleIndex: state.cycleIndex,
    powerCycle: state.powerCycle,
  };
  const muga: 0 | 1 = state.mugaActive ? 1 : 0;
  const { totalErr, concNeed } = accumulate(ctx, state, schedule, muga);
  const concAvailable = state.concentration - candidate.cost;
  const boundary = boundsFor(state.massCount, state.errorLimit, ctx.data.params);
  const v = toV(ctx, totalErr, concNeed, concAvailable, boundary.star3);
  return { candidate, index, score: v, expTotalErr: totalErr, expConcNeed: candidate.cost + concNeed };
}

/** ぬいパワーシフト: 現在パワーを除く4種の forcedNextPower それぞれで評価し平均する。 */
function scoreShiftPower(ctx: SolverContext, state: GameState, candidate: Candidate, index: number): ScoredCandidate {
  const options = SHIFT_CANDIDATES.filter((p) => p !== state.currentPower);
  const muga: 0 | 1 = state.mugaActive ? 1 : 0;
  const concAvailable = state.concentration - candidate.cost;
  const boundary = boundsFor(state.massCount, state.errorLimit, ctx.data.params);

  let sumV = 0;
  let sumErr = 0;
  let sumConc = 0;
  for (const to of options) {
    const schedule: ScheduleState = {
      lockPowerRemaining: state.lockPowerRemaining,
      lockedPower: state.lockedPower,
      forcedNextPower: to,
      cycleIndex: state.cycleIndex,
      powerCycle: state.powerCycle,
    };
    const { totalErr, concNeed } = accumulate(ctx, state, schedule, muga);
    sumV += toV(ctx, totalErr, concNeed, concAvailable, boundary.star3);
    sumErr += totalErr;
    sumConc += concNeed;
  }
  const n = options.length;
  return {
    candidate,
    index,
    score: sumV / n,
    expTotalErr: sumErr / n,
    expConcNeed: candidate.cost + sumConc / n,
  };
}

/**
 * 候補行動のスコアリング(ソルバー基盤モジュール4)。
 * score降順 → expTotalErr昇順 → 残り集中力(state.concentration-cost)降順 → index昇順でソートする。
 */
export function scoreCandidates(ctx: SolverContext, state: GameState): ScoredCandidate[] {
  const candidates = enumerateCandidates(ctx.engine, state, ctx.config);
  const scored: ScoredCandidate[] = candidates.map((candidate, index) => {
    if (candidate.action.type === 'finish') {
      return scoreFinish(ctx, state, candidate, index);
    }

    const skill = ctx.engine.listSkills().find((s) => s.id === candidate.skillId);
    if (!skill) throw new Error(`不明な特技: ${String(candidate.skillId)}`);

    if (skill.kind === 'sew' || skill.kind === 'recover') {
      return scoreDistribution(ctx, state, candidate, index);
    }
    if (skill.kind === 'hissatsu') {
      return scoreMuga(ctx, state, candidate, index);
    }
    switch (skill.effect) {
      case 'lockPower':
        return scoreLockPower(ctx, state, candidate, skill.duration ?? 3, index);
      case 'shiftPower':
        return scoreShiftPower(ctx, state, candidate, index);
      case 'cellCorrection':
        return scoreShitsuke(ctx, state, candidate, index);
      default:
        throw new Error(`未対応の support 特技: ${skill.id}`);
    }
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.expTotalErr !== b.expTotalErr) return a.expTotalErr - b.expTotalErr;
    const remA = state.concentration - a.candidate.cost;
    const remB = state.concentration - b.candidate.cost;
    if (remB !== remA) return remB - remA;
    return a.index - b.index;
  });

  return scored;
}
