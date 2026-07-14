// エキスパートポリシーv2 (ソルバー拡張: トップ勢の判断基準のルールベース実装)
//
// 設計: ティア方式。ルールが候補の許可/禁止と優先ティア(小さいほど優先)を決め、
// 同ティア内は既存の静的評価スコア(scoreCandidates)でタイブレークする。
// v2(SOLVER_POLICY.md §10): adjustフェーズのみ、ティアは合法性ゲートに単純化し、
// 同ティア内のタイブレークを厳密DP(adjust-dp.ts)のスコアへ置換する。
// 出典タグ(A1・B1〜B4・C1〜C9・D1〜D2・E1〜E3・§10.x)は docs/SOLVER_POLICY.md 対応節。
//
// 前提: state は beginTurn 済み(currentPower 確定)。乱数・Date は使用しない(決定的)。

import { isTraitTurn, rainbowMode } from '../core';
import type { Engine, GameParams, GameState, Power, SkillDef } from '../core';
import { allocateAdjustBudget } from './adjust-dp';
import { actionDistribution } from './distribution';
import { scoreCandidates } from './evaluate';
import type {
  ActionDistribution,
  BoardAnalysis,
  Candidate,
  CellPmf,
  ExpertChoice,
  Phase,
  ScoredCandidate,
  SolverContext,
} from './types';
import { DEFAULT_POLICY_PARAMS } from './types';

const P = DEFAULT_POLICY_PARAMS;

// E2会心ターン緩和(§10.3簡易版)の床ボーナス。本来はPolicyParamsに属する調整値だが、
// このタスクのファイル変更範囲が types.ts=SolverContextへの1フィールド追加のみに限定されて
// いるため、policy.ts内定数として実装する(報告事項: 判断に迷った点)。
const CRIT_TURN_FLOOR_BONUS = 2;

// 実効パワー4種('critx2'/'unknown' は 'normal' 同格。B4)
type EffPower = 'weak' | 'normal' | 'strong' | 'strongest';

function effPower(power: Power): EffPower {
  if (power === 'critx2' || power === 'unknown') return 'normal';
  return power as EffPower;
}

// 特技分類(skills.json の固定ID集合。src/data/skills.json 参照)
const LINE3_IDS = new Set(['suihei_nui', 'otaki_nobori']); // 水平/大滝(3マス系)
const TASUKI_IDS = new Set(['tasuki_nui', 'gyaku_tasuki']); // たすき系(斜め2マス)
const YOKOTAKI_IDS = new Set(['yoko_nui', 'taki_nobori']); // ヨコぬい/滝のぼり(直線2マス)

// 再生布の回復先保護(§10.6): 「安い仕上げ値」の対象値。6と10〜13は再抽選が許容される値(A1a)
// なので保護対象外(仕様どおり)。
const REGEN_PROTECT_VALUES = new Set([5, 7, 8, 9]);

// ---- 盤面分析 ----

/** 盤面をティア判定用に分類する(BoardAnalysis)。 */
export function analyzeBoard(_ctx: SolverContext, state: GameState): BoardAnalysis {
  let bigCount = 0;
  let midCount = 0;
  let fineCount = 0;
  let overCount = 0;

  for (const cell of state.cells) {
    const r = cell.base - cell.cumulative;
    if (r >= P.carveMin) bigCount++;
    else if (r >= P.approachMin) midCount++;
    else if (r >= 3) fineCount++;
    if (r <= -3) overCount++;
  }

  const weakLocked = state.lockedPower === 'weak' && state.lockPowerRemaining > 0;
  let phase: Phase = bigCount > 0 ? 'carve' : midCount > 0 ? 'approach' : 'adjust';
  if (weakLocked) phase = 'adjust'; // 弱パワー固定中は常に着地(調整)局面(A1)

  return { phase, bigCount, midCount, fineCount, overCount, weakLocked };
}

// ---- パワースケジュール先読み(evaluate.ts の avgCoeff と同じ規則の小ヘルパ) ----
// evaluate.ts の ScheduleState/advanceSchedule は private のためここで同等実装する。

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

/** endTurn と同じ規則で1ターン分スケジュールを進める(手番の機会費用)。 */
function advanceSchedule(schedule: ScheduleState): ScheduleState {
  let lockPowerRemaining = schedule.lockPowerRemaining;
  let lockedPower = schedule.lockedPower;
  let cycleIndex = schedule.cycleIndex;

  if (lockPowerRemaining > 0) {
    lockPowerRemaining -= 1;
    if (lockPowerRemaining === 0) lockedPower = null;
  }
  if (lockPowerRemaining === 0 && schedule.powerCycle.length > 0) {
    cycleIndex = (cycleIndex + 1) % schedule.powerCycle.length;
  }

  return {
    lockPowerRemaining,
    lockedPower,
    forcedNextPower: schedule.forcedNextPower,
    cycleIndex,
    powerCycle: schedule.powerCycle,
  };
}

/** 今後 n ターンの実効パワー列(unknown解決は行わず抽選前の値のまま返す。B4で呼び出し側が畳む)。 */
function scheduleForwardPowers(schedule: ScheduleState, n: number): Power[] {
  let remainingLock = schedule.lockPowerRemaining;
  let forcedPending = schedule.forcedNextPower !== null;
  const forced = schedule.forcedNextPower;
  let cycleIdx = schedule.cycleIndex;
  const cycle = schedule.powerCycle;

  const result: Power[] = [];
  for (let t = 0; t < n; t++) {
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
    result.push(power);
  }
  return result;
}

