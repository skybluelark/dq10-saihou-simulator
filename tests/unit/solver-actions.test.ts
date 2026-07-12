// ソルバー基盤モジュール1: 候補列挙 (enumerateCandidates) のテスト

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameState, type SimulatorConfig } from '../../src/core';
import { enumerateCandidates, type Candidate } from '../../src/stats';
import { buildEngine } from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

type CellOverride = { cumulative?: number; shitsuke?: boolean };

/** 3×3 全9マスの盤面(既定: base=100・累積0・集中207)。 */
function grid3x3(
  engine: ReturnType<typeof buildEngine>,
  stateOver: Record<string, unknown> = {},
  cellOver: (r: number, c: number) => CellOverride = () => ({}),
): GameState {
  const cells = [];
  for (let r = 1; r <= 3; r++) {
    for (let c = 1; c <= 3; c++) {
      cells.push({ r, c, base: 100, cumulative: 0, shitsuke: false, ...cellOver(r, c) });
    }
  }
  return engine.createStateFromSnapshot({
    recipeId: 'solver-actions',
    category: 'test',
    rows: 3,
    cols: 3,
    cells,
    powerCycle: ['normal'],
    concentration: 207,
    ...stateOver,
  });
}

function skillIds(candidates: Candidate[]): (string | null)[] {
  return candidates.map((c) => c.skillId);
}

describe('enumerateCandidates: 基本構造', () => {
  it('finish が常に先頭', () => {
    const engine = buildEngine();
    const state = grid3x3(engine);
    const candidates = enumerateCandidates(engine, state, config);
    expect(candidates[0]).toEqual({ action: { type: 'finish' }, skillId: null, cost: 0, targetCells: [] });
  });

  it('パッシブは候補に出ない', () => {
    const engine = buildEngine();
    const state = grid3x3(engine);
    const candidates = enumerateCandidates(engine, state, config);
    for (const id of ['crit_up_10', 'crit_up_20', 'crit_up_30', 'hissatsu_up']) {
      expect(skillIds(candidates)).not.toContain(id);
    }
  });

  it('列挙は決定的(2回呼んで同一)', () => {
    const engine = buildEngine();
    const state = grid3x3(engine);
    const c1 = enumerateCandidates(engine, state, config);
    const c2 = enumerateCandidates(engine, state, config);
    expect(c2).toEqual(c1);
  });
});

describe('enumerateCandidates: アンカー重複排除(3×3全マス盤面)', () => {
  it('水平ぬい(row3)は各行1候補に重複排除される(対象は行全体3マス)', () => {
    const engine = buildEngine();
    const state = grid3x3(engine);
    const candidates = enumerateCandidates(engine, state, config);
    const suihei = candidates.filter((c) => c.skillId === 'suihei_nui');
    expect(suihei).toHaveLength(3);
    for (const c of suihei) {
      expect(c.targetCells).toHaveLength(3);
    }
  });

  it('ヨコぬい(row2)は各行2候補', () => {
    const engine = buildEngine();
    const state = grid3x3(engine);
    const candidates = enumerateCandidates(engine, state, config);
    const yoko = candidates.filter((c) => c.skillId === 'yoko_nui');
    expect(yoko).toHaveLength(6); // 3行 × 2候補
  });

  it('単マス特技(ぬう)はマスごと9候補', () => {
    const engine = buildEngine();
    const state = grid3x3(engine);
    const candidates = enumerateCandidates(engine, state, config);
    const nuu = candidates.filter((c) => c.skillId === 'nuu');
    expect(nuu).toHaveLength(9);
  });
});

