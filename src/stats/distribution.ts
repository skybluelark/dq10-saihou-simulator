// 1手の結果分布(乱数を使わない厳密な離散分布) (ソルバー基盤モジュール2)
//
// 前提: state は beginTurn 済み(currentPower 確定)。
// エンジンの実装(engine.ts の sewOneCell / doHogushi / doMidare)と完全に同じ規則で計算する。

import { sewDamage, hogushiDamage } from '../core';
import type { CellState, Engine, GameState, SimulatorConfig, SkillDef } from '../core';
import type { ActionDistribution, Candidate, CellPmf } from './types';

/** 確率マップへ加算する(同値のキーはマージされる)。 */
function addProb(map: Map<number, number>, key: number, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

/** 確率マップを remaining 昇順の CellPmf に変換し、確率合計=1を内部で保証する。 */
function toPmf(map: Map<number, number>): CellPmf {
  const pmf: CellPmf = Array.from(map.entries())
    .map(([remaining, prob]) => ({ remaining, prob }))
    .sort((a, b) => a.remaining - b.remaining);
  const sum = pmf.reduce((acc, p) => acc + p.prob, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`PMFの確率合計が1になりません(sum=${sum})`);
  }
  return pmf;
}

/**
 * 1マス縫い(糸ほぐし以外)の結果分布。基礎値12〜18が各1/7。
 * 残り>0のマスのみ会心判定(会心のみ基準値頭打ち、非会心は縫いすぎを許容)。
 */
export function sewCellPmf(
  engine: Engine,
  state: GameState,
  cell: CellState,
  multiplier: number,
  config: SimulatorConfig,
  aim: boolean,
): CellPmf {
  const correction = engine.cellCorrection(state, cell);
  const remainingBefore = cell.base - cell.cumulative;
  const results = new Map<number, number>();
  const pBase = 1 / 7;

  const critRate = remainingBefore > 0 ? engine.critRate(state, cell, config, aim) : 0;

  for (let baseValue = 12; baseValue <= 18; baseValue++) {
    const damage0 = sewDamage(baseValue, multiplier, state.currentPower, correction);

    if (remainingBefore > 0) {
      // 会心(頭打ちあり)
      let critDamage = damage0 * 2;
      if (critDamage > remainingBefore) critDamage = remainingBefore;
      addProb(results, remainingBefore - critDamage, pBase * critRate);
      // 非会心(頭打ちなし)
      addProb(results, remainingBefore - damage0, pBase * (1 - critRate));
    } else {
      // 会心判定なし
      addProb(results, remainingBefore - damage0, pBase);
    }
  }

  return toPmf(results);
}

/**
 * 糸ほぐしの結果分布。出目6〜9が各1/4。初期状態(累積0)で頭打ち。
 */
export function hogushiCellPmf(engine: Engine, state: GameState, cell: CellState): CellPmf {
  const correction = engine.cellCorrection(state, cell);
  const remainingBefore = cell.base - cell.cumulative;
  const results = new Map<number, number>();

  for (let roll = 6; roll <= 9; roll++) {
    let damage = hogushiDamage(-roll, state.currentPower, correction);
    if (cell.cumulative + damage < 0) {
      damage = -cell.cumulative; // 初期状態頭打ち
    }
    addProb(results, remainingBefore - damage, 1 / 4);
  }

  return toPmf(results);
}

/**
 * みだれぬいの周辺分布近似。n = state.cells.length として、
 * 各マスは倍率2,1,1,0.5をそれぞれ確率1/nで受け、確率1-4/nで無変化。
 * 各倍率のPMFは sewCellPmf を流用して混合する(倍率1が2口ある点に注意)。
 */
function midareDistribution(
  engine: Engine,
  state: GameState,
  config: SimulatorConfig,
  skill: SkillDef,
): ActionDistribution {
  const multipliers = skill.multipliers as number[]; // [2,1,1,0.5]
  const n = state.cells.length;
  const noChangeProb = 1 - multipliers.length / n;

  const cells = state.cells.map((cell) => {
    const remainingBefore = cell.base - cell.cumulative;
    const results = new Map<number, number>();
    addProb(results, remainingBefore, noChangeProb);
    for (const m of multipliers) {
      const pmf = sewCellPmf(engine, state, cell, m, config, false);
      for (const point of pmf) {
        addProb(results, point.remaining, point.prob / n);
      }
    }
    return { r: cell.r, c: cell.c, pmf: toPmf(results) };
  });

  return { cells };
}

/**
 * 候補行動の結果分布(ソルバー基盤モジュール2)。
 * sew(single/ライン系/plus5)は対象マスごとに sewCellPmf、recover は hogushiCellPmf、
 * みだれぬいは周辺分布近似。support/hissatsu/finish は分布なし(cells: [])。
 */
export function actionDistribution(
  engine: Engine,
  state: GameState,
  config: SimulatorConfig,
  candidate: Candidate,
): ActionDistribution {
  const { action, skillId } = candidate;
  if (action.type !== 'sew' && action.type !== 'skill') return { cells: [] }; // finish

  const skill = engine.listSkills().find((s) => s.id === skillId);
  if (!skill) throw new Error(`不明な特技: ${String(skillId)}`);

  if (skill.kind === 'support' || skill.kind === 'hissatsu') return { cells: [] };

  if (skill.kind === 'sew' && skill.target === 'random4') {
    return midareDistribution(engine, state, config, skill);
  }

  const aim = skill.aim === true;
  const cells = candidate.targetCells.map((t) => {
    const cell = engine.cellAt(state, t.r, t.c);
    if (!cell) throw new Error(`対象マスが存在しません: (${t.r},${t.c})`);
    const pmf =
      skill.kind === 'recover'
        ? hogushiCellPmf(engine, state, cell)
        : sewCellPmf(engine, state, cell, t.multiplier, config, aim);
    return { r: t.r, c: t.c, pmf };
  });

  return { cells };
}