// ---- 縫いすぎ禁止(E2)・誤差0ボーナス(A1)・発光マス補正(D1) ----

/** PMFの最小 remaining(=非会心最悪値。会心は残り0以上に頭打ちされるため常に非会心側が最小)。 */
function worstRemaining(dist: ActionDistribution, r: number, c: number): number | undefined {
  const cell = dist.cells.find((d) => d.r === r && d.c === c);
  if (!cell || cell.pmf.length === 0) return undefined;
  return Math.min(...cell.pmf.map((p) => p.remaining));
}

/** 赤マス(残り≤−3)の数。再生布の許容緩和は「赤は1〜2マスまで」(D2)の範囲でのみ有効。 */
function redCellCount(state: GameState): number {
  return state.cells.filter((c) => c.base - c.cumulative <= -3).length;
}

/**
 * E2縫いすぎ禁止: 対象マスの非会心最大ダメージ後の残りが overshootFloor 未満なら禁止。
 * 再生布は regenOvershootFloor(carve中は regenCarveFloor)まで緩和するが、
 * **既に赤マス(残り≤−3)が2つ以上あるときは緩和しない**(D2「1マス赤、2マスでもだいたい可」。
 * 回復は4ターンに1マス+12〜16なので、無制限に赤を作ると回復能力を超えた借金になる)。
 * 残り≤0のマスを対象に含む縫いも、再生布(緩和有効時)以外は禁止(D2: 赤マス作りが正当手)。
 * みだれぬいは対象外(呼び出し側で除く)。
 */
function passesE2(ctx: SolverContext, state: GameState, phase: Phase, candidate: Candidate, dist: ActionDistribution): boolean {
  const regenRelaxed = state.clothType === 'regen' && redCellCount(state) <= 1;
  let floor = regenRelaxed ? (phase === 'carve' ? P.regenCarveFloor : P.regenOvershootFloor) : P.overshootFloor;

  // E2会心ターン緩和(§10.3簡易版): 虹布の会心ターン(消費増だが会心率+24%)は複数マス同時の
  // 誤差0上振れを狙う価値があるため、多マス候補に限り床を CRIT_TURN_FLOOR_BONUS だけ緩める。
  // isTraitTurn/rainbowMode は state.turn+1(=当ターンの番号。engine.ts critRate と同じ規約)で判定する。
  const isRainbowCritTurn =
    state.clothType === 'rainbow' &&
    isTraitTurn(state.turn + 1, ctx.data.params) &&
    rainbowMode(state.turn + 1, ctx.data.params) === 'up';
  if (isRainbowCritTurn && candidate.targetCells.length >= 2) {
    floor -= CRIT_TURN_FLOOR_BONUS;
  }

  for (const t of candidate.targetCells) {
    const cell = ctx.engine.cellAt(state, t.r, t.c);
    if (!cell) continue;
    const remainingBefore = cell.base - cell.cumulative;
    if (remainingBefore <= 0 && !regenRelaxed) return false;

    const worst = worstRemaining(dist, t.r, t.c);
    if (worst !== undefined && worst < floor) return false;
  }
  return true;
}

/** A1誤差0ボーナス: PMFに remaining===0 が確率≥1/7 で含まれるか。 */
function hasZeroBonus(dist: ActionDistribution): boolean {
  const eps = 1e-9;
  return dist.cells.some((cell) => cell.pmf.some((pt) => pt.remaining === 0 && pt.prob >= 1 / 7 - eps));
}

/** D1発光マス補正: 候補の対象に発光マスが含まれるか。 */
function targetsGlowCell(state: GameState, candidate: Candidate): boolean {
  if (!state.glowCell) return false;
  const g = state.glowCell;
  return candidate.targetCells.some((t) => t.r === g.r && t.c === g.c);
}

// ---- 再生布の再抽選ステアリング (§10.6/§5)。回復(4ターンごと・+12〜16)を
// 「悪い数値の無料再抽選」として扱い、回復先を手番で誘導するトップ勢の手筋。 ----

/** 再生予測結果: 現盤面での回復対象候補(比最大。同率は複数)と、次の再生ターンまでの手番数。 */
export interface RegenPrediction {
  targets: { r: number; c: number; remaining: number }[];
  turnsUntil: number;
}

/** turn より厳密に後(turn自身は含まない)で最初の布特性発動ターンを返す(isTraitTurnと同じ規約)。 */
function nextTraitTurnStrictlyAfter(turn: number, params: GameParams): number {
  const { firstTurn, interval } = params.clothTrait;
  if (turn < firstTurn) return firstTurn;
  const k = Math.floor((turn - firstTurn) / interval) + 1;
  return firstTurn + k * interval;
}

/**
 * 再生布の次回回復先を予測する(exportはテスト用)。
 * 現在ターンは state.turn+1(policy.ts共通規約)。当ターンが再生ターンの場合、
 * 回復は beginTurn 内で既に適用済みのため、予測対象は「次の再生ターン」
 * (= 現在ターンの次以降で最初の trait turn)にする。
 * 回復対象の選定規則(比最大・同率タイは全て・黄色枠内除外)は engine.ts の
 * applyRegen と同じ(乱数を要する回復量ロール・タイブレークは行わない)。
 */
