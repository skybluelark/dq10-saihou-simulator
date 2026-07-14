// エキスパートポリシーv1 (ソルバー拡張: トップ勢の判断基準のルールベース実装)
//
// 設計: ティア方式。ルールが候補の許可/禁止と優先ティア(小さいほど優先)を決め、
// 同ティア内は既存の静的評価スコア(scoreCandidates)でタイブレークする。
// 出典タグ(A1・B1〜B4・C1〜C9・D1〜D2・E1〜E3)は docs/SOLVER_POLICY.md 対応節。
//
// 前提: state は beginTurn 済み(currentPower 確定)。乱数・Date は使用しない(決定的)。

import { isTraitTurn } from '../core';
import type { Engine, GameState, Power, SkillDef } from '../core';
import { actionDistribution } from './distribution';
import { scoreCandidates } from './evaluate';
import type {
  ActionDistribution,
  BoardAnalysis,
  Candidate,
  ExpertChoice,
  Phase,
  ScoredCandidate,
  SolverContext,
} from './types';
import { DEFAULT_POLICY_PARAMS } from './types';

const P = DEFAULT_POLICY_PARAMS;

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
const MULTI_CELL_IDS = new Set([
  'yoko_nui',
  'taki_nobori',
  'tasuki_nui',
  'gyaku_tasuki',
  'suihei_nui',
  'otaki_nobori',
  'makikomi_nui',
]);

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
  const floor = regenRelaxed ? (phase === 'carve' ? P.regenCarveFloor : P.regenOvershootFloor) : P.overshootFloor;

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

// ---- 特技別ティア判定 ----

function remainingAt(engine: Engine, state: GameState, r: number, c: number): number {
  const cell = engine.cellAt(state, r, c);
  if (!cell) throw new Error(`対象マスが存在しません: (${r},${c})`);
  return cell.base - cell.cumulative;
}

/** 糸ほぐし(C5/A1)。 */
function tierForHogushi(ctx: SolverContext, state: GameState, analysis: BoardAnalysis, candidate: Candidate): number | null {
  const t = candidate.targetCells[0];
  const r = remainingAt(ctx.engine, state, t.r, t.c);

  if (r <= -3) return 1;
  if (r === -2 || r === -1) return 3;
  // それ以外(+側): adjust かつ集中余裕時の「+2→ほぐし→かげん」ルート(A1)。
  // 集中余裕の閾値はPolicyParamsに専用項目がないため carveMin(既定28)を流用する。
  if (analysis.phase === 'adjust' && state.concentration >= P.carveMin) return 2;
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
  // ② しつけ→かげんで誤差1以内確定
  if (analysis.phase === 'adjust' && r === 7) return 2;
  // ③ 光布: 次ターンが発光ターンでないときのみ
  if (state.clothType === 'light' && r === 16 && !isTraitTurn(state.turn + 2, ctx.data.params)) return 3;

  return null;
}

