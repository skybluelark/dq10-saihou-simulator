// マス別仕上げテーブル(事前計算DP) (ソルバー基盤モジュール3)
//
// 残り値 r∈[rMin,rMax] ごとに、単マス縫い/糸ほぐしを dpDepth 手先まで最適に選んだときの
// 期待誤差評価値・期待手数・期待所要集中力を動的計画法で事前計算する。
// マス補正(correction)×無我(muga)の4変種を用意する。
//
// 注: このテーブルは state(powerCycle等)を参照できないため、使用可能パワーは
// weak/normal/strong/strongest の4種すべてとみなす('unknown'を含む場合の扱いと同じ。
// critx2は係数1でnormalに畳まれるため個別には扱わない)。詳細は報告事項を参照。

import { sewDamage, hogushiDamage, computeCritRate, cellErrorScore } from '../core';
import type { Engine, EngineData, Power, SimulatorConfig } from '../core';
import { DEFAULT_SOLVER_PARAMS } from './types';
import type { FinishEntry, SolverContext, SolverParams } from './types';

/** テーブルDPで走査するぬいパワー(state非依存のため全種を候補とする)。 */
const TABLE_POWERS: Power[] = ['weak', 'normal', 'strong', 'strongest'];

function tableKey(correction: 1 | 2, muga: 0 | 1): string {
  return `${correction}|${muga}`;
}