export function predictRegenTarget(ctx: SolverContext, state: GameState): RegenPrediction | null {
  if (state.clothType !== 'regen') return null;

  const currentTurn = state.turn + 1;
  const nextRegenTurn = nextTraitTurnStrictlyAfter(currentTurn, ctx.data.params);
  const turnsUntil = nextRegenTurn - currentTurn;

  const yellow = ctx.data.params.gauge.yellowRange;
  const eligible = state.cells.filter((cell) => Math.abs(cell.base - cell.cumulative) > yellow);
  if (eligible.length === 0) return { targets: [], turnsUntil };

  let bestRatio = -Infinity;
  for (const cell of eligible) {
    const ratio = cell.cumulative / cell.base;
    if (ratio > bestRatio) bestRatio = ratio;
  }
  const targets = eligible
    .filter((cell) => cell.cumulative / cell.base === bestRatio)
    .map((cell) => ({ r: cell.r, c: cell.c, remaining: cell.base - cell.cumulative }));

  return { targets, turnsUntil };
}

// ---- 特技別ティア判定 ----

function remainingAt(engine: Engine, state: GameState, r: number, c: number): number {
  const cell = engine.cellAt(state, r, c);
  if (!cell) throw new Error(`対象マスが存在しません: (${r},${c})`);
  return cell.base - cell.cumulative;
}

/**
 * 押し出し・保護の判定用PMF: 対象マス(r,c)のPMFを取り出す(なければundefined)。
 */
function pmfAt(dist: ActionDistribution, r: number, c: number): CellPmf | undefined {
  return dist.cells.find((d) => d.r === r && d.c === c)?.pmf;
}

/**
 * 押し出し打点判定: PMFの全出目が [lo, hi] に収まるか。
 * ただし remaining===0(会心頭打ちによる即誤差0)は「押し出し不要なほど良い出目」であり
 * 押し出し設計(残数値−ダメージ+約14≈0)の対象外の成功ケースなので、範囲チェックから除外する
 * (判断に迷った点: 残り+2/+3への縫いは行動前残りが小さいため会心が必ず絡み、会心は基準値
 * 頭打ちで常にちょうど0に着地する(E2の会心頭打ち仕様)。「全出目」を文字どおり0込みで
 * 判定すると+2/+3の押し出しが原理的に成立しなくなるため、0着地は例外として許容した)。
 */
function allWithinPushRange(pmf: CellPmf, lo: number, hi: number): boolean {
  return pmf.every((pt) => pt.remaining === 0 || (pt.remaining >= lo && pt.remaining <= hi));
}

/**
 * 再生布・押し出し(re-roll setup)ティア(§10.6/A1f)。
 * clothType==='regen' かつ 次の再生まで regenSteerWindow ターン以内のとき、単マス縫い候補で
 * 対象マスの行動前残りが +2/−2/+3 のいずれかで、かつ結果PMFが押し出し打点域に収まるものへ
 * 優先ティアを与える(+2が最優先≫−2>+3。B6)。−3以下は糸ほぐしで直す対象なので除外(B6)。
 * 既存のティア表より優先して適用する(§4: 押し出し・保護のtierを優先)。
 *
 * exportはテスト用: 対象マスの行動前残りが≤0の単マス縫いは enumerateCandidates
 * (src/stats/actions.ts)側で「縫う価値なし」として候補自体が生成されないため(仕様上正しい
 * 挙動。単マス系は対象1マスのみで allNonPositive が常に真になる)、−2ケースは rankExpert 経由の
 * 統合テストでは再現できない。dist を直接組み立てて本関数を呼ぶ単体テストで検証する。
 */
export function tierForRegenPush(
  ctx: SolverContext,
  state: GameState,
  candidate: Candidate,
  skill: SkillDef,
  dist: ActionDistribution,
  prediction: RegenPrediction | null,
): number | null {
  if (state.clothType !== 'regen') return null;
  if (!prediction || prediction.turnsUntil > P.regenSteerWindow) return null;
  if (skill.target !== 'single') return null;

  // 押し出しは既存の赤マスが0のときのみ(§10.6)。回復は4ターンに1マスしか再抽選できない
  // ため、赤の同時多発は回収不能の借金になる(v2ベンチ実測: 押し出し2連発で再生★3率が悪化)。
  // エキスパートの実手も「1つ押して直後の再生で回収」(烈風#31)。
  if (redCellCount(state) > 0) return null;

  const t = candidate.targetCells[0];
  const r = remainingAt(ctx.engine, state, t.r, t.c);
  if (r !== 2 && r !== -2 && r !== 3) return null;

  const pmf = pmfAt(dist, t.r, t.c);
  if (!pmf || !allWithinPushRange(pmf, P.regenPushLo, P.regenPushHi)) return null;

  if (r === 2) return 1;
  if (r === -2) return 1.5;
  return 2; // r === 3
}

/**
 * 再生布・回復先保護(§10.6)。次の再生ターンが1手後(turnsUntil===1)で、予測回復対象に
 * 「安い仕上げ値」(r∈{5,7,8,9}。6・10〜13は再抽選許容のため対象外)のマスが含まれる場合、
 * そのマスを黄色内(全出目|残り|≤4)または誤差0圏に入れる単マス縫い候補のティアを1引き下げる
 * (優先度アップ)。黄色内に収める、または誤差0を取れば eligible から外れ回復に巻き込まれない
 * (engine.ts applyRegen と同じ黄色枠除外規則)。
 */