describe('enumerateCandidates: 除外規則', () => {
  it('集中力不足の特技はすべて除外される(finishのみ残る)', () => {
    const engine = buildEngine();
    const state = grid3x3(engine, { concentration: 4 }); // 最安のnuu(cost5)にも満たない
    const candidates = enumerateCandidates(engine, state, config);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].action).toEqual({ type: 'finish' });
  });

  it('縫い系: 対象の全マスが残り≤0なら除外(1マスでも残り>0なら残す)', () => {
    const engine = buildEngine();
    // (1,1),(1,2) は残り0、他は残り100
    const state = grid3x3(engine, {}, (r, c) => {
      if (r === 1 && (c === 1 || c === 2)) return { cumulative: 100 };
      return {};
    });
    const candidates = enumerateCandidates(engine, state, config);

    // ぬう(1,1): 対象は自身のみ、残り0 → 除外
    const nuuAt11 = candidates.some(
      (c) => c.skillId === 'nuu' && c.targetCells.length === 1 && c.targetCells[0].r === 1 && c.targetCells[0].c === 1,
    );
    expect(nuuAt11).toBe(false);

    // ヨコぬい anchor(1,1)→対象(1,1),(1,2): ともに残り0 → 除外
    const yoko11_12 = candidates.some(
      (c) =>
        c.skillId === 'yoko_nui' &&
        c.targetCells.length === 2 &&
        c.targetCells.every((t) => (t.r === 1 && t.c === 1) || (t.r === 1 && t.c === 2)),
    );
    expect(yoko11_12).toBe(false);

    // ヨコぬい anchor(1,2)→対象(1,2),(1,3): (1,3)は残り>0 → 1マスでも残りありなら残す
    const yoko12_13 = candidates.some(
      (c) =>
        c.skillId === 'yoko_nui' &&
        c.targetCells.length === 2 &&
        c.targetCells.every((t) => (t.r === 1 && t.c === 2) || (t.r === 1 && t.c === 3)),
    );
    expect(yoko12_13).toBe(true);
  });

  it('糸ほぐし: 累積0のマスは除外、累積>0のマスは候補になる', () => {
    const engine = buildEngine();
    const state = grid3x3(engine, {}, (r, c) => (r === 2 && c === 2 ? { cumulative: 30 } : {}));
    const candidates = enumerateCandidates(engine, state, config);
    const hogushi = candidates.filter((c) => c.skillId === 'ito_hogushi');
    expect(hogushi).toHaveLength(1);
    expect(hogushi[0].targetCells).toEqual([{ r: 2, c: 2, multiplier: 1 }]);
  });

  it('しつけがけ: shitsuke===true または残り≤0 のマスは除外・重複掛けなし', () => {
    const engine = buildEngine();
    const state = grid3x3(engine, {}, (r, c) => {
      if (r === 1 && c === 1) return { shitsuke: true };
      if (r === 1 && c === 2) return { cumulative: 100 }; // 残り0
      return {};
    });
    const candidates = enumerateCandidates(engine, state, config);
    const shitsuke = candidates.filter((c) => c.skillId === 'shitsuke_gake');
    expect(shitsuke).toHaveLength(7); // 9マス - shitsuke済み1 - 残り0の1
    expect(shitsuke.some((c) => c.targetCells[0].r === 1 && c.targetCells[0].c === 1)).toBe(false);
    expect(shitsuke.some((c) => c.targetCells[0].r === 1 && c.targetCells[0].c === 2)).toBe(false);
  });

  it('learnLvフィルタ: config.levelを下げると高レベル特技が除外される', () => {
    const engine = buildEngine();
    const state = grid3x3(engine);
    const lowLevelConfig: SimulatorConfig = { ...config, level: 10 };
    const candidates = enumerateCandidates(engine, state, lowLevelConfig);
    expect(skillIds(candidates)).not.toContain('nibai_nui'); // learnLv13
    expect(skillIds(candidates)).toContain('nuu'); // learnLv1
  });

  it('無我の境地: チャージ保持中かつ未使用のときのみ候補', () => {
    const engine = buildEngine();
    const notCharged = grid3x3(engine, { hissatsuCharged: false, hissatsuUsed: false });
    expect(skillIds(enumerateCandidates(engine, notCharged, config))).not.toContain('muga_no_kyochi');

    const chargedUnused = grid3x3(engine, { hissatsuCharged: true, hissatsuUsed: false });
    expect(skillIds(enumerateCandidates(engine, chargedUnused, config))).toContain('muga_no_kyochi');

    const usedAlready = grid3x3(engine, { hissatsuCharged: true, hissatsuUsed: true });
    expect(skillIds(enumerateCandidates(engine, usedAlready, config))).not.toContain('muga_no_kyochi');
  });
});