/** ねらいぬい(C3。v1簡易判定)。E2は縫い系として別途適用済みの前提。 */
function tierForNerai(state: GameState, analysis: BoardAnalysis): number | null {
  if (state.massCount === 4) return 2;
  if (analysis.phase === 'adjust') return 2;
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

/** ヨコぬい/滝のぼり専用のレンジ判定(C2「明確な理由」。カバー範囲外は禁止=catch-allなし)。 */
function tierForYokoTaki(
  engine: Engine,
  state: GameState,
  analysis: BoardAnalysis,
  candidate: Candidate,
): number | null {
  if (candidate.targetCells.length !== 2) return null;
  const eff = effPower(state.currentPower);
  const rs = candidate.targetCells.map((t) => remainingAt(engine, state, t.r, t.c));
  const bothInRange = (lo: number, hi: number): boolean => rs.every((r) => r >= lo && r <= hi);
  const bothAtLeast = (min: number): boolean => rs.every((r) => r >= min);

  if (analysis.phase === 'carve') {
    if ((eff === 'strongest' || eff === 'strong') && bothAtLeast(P.approachMin)) return 1;
    return null;
  }
  if (analysis.phase === 'approach') {
    if (eff === 'normal' && bothInRange(14, 25)) return 1;
    if (eff === 'strong' && bothInRange(16, 27)) return 1;
    return null;
  }
  return null; // adjust: 多マス系は禁止(MULTI_CELL_IDSで別途処理)
}

/** たすき系・3マス系・巻きこみ・単マス系(みだれ/ねらいを除く縫い全般)のティア表。 */
function tierForGeneralSew(
  ctx: SolverContext,
  state: GameState,
  analysis: BoardAnalysis,
  candidate: Candidate,
  skill: SkillDef,
): number | null {
  const eff = effPower(state.currentPower);
  const engine = ctx.engine;
  const rs = (): number[] => candidate.targetCells.map((t) => remainingAt(engine, state, t.r, t.c));
  const r0 = (): number => remainingAt(engine, state, candidate.targetCells[0].r, candidate.targetCells[0].c);
  const atLeast2 = (min: number): boolean => rs().filter((r) => r >= min).length >= 2;

  if (analysis.phase === 'adjust') {
    if (MULTI_CELL_IDS.has(skill.id)) return null; // 終盤暴発の抑止(多マス系は再生布のみみだれ側で許可)
    const r = r0();
    if (r >= 3 && r <= 5 && skill.id === 'kagen_nui' && eff === 'weak') return 1;
    if (r === 6 && skill.id === 'han_kagen_nui' && eff === 'weak') return 1;
    if (r >= 7 && r <= 10 && skill.id === 'nuu' && eff === 'weak') return 1;
    if (r >= 11 && r <= 13 && skill.id === 'kagen_nui' && eff === 'strong') return 1;
    // p が weak 以外で適正手がない場合の残り14以上フォールバック(tier2)は adjust の定義上
    // (bigCount=0 かつ midCount=0)到達不能のため実装しない。
    return null;
  }

  if (YOKOTAKI_IDS.has(skill.id)) return tierForYokoTaki(engine, state, analysis, candidate);

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
        if (skill.id === 'nuu' && r >= 6 && r <= 9) return 1;
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

/** 精神統一(C7/A4①)。 */
function tierForSeishin(state: GameState, analysis: BoardAnalysis): number | null {
  const unlocked = state.lockPowerRemaining === 0;
  const needFine = analysis.fineCount + analysis.overCount >= 2;

  if (state.currentPower === 'strongest' && analysis.phase === 'carve' && unlocked) return 1;
  if (state.currentPower === 'weak' && analysis.phase === 'adjust' && unlocked && needFine) return 0; // 着地。最優先
  if (state.lockPowerRemaining === 1) {
    if (state.lockedPower === 'strongest' && analysis.phase === 'carve') return 1; // 延長(再ロック実測)
    if (state.lockedPower === 'weak' && analysis.phase === 'adjust' && needFine) return 1;
  }
  if (state.currentPower === 'strong' && analysis.phase === 'approach' && analysis.midCount >= 3) return 2;

  return null;
}

/** 無我の境地(C9)。 */
function tierForMuga(state: GameState): number | null {
  return state.currentPower !== 'strongest' ? 2 : null;
}

// ---- ディスパッチ・全体統括 ----

/** 縫い系(みだれ・ねらい含む)・糸ほぐしのティアを決める(E2/D1/A1込み)。 */
function tierForSewOrRecover(
  ctx: SolverContext,
  state: GameState,
  analysis: BoardAnalysis,
  candidate: Candidate,
  skill: SkillDef,
): number | null {
  if (skill.kind === 'recover') return tierForHogushi(ctx, state, analysis, candidate);

  // skill.kind === 'sew'
  const dist = actionDistribution(ctx.engine, state, ctx.config, candidate);

  let tier: number | null;
  if (skill.target === 'random4') {
    tier = tierForMidare(state, analysis, dist);
  } else {
    if (!passesE2(ctx, state, analysis.phase, candidate, dist)) return null; // E2は最優先の安全ゲート
    tier = skill.id === 'nerai_nui' ? tierForNerai(state, analysis) : tierForGeneralSew(ctx, state, analysis, candidate, skill);
  }
  if (tier === null) return null;

  if (targetsGlowCell(state, candidate)) tier -= 1; // D1: 発光ターンの有効活用
  if (hasZeroBonus(dist)) tier -= P.zeroBonusTier; // A1: 誤差0ボーナス

  return tier;
}

/**
 * エキスパートポリシーv1による候補ランキング(ソルバー拡張)。
 * ルールが許可/禁止とティアを決め、同ティア内は静的評価スコアでタイブレークする。
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

  // Pass1: 縫い系・糸ほぐし(ぬいパワーシフトの可否判定に必要なため先に確定させる)
  let sewOrRecoverPermitted = 0;
  for (const s of scored) {
    if (s.candidate.action.type === 'finish') continue;
    const skill = skillMap.get(s.candidate.skillId!);
    if (!skill || (skill.kind !== 'sew' && skill.kind !== 'recover')) continue;
    const tier = tierForSewOrRecover(ctx, state, analysis, s.candidate, skill);
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

  result.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (b.scored.score !== a.scored.score) return b.scored.score - a.scored.score;
    return a.scored.index - b.scored.index;
  });

  return result;
}

/** rankExpert の先頭候補を1つ返す(必ず1件以上存在する: finishは常に候補に残る)。 */
export function pickExpert(ctx: SolverContext, state: GameState, opts: { exclude?: ReadonlySet<string> } = {}): ScoredCandidate {
  return rankExpert(ctx, state, opts)[0].scored;
}