function regenProtectionDelta(
  ctx: SolverContext,
  state: GameState,
  candidate: Candidate,
  skill: SkillDef,
  dist: ActionDistribution,
  prediction: RegenPrediction | null,
): number {
  if (state.clothType !== 'regen') return 0;
  if (!prediction || prediction.turnsUntil !== 1) return 0;
  if (skill.target !== 'single') return 0;

  const t = candidate.targetCells[0];
  const isProtectedTarget = prediction.targets.some(
    (tg) => tg.r === t.r && tg.c === t.c && REGEN_PROTECT_VALUES.has(tg.remaining),
  );
  if (!isProtectedTarget) return 0;

  const pmf = pmfAt(dist, t.r, t.c);
  if (!pmf) return 0;

  const yellow = ctx.data.params.gauge.yellowRange;
  const allWithinYellow = pmf.every((pt) => Math.abs(pt.remaining) <= yellow);
  const hasZero = pmf.some((pt) => pt.remaining === 0);
  return allWithinYellow || hasZero ? -1 : 0;
}

/** 糸ほぐし(C5/A1)。 */
function tierForHogushi(ctx: SolverContext, state: GameState, analysis: BoardAnalysis, candidate: Candidate): number | null {
  // adjust: 単マス系(ぬう/かげん/半かげん/2倍/3倍/ねらい/糸ほぐし)は一律tier1に単純化し、
  // 同tier内の順位付けはDPスコアに委ねる(§10.4/2)。r値によるティア分岐は不要。
  if (analysis.phase === 'adjust') return 1;

  const t = candidate.targetCells[0];
  const r = remainingAt(ctx.engine, state, t.r, t.c);

  if (r <= -3) return 1;
  if (r === -2 || r === -1) return 3;
  return null;
}

/** しつけがけ(C6)。 */
function tierForShitsuke(ctx: SolverContext, state: GameState, analysis: BoardAnalysis, candidate: Candidate): number | null {
  const t = candidate.targetCells[0];
  const r = remainingAt(ctx.engine, state, t.r, t.c);
  const eff = effPower(state.currentPower);

  // ① 最強化の仕込み
  if (state.massCount === 4 && analysis.phase !== 'adjust' && r >= P.carveMin && (eff === 'weak' || eff === 'normal')) {
    return 2;
  }
  // ② adjust: ダメージなしなので常にE2安全。r≥5なら一律tier1(旧: r===7のみ廃止。
  // DPがしつけ状態(correction=2)の価値を allocateAdjustBudget 経由で直接評価する。§10.4/2)
  if (analysis.phase === 'adjust' && r >= 5) return 1;
  // ③ 光布: 次ターンが発光ターンでないときのみ
  if (state.clothType === 'light' && r === 16 && !isTraitTurn(state.turn + 2, ctx.data.params)) return 3;

  return null;
}

/**
 * ねらいぬい(C3。v1簡易判定)。E2は縫い系として別途適用済みの前提。
 * adjust局面は呼び出し側(tierForSewOrRecover)で単マス系の一律tier1に合流するため、
 * ここではcarve/approach向けの旧ゲート(4マス限定)のみを扱う(§10.4/2: 旧「4マス/光限定」は
 * adjustでは撤廃)。
 */
function tierForNerai(state: GameState): number | null {
  if (state.massCount === 4) return 2;
  return null;
}

/** みだれぬい(B1〜B3/C1)。E2は対象外(専用のstop-loss判定を用いる)。 */
function tierForMidare(state: GameState, analysis: BoardAnalysis, dist: ActionDistribution): number | null {
  const isRegen = state.clothType === 'regen';
  // 再生布の緩和も赤マス1つまで(D2。passesE2 と同じ理由)
  const regenRelaxed = isRegen && redCellCount(state) <= 1;
  const worst = Math.min(...dist.cells.map((c) => Math.min(...c.pmf.map((p) => p.remaining))));
  const stopLossFloor = regenRelaxed
    ? analysis.phase === 'carve'
      ? P.regenCarveFloor
      : P.regenOvershootFloor
    : P.midareStopLoss;
  // C1のストップロスは全フェーズ・全パワー共通の前提条件:
  // 「2倍打の最大値が当たっても糸ほぐし1回(再生布は回復込み)で戻せる範囲」を超え得る間は
  // みだれを打たない。carve中でも例外にしない — 仕上がった小マスが混在する盤面で
  // みだれを許可すると仕上げ済みマスを破壊する(2026-07-13ベンチ実測: 縫いすぎ120/戦)。
  if (worst < stopLossFloor) return null;

  if (analysis.phase === 'adjust') {
    return isRegen ? 3 : null; // 終盤暴発の抑止。再生布のみ許可
  }
  if (analysis.phase === 'approach') {
    return isRegen ? 2 : null; // 再生布のみ許可
  }

  // carve
  const eff = effPower(state.currentPower);
  if (eff === 'weak') {
    return 1;
  }
  if (eff === 'strongest') {
    const upcoming = scheduleForwardPowers(advanceSchedule(scheduleFromState(state)), 2);
    const hasNormal = upcoming.some((p) => effPower(p) === 'normal');
    return hasNormal ? 2 : 1; // B1温存
  }
  return 1; // strong(B1)/normal(B3)
}

/**
 * ヨコぬい/滝のぼり専用のレンジ判定(C2「明確な理由」。カバー範囲外は禁止=catch-allなし)。
 * B4(§10.5): 「全対象マスが適正レンジ」→「全対象マスが有効」に緩和。有効=適正レンジ内、
 * または非会心最大ダメージでも縫いすぎない(worstRemaining≥0=縫いすぎゼロの純削り)マス。
 * これにより「大きいマス+レンジ内マスの組合せ」を許可する(割当の結果としてのヨコ/滝)。
 */
