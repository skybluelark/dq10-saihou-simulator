// 候補行動の列挙 (ソルバー基盤モジュール1)
//
// 前提: state は beginTurn 済み(currentPower 確定)。
// 列挙順は決定的(finish→listSkills()順→state.cells順)。後段のタイブレークに使う。

import type { CellState, Engine, GameState, SimulatorConfig, SkillDef } from '../core';
import type { Candidate } from './types';

/** 候補のキー(重複排除用)。skillId + 存在対象マスの (r,c,multiplier) を r,c 昇順で連結。 */
function targetKey(
  skillId: string,
  targetCells: { r: number; c: number; multiplier: number }[],
): string {
  const sorted = [...targetCells].sort((a, b) => a.r - b.r || a.c - b.c);
  return `${skillId}|${sorted.map((t) => `${t.r},${t.c},${t.multiplier}`).join(';')}`;
}

/** 対象あり特技(sew の single/ライン系/plus5、recover、support の cellCorrection)の候補を1アンカー分生成。除外なら null。 */
function buildTargetedCandidate(
  engine: Engine,
  state: GameState,
  skill: SkillDef,
  anchor: { r: number; c: number },
  cost: number,
): Candidate | null {
  const resolved = engine.resolveTargets(skill, anchor, state.rows, state.cols);
  const existing: { r: number; c: number; multiplier: number; cell: CellState }[] = [];
  for (const t of resolved) {
    const cell = engine.cellAt(state, t.r, t.c);
    if (cell) existing.push({ ...t, cell });
  }
  if (existing.length === 0) return null; // 対象マスが1つも存在しない

  if (skill.kind === 'sew') {
    // 縫い系: 対象の全マスが残り≤0なら縫う価値なし
    const allNonPositive = existing.every((t) => t.cell.base - t.cell.cumulative <= 0);
    if (allNonPositive) return null;
  } else if (skill.kind === 'recover') {
    // 糸ほぐし: 対象マスの cumulative===0 なら回復余地なし
    const cell = existing[0].cell;
    if (cell.cumulative === 0) return null;
  } else if (skill.kind === 'support' && skill.effect === 'cellCorrection') {
    // しつけがけ: 対象マスが shitsuke===true または残り≤0 なら除外
    const cell = existing[0].cell;
    const remaining = cell.base - cell.cumulative;
    if (cell.shitsuke || remaining <= 0) return null;
  }

  const targetCells = existing.map((t) => ({ r: t.r, c: t.c, multiplier: t.multiplier }));
  return {
    action: { type: 'sew', skillId: skill.id, anchor },
    skillId: skill.id,
    cost,
    targetCells,
  };
}

/**
 * 候補行動を決定的な順序で列挙する(ソルバー基盤モジュール1)。
 * 先頭に finish、以降 engine.listSkills() の順に候補を並べる。
 */
export function enumerateCandidates(
  engine: Engine,
  state: GameState,
  config: SimulatorConfig,
): Candidate[] {
  const candidates: Candidate[] = [];
  candidates.push({ action: { type: 'finish' }, skillId: null, cost: 0, targetCells: [] });

  const seenKeys = new Set<string>();

  for (const skill of engine.listSkills()) {
    if (skill.kind === 'passive') continue;
    if (skill.learnLv !== undefined && skill.learnLv > config.level) continue;

    const cost = engine.effectiveCost(state, skill);
    if (cost > state.concentration) continue;

    if (skill.kind === 'hissatsu') {
      // 無我の境地: チャージ保持中かつ未使用のときのみ候補
      if (state.hissatsuCharged && !state.hissatsuUsed) {
        candidates.push({ action: { type: 'skill', skillId: skill.id }, skillId: skill.id, cost, targetCells: [] });
      }
      continue;
    }

    if (skill.kind === 'sew' && skill.target === 'random4') {
      // みだれぬい: 全マスの残りが≤0なら除外
      const anyPositive = state.cells.some((cell) => cell.base - cell.cumulative > 0);
      if (!anyPositive) continue;
      candidates.push({ action: { type: 'skill', skillId: skill.id }, skillId: skill.id, cost, targetCells: [] });
      continue;
    }

    if (skill.kind === 'support' && skill.effect !== 'cellCorrection') {
      // 精神統一・ぬいパワーシフト: 対象なし、常に候補
      candidates.push({ action: { type: 'skill', skillId: skill.id }, skillId: skill.id, cost, targetCells: [] });
      continue;
    }

    // 対象あり特技: sew(single/ライン系/plus5)、recover、support(cellCorrection)。
    // 各マスをアンカーとして state.cells の順に展開し、対象マス集合が同一の候補は最初の1つのみ残す。
    for (const anchorCell of state.cells) {
      const anchor = { r: anchorCell.r, c: anchorCell.c };
      const candidate = buildTargetedCandidate(engine, state, skill, anchor, cost);
      if (!candidate) continue;

      const key = targetKey(skill.id, candidate.targetCells);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      candidates.push(candidate);
    }
  }

  return candidates;
}