/** 1変種(correction×muga)分の仕上げテーブルをDPで構築する。 */
function buildFinishTable(
  data: EngineData,
  config: SimulatorConfig,
  params: SolverParams,
  correction: 1 | 2,
  muga: 0 | 1,
): FinishEntry[] {
  const { rMin, rMax, dpDepth } = params;
  const size = rMax - rMin + 1;
  const gauge = data.params.gauge;

  const needle = data.needles.needles.find((n) => n.id === config.needle.type);
  if (!needle) throw new Error(`不明な針: ${config.needle.type}`);
  const needleCritRate = needle.critRate[config.needle.stars];

  // 単マス縫い(かげん・半かげん・ぬう・2倍ぬい・3倍ぬい・ねらいぬい)のうち config.level で使用可能なもの
  const sewOps = data.skills.skills.filter(
    (s) => s.kind === 'sew' && s.target === 'single' && (s.learnLv === undefined || s.learnLv <= config.level),
  );
  const hogushiOp = data.skills.skills.find(
    (s) => s.kind === 'recover' && (s.learnLv === undefined || s.learnLv <= config.level),
  );

  const critRateCache = new Map<string, number>();
  const critRateFor = (aim: boolean): number => {
    const key = aim ? 'aim' : 'normal';
    const cached = critRateCache.get(key);
    if (cached !== undefined) return cached;
    const rate = computeCritRate(data.params, {
      needleCritRate,
      kotsu: config.kotsu,
      passiveCritUp: config.passives.critUp,
      aim,
      rainbowCritTurn: false,
      lightGlowCell: false,
      mugaActive: muga === 1,
      shiftCrit: false,
    });
    critRateCache.set(key, rate);
    return rate;
  };

  const clampIdx = (r: number): number => Math.max(rMin, Math.min(rMax, r)) - rMin;

  // k=0: 「そのまま」の誤差評価値・手数0・コスト0
  let E: number[] = new Array(size);
  let cost: number[] = new Array(size).fill(0);
  let act: number[] = new Array(size).fill(0);
  for (let i = 0; i < size; i++) {
    E[i] = cellErrorScore(rMin + i, gauge.yellowRange, gauge.penaltyError);
  }

  for (let k = 0; k < dpDepth; k++) {
    const nextE = E.slice();
    const nextCost = cost.slice();
    const nextAct = act.slice();

    for (let idx = 0; idx < size; idx++) {
      const r = rMin + idx;
      // 「そのまま」(操作しない)を基準に、各操作×パワーで改善するか比較する
      let bestE = E[idx];
      let bestCost = cost[idx];
      let bestAct = act[idx];

      for (const skill of sewOps) {
        const mult = skill.multiplier ?? 1;
        const aim = skill.aim === true;
        const p = critRateFor(aim);
        const skillCost = skill.cost ?? 0;

        for (const power of TABLE_POWERS) {
          let expE = 0;
          let expCost = 0;
          let expAct = 0;
          for (let bv = 12; bv <= 18; bv++) {
            const d0 = sewDamage(bv, mult, power, correction);
            if (r > 0) {
              // 会心(頭打ちあり)
              const dCrit = Math.min(d0 * 2, r);
              const idxCrit = clampIdx(r - dCrit);
              expE += (1 / 7) * p * E[idxCrit];
              expCost += (1 / 7) * p * cost[idxCrit];
              expAct += (1 / 7) * p * act[idxCrit];
              // 非会心(頭打ちなし)
              const idxNon = clampIdx(r - d0);
              expE += (1 / 7) * (1 - p) * E[idxNon];
              expCost += (1 / 7) * (1 - p) * cost[idxNon];
              expAct += (1 / 7) * (1 - p) * act[idxNon];
            } else {
              const idxNon = clampIdx(r - d0);
              expE += (1 / 7) * E[idxNon];
              expCost += (1 / 7) * cost[idxNon];
              expAct += (1 / 7) * act[idxNon];
            }
          }
          if (expE < bestE) {
            bestE = expE;
            bestCost = skillCost + expCost;
            bestAct = 1 + expAct;
          }
        }
      }

      if (hogushiOp) {
        const skillCost = hogushiOp.cost ?? 0;
        for (const power of TABLE_POWERS) {
          let expE = 0;
          let expCost = 0;
          let expAct = 0;
          for (let roll = 6; roll <= 9; roll++) {
            const d = hogushiDamage(-roll, power, correction); // 負値(初期状態頭打ちはテーブルでは無視)
            const idxNext = clampIdx(r - d);
            expE += (1 / 4) * E[idxNext];
            expCost += (1 / 4) * cost[idxNext];
            expAct += (1 / 4) * act[idxNext];
          }
          if (expE < bestE) {
            bestE = expE;
            bestCost = skillCost + expCost;
            bestAct = 1 + expAct;
          }
        }
      }

      nextE[idx] = bestE;
      nextCost[idx] = bestCost;
      nextAct[idx] = bestAct;
    }

    E = nextE;
    cost = nextCost;
    act = nextAct;
  }

  const entries: FinishEntry[] = new Array(size);
  for (let idx = 0; idx < size; idx++) {
    entries[idx] = { expErr: E[idx], actions: act[idx], conc: cost[idx] };
  }
  return entries;
}

/** ソルバーコンテキストを構築する(4変種の仕上げテーブルを事前計算)。 */
export function createSolverContext(
  engine: Engine,
  data: EngineData,
  config: SimulatorConfig,
  params: SolverParams = DEFAULT_SOLVER_PARAMS,
): SolverContext {
  const tables = new Map<string, FinishEntry[]>();
  for (const correction of [1, 2] as const) {
    for (const muga of [0, 1] as const) {
      tables.set(tableKey(correction, muga), buildFinishTable(data, config, params, correction, muga));
    }
  }
  return { engine, data, config, params, tables };
}

/** 仕上げテーブルの参照(域外はドメイン端にクランプ)。 */
export function lookupFinish(ctx: SolverContext, r: number, correction: 1 | 2, muga: 0 | 1): FinishEntry {
  const { rMin, rMax } = ctx.params;
  const clamped = Math.max(rMin, Math.min(rMax, Math.round(r)));
  const table = ctx.tables.get(tableKey(correction, muga));
  if (!table) throw new Error(`仕上げテーブル未構築: correction=${correction}, muga=${muga}`);
  return table[clamped - rMin];
}