function tierForYokoTaki(
  engine: Engine,
  state: GameState,
  analysis: BoardAnalysis,
  candidate: Candidate,
  dist: ActionDistribution,
): number | null {
  if (candidate.targetCells.length !== 2) return null;
  const eff = effPower(state.currentPower);
  const rs = candidate.targetCells.map((t) => remainingAt(engine, state, t.r, t.c));
  const bothAtLeast = (min: number): boolean => rs.every((r) => r >= min);
  const allValid = (lo: number, hi: number): boolean =>
    candidate.targetCells.every((t, i) => {
      const r = rs[i];
      if (r >= lo && r <= hi) return true;
      const worst = worstRemaining(dist, t.r, t.c);
      return worst !== undefined && worst >= 0;
    });

  if (analysis.phase === 'carve') {
    if ((eff === 'strongest' || eff === 'strong') && bothAtLeast(P.approachMin)) return 1;
    return null;
  }
  if (analysis.phase === 'approach') {
    if (eff === 'normal' && allValid(14, 25)) return 1;
    if (eff === 'strong' && allValid(16, 27)) return 1;
    return null;
  }
  return null; // adjust: 多マス系はtierForGeneralSewのライン系ゲート(§10.5/B3)側で別途処理
}

/** たすき系・3マス系・巻きこみ・単マス系(みだれ/ねらいを除く縫い全般)のティア表。 */
function tierForGeneralSew(
  ctx: SolverContext,
  state: GameState,
  analysis: BoardAnalysis,
  candidate: Candidate,
  skill: SkillDef,
  dist: ActionDistribution,
): number | null {
  const eff = effPower(state.currentPower);
  const engine = ctx.engine;
  const rs = (): number[] => candidate.targetCells.map((t) => remainingAt(engine, state, t.r, t.c));
  const r0 = (): number => remainingAt(engine, state, candidate.targetCells[0].r, candidate.targetCells[0].c);
  const atLeast2 = (min: number): boolean => rs().filter((r) => r >= min).length >= 2;

  if (analysis.phase === 'adjust') {
    // ティアは合法性ゲートに単純化(§10.4/2)。E2プルーンは呼び出し側で通過済みの前提。
    if (skill.target === 'single') {
      // 単マス系(ぬう/かげん/半かげん/2倍/3倍/ねらい)は一律tier1。同tier内はDPスコアで順位付け。
      return 1;
    }
    // ライン系(たすき/ヨコ/滝/3マス/巻きこみ。みだれ=random4はここに来ない): 全対象マスが
    // r≥3 かつ 各マスのPMF最小値≥−2(C5放置ライン)なら許可(§10.5/B3)。
    const allAtLeast3 = rs().every((r) => r >= 3);
    if (allAtLeast3) {
      const minPmf = Math.min(...dist.cells.map((d) => Math.min(...d.pmf.map((p) => p.remaining))));
      if (minPmf >= -2) return 1;
    }
    return null;
  }

  if (YOKOTAKI_IDS.has(skill.id)) return tierForYokoTaki(engine, state, analysis, candidate, dist);

  if (analysis.phase === 'carve') {
    switch (eff) {
      case 'strongest': {
        if ((LINE3_IDS.has(skill.id) || skill.id === 'makikomi_nui') && atLeast2(P.approachMin)) return 1;
        if (skill.id === 'sanbai_nui' && r0() >= P.carveMin) return 1;
        return 3;
      }
      case 'strong': {
        if ((TASUKI_IDS.has(skill.id) || LINE3_IDS.has(skill.id)) && atLeast2(P.approachMin)) return 1;
        if (skill.id === 'sanbai_nui' || skill.id === 'nibai_nui') return 2;
        return 3;
      }
      case 'normal': {
        if (TASUKI_IDS.has(skill.id)) return 2;
        return 3;
      }
      case 'weak': {
        if (skill.id === 'nuu') {
          const r = r0();
          if (r >= 6 && r <= 9) return 2;
        }
        return 3; // 安全な縫い(E2既に通過済み)
      }
    }
  }

  if (analysis.phase === 'approach') {
    switch (eff) {
      case 'weak': {
        const r = r0();
        // 6〜13(旧6〜9から拡張。10〜13は「ぬう→かげん」刻みの第1打。B4)
        if (skill.id === 'nuu' && r >= 6 && r <= 13) return 1;
        if (skill.id === 'kagen_nui' && r >= 4 && r <= 5) return 1;
        return 2; // 安全な縫い(E2充足)
      }
      case 'normal': {
        const r = r0();
        if (skill.id === 'nuu' && r >= 14 && r <= 25) return 1;
        if (TASUKI_IDS.has(skill.id) && rs().every((x) => x >= 14 && x <= 25)) return 1;
        if (state.clothType === 'regen' && skill.id === 'nuu' && r >= 2 && r <= 3) return 1; // D2
        return 2;
      }
      case 'strong': {
        const r = r0();
        if (skill.id === 'kagen_nui' && r >= 10 && r <= 13) return 1;
        if (skill.id === 'nuu' && r >= 16 && r <= 27) return 1;
        if (TASUKI_IDS.has(skill.id) && rs().every((x) => x >= 16 && x <= 27)) return 1;
        return 2;
      }
      case 'strongest': {
        const r = r0();
        if (skill.id === 'nuu' && r >= 24 && r <= 36) return 1;
        if ((skill.id === 'nibai_nui' || skill.id === 'sanbai_nui') && r >= 36) return 1;
        return 2;
      }
    }
  }

  return null;
}

/**
 * 残り作業手数の見積もり(§10.1)。マスごとに、しあげまでに必要な手数の概算を合計する
 * (しあげる1手そのものは含めない)。粗い区分表であり、弱ロック延長要否の判断専用。
 */
function estimateAdjustMoves(cells: { r: number }[]): number {
  let total = 0;
  for (const { r } of cells) {
    if (Math.abs(r) <= 2) continue; // 0手(誤差0または黄色ゲージ内相当)
    if ((r >= 3 && r <= 10) || r <= -3) total += 1; // 1手(かげん1発 or ほぐし1発で妥当圏)
    else if (r >= 11 && r <= 13) total += 2; // 2手(ぬう→かげん刻み等)
    else if (r >= 14) total += 2; // 2手(弱ロック中の想定外の大マス。粗い上限見積もり)
  }
  return total;
}

/** state.cells から (r) 列を作る(estimateAdjustMoves呼び出し用の小ヘルパ)。 */
function boardRemainings(state: GameState): { r: number }[] {
  return state.cells.map((cell) => ({ r: cell.base - cell.cumulative }));
}

/**
 * powerCycle上で「現在のロックが明けた直後」に来るエントリ(§10.1弱→強例外)。
 * ロック中はcycleIndexが凍結される(engine.ts endTurn)ため、ロック開始時の位置のまま
 * powerCycle[cycleIndex+1] が「ロック明け直後の1ターン目」を指す。
 */
function nextCycleEntryAfterLock(state: GameState): Power | null {
  if (state.powerCycle.length === 0) return null;
  return state.powerCycle[(state.cycleIndex + 1) % state.powerCycle.length];
}

/**
 * 精神統一(C7/A4①。§10.1/10.2でルール反転: 延長がデフォルト)。
 * 旧v1(fineCount+overCount≥2で発動)を廃止し、残り作業手数の見積もりベースへ置換する。
 */
function tierForSeishin(state: GameState, analysis: BoardAnalysis): number | null {
  const unlocked = state.lockPowerRemaining === 0;

  // 最強ロック/再ロック(§10.2): 未ロック、または残りロック2以下(旧: 残1限定を緩和)。
  if (state.currentPower === 'strongest' && analysis.phase === 'carve' && (unlocked || state.lockPowerRemaining <= 2)) {
    return 1;
  }

  // 弱着地(初回。§10.1): 未ロックかつ残り作業(しあげ含まず)が2手以上あれば統一で固定する。
  if (state.currentPower === 'weak' && unlocked && analysis.phase === 'adjust') {
    const remainingMoves = estimateAdjustMoves(boardRemainings(state));
    if (remainingMoves >= 2) return 0;
  }

  // 弱延長(デフォルト。§10.1訂正): 「延長がデフォルト」。ロックが切れる時点で残り作業
  // (+しあげ1手)が現ロックの残ターン内に収まる場合のみ放棄し得る(=候補から外す)。
  if (state.lockedPower === 'weak' && state.lockPowerRemaining > 0 && state.lockPowerRemaining <= 2 && analysis.phase === 'adjust') {
    const remainingMoves = estimateAdjustMoves(boardRemainings(state));
    const fitsWithinLock = remainingMoves + 1 <= state.lockPowerRemaining; // +1=しあげる手
    if (!fitsWithinLock) {
      // 弱→強例外: ロック明け直後が'strong'で、強かげんの適正レンジ(11〜13)のマスが
      // あるなら、そこで強かげんを受けたいので延長の優先度を下げる(放棄はしない)。
      const nextEntry = nextCycleEntryAfterLock(state);
      const hasStrongKagenTarget = state.cells.some((c) => {
        const r = c.base - c.cumulative;
        return r >= 11 && r <= 13;
      });
      if (nextEntry === 'strong' && hasStrongKagenTarget) return 2;
      return 0;
    }
    // 収まる場合は放棄(=候補から外す。tierを付けない)。アプローチ失敗の結果であって
    // ルール分岐ではない(§10.1)。
  }

  if (state.currentPower === 'strong' && analysis.phase === 'approach' && analysis.midCount >= 3) return 2;

  return null;
}

/** 無我の境地(C9)。 */
function tierForMuga(state: GameState): number | null {
  return state.currentPower !== 'strongest' ? 2 : null;
}

// ---- ディスパッチ・全体統括 ----

/**
 * 縫い系(みだれ・ねらい含む)・糸ほぐしのティアを決める(E2/D1/A1込み)。
 * prediction: 再生布の次回回復予測(predictRegenTarget)。regen以外ではnull。
 */
function tierForSewOrRecover(
  ctx: SolverContext,
  state: GameState,
  analysis: BoardAnalysis,
  candidate: Candidate,
  skill: SkillDef,
  prediction: RegenPrediction | null,
): number | null {
  if (skill.kind === 'recover') return tierForHogushi(ctx, state, analysis, candidate);

  // skill.kind === 'sew'
  const dist = actionDistribution(ctx.engine, state, ctx.config, candidate);

  let tier: number | null;
  if (skill.target === 'random4') {
    tier = tierForMidare(state, analysis, dist);
  } else {
    if (!passesE2(ctx, state, analysis.phase, candidate, dist)) return null; // E2は最優先の安全ゲート
    // 再生布の押し出し(§10.6/A1f)は既存のティア表より優先して適用する(§4)。
    // 押し出し候補はE2の再生緩和(赤≤1ゲート)を通過済みの前提(上のpassesE2で担保)。
    const pushTier = tierForRegenPush(ctx, state, candidate, skill, dist, prediction);
    if (pushTier !== null) {
      tier = pushTier;
    } else {
      // ねらいぬいはcarve/approachでは専用ゲート(tierForNerai)、adjustではtierForGeneralSewの
      // 単マス系一律tier1(skill.target==='single')ルートに合流させる(旧「4マス/光限定」撤廃。§10.4/2)。
      tier =
        skill.id === 'nerai_nui' && analysis.phase !== 'adjust'
          ? tierForNerai(state)
          : tierForGeneralSew(ctx, state, analysis, candidate, skill, dist);
    }
  }
  if (tier === null) return null;

  if (targetsGlowCell(state, candidate)) tier -= 1; // D1: 発光ターンの有効活用
  if (hasZeroBonus(dist)) tier -= P.zeroBonusTier; // A1: 誤差0ボーナス
  // 再生布の回復先保護(§10.6)。押し出し・保護は既存ルールより優先(§4)なので、
  // 押し出しティアの上からもさらに-1する(両立時は保護を優先して重ねる)。
  tier += regenProtectionDelta(ctx, state, candidate, skill, dist, prediction);

  return tier;
}

// ---- 調整フェーズDPスコアリング(§10.4/2) ----

/** state全マスの (r, shitsuke) を複製する(「行動後盤面」構築の土台)。 */
function currentAdjustCells(state: GameState): { r: number; shitsuke: boolean }[] {
  return state.cells.map((cell) => ({ r: cell.base - cell.cumulative, shitsuke: cell.shitsuke }));
}

/** 直積(true joint)で扱う対象マス数の上限。これを超える候補(巻きこみ=5マス)は近似する。 */
const JOINT_CELL_LIMIT = 3;

/**
 * 対象マスの真の同時分布(PMFの直積)で allocateAdjustBudget の期待値を計算する。
 * 対象マス数が JOINT_CELL_LIMIT 以下(たすき/ヨコ/滝=2、3マス系=最大3)の候補向け。
 */
function jointExpectedScore(
  ctx: SolverContext,
  baseCells: { r: number; shitsuke: boolean }[],
  idxs: number[],
  pmfs: CellPmf[],
  budget: number,
): number {
  let total = 0;
  const k = idxs.length;

  function recurse(depth: number, prob: number, cells: { r: number; shitsuke: boolean }[]): void {
    if (depth === k) {
      total += prob * allocateAdjustBudget(ctx.adjustDp, cells, budget).totalExpErr;
      return;
    }
    for (const pt of pmfs[depth]) {
      const nextCells = cells.map((c, i) => (i === idxs[depth] ? { r: pt.remaining, shitsuke: false } : c));
      recurse(depth + 1, prob * pt.prob, nextCells);
    }
  }
  recurse(0, 1, baseCells);
  return total;
}

/**
 * 調整フェーズDPスコア(§10.4/2。小さいほど良い)。候補cの「行動後盤面」
 * (対象マスをPMFの出目で置換。縫い/ほぐし後はshitsuke=false)を allocateAdjustBudget に渡し、
 * その totalExpErr を返す。
 *
 * 対象マスが JOINT_CELL_LIMIT 以下の候補は真の同時分布(直積)で厳密に計算する
 * (たすき/ヨコ/滝=2マス、3マス系=最大3マスなら直積は49〜343通りで許容範囲)。
 * 直積が大きい候補(巻きこみ=5マス)のみ、対象マスごとに「そのマス1つだけを出目で置換した
 * 盤面」の期待値を独立に計算し対象マス間で平均する近似を用いる(対話メモの単純化案)。
 * 対象マスが1つの候補(単マス系縫い・糸ほぐし)ではどちらの経路でも恒等になり厳密一致する。
 */
function dpScoreForCandidate(ctx: SolverContext, state: GameState, candidate: Candidate): number {
  const budget = state.concentration - candidate.cost;
  const baseCells = currentAdjustCells(state);

  if (candidate.skillId === 'shitsuke_gake') {
    // しつけがけ候補は対象の shitsuke=true(出目なし1通り)。r は不変。
    const t = candidate.targetCells[0];
    const idx = state.cells.findIndex((c) => c.r === t.r && c.c === t.c);
    const cells = baseCells.map((c, i) => (i === idx ? { r: c.r, shitsuke: true } : c));
    return allocateAdjustBudget(ctx.adjustDp, cells, budget).totalExpErr;
  }

  const dist = actionDistribution(ctx.engine, state, ctx.config, candidate);
  if (dist.cells.length === 0) {
    // 対象マスを持たない候補(精神統一・シフト・無我等の支援/必殺): 盤面は不変。
    return allocateAdjustBudget(ctx.adjustDp, baseCells, budget).totalExpErr;
  }

  const idxs = dist.cells.map((d) => state.cells.findIndex((c) => c.r === d.r && c.c === d.c));

  if (dist.cells.length <= JOINT_CELL_LIMIT) {
    return jointExpectedScore(
      ctx,
      baseCells,
      idxs,
      dist.cells.map((d) => d.pmf),
      budget,
    );
  }

  let sum = 0;
  for (let k = 0; k < dist.cells.length; k++) {
    const idx = idxs[k];
    let expForCell = 0;
    for (const { remaining, prob } of dist.cells[k].pmf) {
      const cells = baseCells.map((c, i) => (i === idx ? { r: remaining, shitsuke: false } : c));
      expForCell += prob * allocateAdjustBudget(ctx.adjustDp, cells, budget).totalExpErr;
    }
    sum += expForCell;
  }
  return sum / dist.cells.length;
}

/**
 * エキスパートポリシーv2による候補ランキング(ソルバー拡張)。
 * ルールが許可/禁止とティアを決め、同ティア内は静的評価スコアでタイブレークする
 * (adjustフェーズのfinish以外の候補同士に限り、DPスコア(小さいほど良い。§10.4/2)でタイブレークする)。
 * 許可候補が finish(未達)のみの場合は、scoreCandidates の順序で全候補に tier99 を
 * 付けて返す(ルールの穴で手が出せなくなるのを防ぐフォールバック)。
 */
export function rankExpert(
  ctx: SolverContext,
  state: GameState,
  opts: { exclude?: ReadonlySet<string> } = {},
): ExpertChoice[] {
  const exclude = opts.exclude;
  const scoredAll = scoreCandidates(ctx, state);
  const scored = exclude ? scoredAll.filter((s) => s.candidate.skillId === null || !exclude.has(s.candidate.skillId)) : scoredAll;

  const analysis = analyzeBoard(ctx, state);
  const skillMap = new Map(ctx.engine.listSkills().map((s) => [s.id, s]));
  const tierByIndex = new Map<number, number>();
  const regenPrediction = predictRegenTarget(ctx, state); // §10.6: 再生布の再抽選ステアリング

  // Pass1: 縫い系・糸ほぐし(ぬいパワーシフトの可否判定に必要なため先に確定させる)
  let sewOrRecoverPermitted = 0;
  for (const s of scored) {
    if (s.candidate.action.type === 'finish') continue;
    const skill = skillMap.get(s.candidate.skillId!);
    if (!skill || (skill.kind !== 'sew' && skill.kind !== 'recover')) continue;
    const tier = tierForSewOrRecover(ctx, state, analysis, s.candidate, skill, regenPrediction);
    if (tier !== null) {
      tierByIndex.set(s.index, tier);
      sewOrRecoverPermitted++;
    }
  }

  // Pass2: 支援・必殺(縫い系・糸ほぐし以外)
  for (const s of scored) {
    if (s.candidate.action.type === 'finish') continue;
    if (tierByIndex.has(s.index)) continue;
    const skill = skillMap.get(s.candidate.skillId!);
    if (!skill) continue;

    let tier: number | null = null;
    if (skill.id === 'shitsuke_gake') tier = tierForShitsuke(ctx, state, analysis, s.candidate);
    else if (skill.id === 'seishin_toitsu') tier = tierForSeishin(state, analysis);
    else if (skill.id === 'muga_no_kyochi') tier = tierForMuga(state);
    else if (skill.id === 'power_shift') {
      // C8: adjust かつ縫い系・ほぐしの許可候補が0件のときのみ(v1簡易)
      tier = analysis.phase === 'adjust' && sewOrRecoverPermitted === 0 ? 3 : null;
    }
    if (tier !== null) tierByIndex.set(s.index, tier);
  }

  // finish: star3ならtier0、それ以外はtier98(フォールバック用の暫定値)
  const finishScored = scored.find((s) => s.candidate.action.type === 'finish')!;
  const finishTier = ctx.engine.judge(state).star === 'star3' ? 0 : 98;
  tierByIndex.set(finishScored.index, finishTier);

  const nonFinishPermitted = [...tierByIndex.keys()].some((idx) => idx !== finishScored.index);

  let result: ExpertChoice[];
  if (!nonFinishPermitted && finishTier === 98) {
    // 許可候補がfinish(未達)のみ: ルールの穴のフォールバック。全候補をtier99で返す。
    result = scored.map((s) => ({ scored: s, tier: 99 }));
  } else {
    result = scored.filter((s) => tierByIndex.has(s.index)).map((s) => ({ scored: s, tier: tierByIndex.get(s.index)! }));
  }

  // adjustフェーズ: finish以外の許可候補(tierを持つ候補)のみDPスコアを事前計算する
  // (許可候補に限定して計算量を抑える。§10.4/2)。
  const dpScoreByIndex = new Map<number, number>();
  if (analysis.phase === 'adjust') {
    for (const s of scored) {
      if (s.index === finishScored.index) continue;
      if (!tierByIndex.has(s.index)) continue;
      dpScoreByIndex.set(s.index, dpScoreForCandidate(ctx, state, s.candidate));
    }
  }

  result.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const aIsFinish = a.scored.index === finishScored.index;
    const bIsFinish = b.scored.index === finishScored.index;
    if (analysis.phase === 'adjust' && !aIsFinish && !bIsFinish) {
      const da = dpScoreByIndex.get(a.scored.index);
      const db = dpScoreByIndex.get(b.scored.index);
      if (da !== undefined && db !== undefined && da !== db) return da - db; // 小さいほど良い
    }
    if (b.scored.score !== a.scored.score) return b.scored.score - a.scored.score;
    return a.scored.index - b.scored.index;
  });

  return result;
}

/** rankExpert の先頭候補を1つ返す(必ず1件以上存在する: finishは常に候補に残る)。 */
export function pickExpert(ctx: SolverContext, state: GameState, opts: { exclude?: ReadonlySet<string> } = {}): ScoredCandidate {
  return rankExpert(ctx, state, opts)[0].scored;
}
