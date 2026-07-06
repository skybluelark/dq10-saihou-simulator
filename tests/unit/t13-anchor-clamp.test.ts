// T13. ライン系特技のアンカー自動置換(クランプ)と
//      空きマスのアンカー選択・対象0件の行動不成立 (SPEC v1.4 §3.1 / §3.3)

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  clampAnchorForPattern,
  type Engine,
  type GameState,
  type SimulatorConfig,
  type TurnEvent,
} from '../../src/core';
import { loadSkills } from '../../src/data';
import {
  buildEngine,
  parseRealRecipes,
  ScriptedRng,
  baseValueRoll,
  CRIT_NO,
  HISSATSU_NO,
} from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

/** sewCell イベントの対象位置を "r,c" のリストで返す(イベント発行順)。 */
function sewnAt(events: TurnEvent[]): string[] {
  return events
    .filter((e): e is Extract<TurnEvent, { kind: 'sewCell' }> => e.kind === 'sewCell')
    .map((e) => `${e.r},${e.c}`);
}

/** 任意形状のグリッド状態を作る(通常布・パワー普通・集中207)。 */
function gridState(
  engine: Engine,
  rows: number,
  cols: number,
  positions: [number, number][],
  over: Record<string, unknown> = {},
): GameState {
  return engine.createStateFromSnapshot({
    recipeId: 't13',
    category: 'test',
    rows,
    cols,
    cells: positions.map(([r, c]) => ({ r, c, base: 500, cumulative: 0, shitsuke: false })),
    powerCycle: ['normal'],
    concentration: 207,
    ...over,
  });
}

const FULL_3X3: [number, number][] = [];
for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) FULL_3X3.push([r, c]);

const FULL_3X2: [number, number][] = [];
for (let r = 1; r <= 3; r++) for (let c = 1; c <= 2; c++) FULL_3X2.push([r, c]);

// 頭の凸形(2行×3列、(1,1)・(1,3)欠け)
const HEAD_CONVEX: [number, number][] = [
  [1, 2],
  [2, 1],
  [2, 2],
  [2, 3],
];

/** 2マス特技のロール(基礎値2+会心2+必殺1)。 */
const ROLLS_2CELL = [baseValueRoll(12), CRIT_NO, baseValueRoll(12), CRIT_NO, HISSATSU_NO];
/** 3マス特技のロール。 */
const ROLLS_3CELL = [
  baseValueRoll(12),
  CRIT_NO,
  baseValueRoll(12),
  CRIT_NO,
  baseValueRoll(12),
  CRIT_NO,
  HISSATSU_NO,
];

describe('T13 clampAnchorForPattern の許容範囲式', () => {
  const patterns = loadSkills().targetPatterns;

  it('row2(ヨコぬい): 3列グリッドで c∈[1,2]、2列グリッドで c∈[1,1]', () => {
    const p = patterns.row2;
    expect(clampAnchorForPattern('row2', p, { r: 1, c: 3 }, 3, 3)).toEqual({ r: 1, c: 2 });
    expect(clampAnchorForPattern('row2', p, { r: 1, c: 2 }, 3, 3)).toEqual({ r: 1, c: 2 }); // 範囲内は変化なし
    expect(clampAnchorForPattern('row2', p, { r: 2, c: 2 }, 3, 2)).toEqual({ r: 2, c: 1 });
  });

  it('col2(滝のぼり): r∈[2,rows]。1行目→2行目', () => {
    const p = patterns.col2;
    expect(clampAnchorForPattern('col2', p, { r: 1, c: 2 }, 3, 3)).toEqual({ r: 2, c: 2 });
    expect(clampAnchorForPattern('col2', p, { r: 3, c: 1 }, 3, 3)).toEqual({ r: 3, c: 1 });
  });

  it('row3(水平ぬい): 3列グリッドで c∈[2,2]。1列目・3列目→2列目', () => {
    const p = patterns.row3;
    expect(clampAnchorForPattern('row3', p, { r: 2, c: 1 }, 3, 3)).toEqual({ r: 2, c: 2 });
    expect(clampAnchorForPattern('row3', p, { r: 2, c: 3 }, 3, 3)).toEqual({ r: 2, c: 2 });
  });

  it('row3: 2列グリッドでは範囲が空([2,1]) → 下限値2を採用', () => {
    const p = patterns.row3;
    expect(clampAnchorForPattern('row3', p, { r: 1, c: 1 }, 3, 2)).toEqual({ r: 1, c: 2 });
  });

  it('col3(大滝のぼり): 3行グリッドで r∈[2,2]。1行目・3行目→2行目', () => {
    const p = patterns.col3;
    expect(clampAnchorForPattern('col3', p, { r: 1, c: 2 }, 3, 3)).toEqual({ r: 2, c: 2 });
    expect(clampAnchorForPattern('col3', p, { r: 3, c: 2 }, 3, 3)).toEqual({ r: 2, c: 2 });
  });

  it('col3: 2行グリッド(頭)では範囲が空([2,1]) → 下限値2を採用', () => {
    const p = patterns.col3;
    expect(clampAnchorForPattern('col3', p, { r: 1, c: 2 }, 2, 3)).toEqual({ r: 2, c: 2 });
  });

  it('diag_up2(たすきぬい): r∈[2,rows], c∈[1,cols-1]', () => {
    const p = patterns.diag_up2;
    expect(clampAnchorForPattern('diag_up2', p, { r: 1, c: 1 }, 3, 3)).toEqual({ r: 2, c: 1 });
    expect(clampAnchorForPattern('diag_up2', p, { r: 2, c: 3 }, 3, 3)).toEqual({ r: 2, c: 2 });
  });

  it('diag_down2(逆たすきぬい): r∈[2,rows], c∈[2,cols]', () => {
    const p = patterns.diag_down2;
    expect(clampAnchorForPattern('diag_down2', p, { r: 1, c: 1 }, 3, 3)).toEqual({ r: 2, c: 2 });
  });

  it('plus5(巻きこみぬい)・single は置換されない', () => {
    expect(clampAnchorForPattern('plus5', patterns.plus5, { r: 1, c: 1 }, 3, 3)).toEqual({ r: 1, c: 1 });
    expect(clampAnchorForPattern('single', patterns.single, { r: 1, c: 1 }, 3, 3)).toEqual({ r: 1, c: 1 });
  });
});

describe('T13 エンジンでのアンカー自動置換(コア resolveTargets)', () => {
  it('ヨコぬい: 3列グリッドで3列目→2列目((1,2)+(1,3)を縫う)', () => {
    const engine = buildEngine();
    const state = gridState(engine, 3, 3, FULL_3X3);
    const { events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'yoko_nui', anchor: { r: 1, c: 3 } },
      config,
      new ScriptedRng(ROLLS_2CELL),
    );
    expect(sewnAt(events)).toEqual(['1,2', '1,3']);
  });

  it('ヨコぬい: 2列グリッドで2列目→1列目((2,1)+(2,2)を縫う)', () => {
    const engine = buildEngine();
    const state = gridState(engine, 3, 2, FULL_3X2);
    const { events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'yoko_nui', anchor: { r: 2, c: 2 } },
      config,
      new ScriptedRng(ROLLS_2CELL),
    );
    expect(sewnAt(events)).toEqual(['2,1', '2,2']);
  });

  it('滝のぼり: 1行目→2行目((2,2)+(1,2)を縫う)', () => {
    const engine = buildEngine();
    const state = gridState(engine, 3, 3, FULL_3X3);
    const { events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'taki_nobori', anchor: { r: 1, c: 2 } },
      config,
      new ScriptedRng(ROLLS_2CELL),
    );
    // col2 = [0,0],[-1,0] を置換後アンカー(2,2)に適用
    expect(sewnAt(events)).toEqual(['2,2', '1,2']);
  });

  it('水平ぬい: 1列目・3列目→2列目(行全体を縫う)', () => {
    const engine = buildEngine();
    for (const anchorC of [1, 3]) {
      const state = gridState(engine, 3, 3, FULL_3X3);
      const { events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'suihei_nui', anchor: { r: 2, c: anchorC } },
        config,
        new ScriptedRng(ROLLS_3CELL),
      );
      expect(sewnAt(events)).toEqual(['2,1', '2,2', '2,3']);
    }
  });

  it('大滝のぼり: 1行目・3行目→2行目(列全体を縫う)', () => {
    const engine = buildEngine();
    for (const anchorR of [1, 3]) {
      const state = gridState(engine, 3, 3, FULL_3X3);
      const { events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'otaki_nobori', anchor: { r: anchorR, c: 2 } },
        config,
        new ScriptedRng(ROLLS_3CELL),
      );
      expect(sewnAt(events)).toEqual(['1,2', '2,2', '3,2']);
    }
  });

  it('たすきぬい: 1行目→2行目・3列目→2列目に置換', () => {
    const engine = buildEngine();
    // (1,1) → 置換後(2,1): 対象 (2,1),(1,2)
    const s1 = gridState(engine, 3, 3, FULL_3X3);
    const r1 = engine.applyAction(
      s1,
      { type: 'sew', skillId: 'tasuki_nui', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng(ROLLS_2CELL),
    );
    expect(sewnAt(r1.events)).toEqual(['2,1', '1,2']);
    // (2,3) → 置換後(2,2): 対象 (2,2),(1,3)
    const s2 = gridState(engine, 3, 3, FULL_3X3);
    const r2 = engine.applyAction(
      s2,
      { type: 'sew', skillId: 'tasuki_nui', anchor: { r: 2, c: 3 } },
      config,
      new ScriptedRng(ROLLS_2CELL),
    );
    expect(sewnAt(r2.events)).toEqual(['2,2', '1,3']);
  });

  it('逆たすきぬい: (1,1)→置換後(2,2): 対象 (2,2),(1,1)', () => {
    const engine = buildEngine();
    const state = gridState(engine, 3, 3, FULL_3X3);
    const { events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'gyaku_tasuki', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng(ROLLS_2CELL),
    );
    expect(sewnAt(events)).toEqual(['2,2', '1,1']);
  });

  it('巻きこみぬいは置換されない(角アンカーのまま、はみ出し分は無視)', () => {
    const engine = buildEngine();
    const state = gridState(engine, 3, 3, FULL_3X3);
    // plus5 anchor(1,1): 中心(1,1), 下(2,1), 右(1,2) の3マス(上・左は布外)
    const { events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'makikomi_nui', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng(ROLLS_3CELL),
    );
    expect(sewnAt(events)).toEqual(['1,1', '2,1', '1,2']);
  });

  it('水平ぬい: 2列グリッドでは下限値2列目へ置換し、存在する2マスのみ縫う', () => {
    const engine = buildEngine();
    const state = gridState(engine, 3, 2, FULL_3X2);
    // c範囲 [2,1] が空 → c=2。対象 (1,1),(1,2),(1,3) → (1,3)は布外で無視
    const { events, state: s2 } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'suihei_nui', anchor: { r: 1, c: 1 } },
      config,
      new ScriptedRng(ROLLS_2CELL),
    );
    expect(sewnAt(events)).toEqual(['1,1', '1,2']);
    expect(s2.turn).toBe(1);
  });
});

describe('T13 空きマスのアンカーと対象0件の行動不成立 (SPEC §3.1)', () => {
  it('単マス特技(ぬう)を空き位置に使用 → invalidTarget(ターン・集中力・盤面不変・乱数非消費)', () => {
    const engine = buildEngine();
    const state = gridState(engine, 2, 3, HEAD_CONVEX);
    const rng = new ScriptedRng([]); // 何も消費しないはず
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(events.find((e) => e.kind === 'invalidTarget')).toMatchObject({ skillId: 'nuu' });
    expect(events.find((e) => e.kind === 'skillUsed')).toBeUndefined();
    expect(rng.consumed()).toBe(0);
    expect(s2.turn).toBe(0); // ターン非消費
    expect(s2.concentration).toBe(207); // 集中力非消費
    expect(s2.cells.every((c) => c.cumulative === 0)).toBe(true); // 盤面不変
  });

  it('複数マス特技で一部欠け → 存在するマスのみ縫ってターンが進む', () => {
    const engine = buildEngine();
    const state = gridState(engine, 2, 3, HEAD_CONVEX);
    // ヨコぬい anchor(1,1): 対象 (1,1)欠け,(1,2)存在 → (1,2)のみ
    const rng = new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'yoko_nui', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(sewnAt(events)).toEqual(['1,2']);
    expect(s2.turn).toBe(1);
    expect(s2.concentration).toBe(207 - 8);
  });

  it('複数マス特技で全対象が欠け → invalidTarget(不成立)', () => {
    const engine = buildEngine();
    // 3×3 のうち (1,1),(2,1) が欠けた7マス布。
    // 滝のぼり anchor(1,1) → 置換後(2,1): 対象 (2,1),(1,1) とも欠け
    const positions = FULL_3X3.filter(([r, c]) => !(c === 1 && (r === 1 || r === 2)));
    const state = gridState(engine, 3, 3, positions);
    const rng = new ScriptedRng([]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'taki_nobori', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(events.find((e) => e.kind === 'invalidTarget')).toMatchObject({ skillId: 'taki_nobori' });
    expect(rng.consumed()).toBe(0);
    expect(s2.turn).toBe(0);
    expect(s2.concentration).toBe(207);
  });

  it('糸ほぐしの対象が欠け位置 → invalidTarget(throwしない)', () => {
    const engine = buildEngine();
    const state = gridState(engine, 2, 3, HEAD_CONVEX);
    const rng = new ScriptedRng([]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'ito_hogushi', anchor: { r: 1, c: 3 } },
      config,
      rng,
    );
    expect(events.find((e) => e.kind === 'invalidTarget')).toMatchObject({ skillId: 'ito_hogushi' });
    expect(rng.consumed()).toBe(0);
    expect(s2.turn).toBe(0);
    expect(s2.concentration).toBe(207);
  });

  it('しつけがけの対象が欠け位置 → invalidTarget(throwしない)', () => {
    const engine = buildEngine();
    const state = gridState(engine, 2, 3, HEAD_CONVEX);
    const rng = new ScriptedRng([]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'shitsuke_gake', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    expect(events.find((e) => e.kind === 'invalidTarget')).toMatchObject({ skillId: 'shitsuke_gake' });
    expect(rng.consumed()).toBe(0);
    expect(s2.turn).toBe(0);
    expect(s2.concentration).toBe(207);
    expect(s2.cells.every((c) => !c.shitsuke)).toBe(true);
  });
});

describe('T13 頭の凸形レシピ(実データ)での縫い', () => {
  it('賢哲のターバン: ぬう(2,1)が縫える・大滝のぼり(1,2)は下限2行目へ置換し2マス縫う', () => {
    const engine = buildEngine();
    const { recipes } = parseRealRecipes();
    const recipe = recipes.find((r) => r.id === 'kentetsu_turban')!;
    expect(recipe.rows).toBe(2);
    expect(recipe.cols).toBe(3);

    // 虹布だがターン1は特性発動なし。パワーサイクル先頭=普通(？でない)。copper針=開幕効果なし。
    const { state } = engine.createSession(recipe, config, new ScriptedRng([]));

    // ぬう: 凸形の存在マス(2,1)
    const r1 = engine.applyAction(
      state,
      { type: 'sew', skillId: 'nuu', anchor: { r: 2, c: 1 } },
      config,
      new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]),
    );
    expect(sewnAt(r1.events)).toEqual(['2,1']);
    expect(r1.state.turn).toBe(1);

    // 大滝のぼり anchor(1,2): 2行グリッドで r範囲[2,1]が空 → 下限r=2へ置換。
    // 対象 (1,2),(2,2),(3,2) のうち存在する2マスを縫う
    const r2 = engine.applyAction(
      state,
      { type: 'sew', skillId: 'otaki_nobori', anchor: { r: 1, c: 2 } },
      config,
      new ScriptedRng(ROLLS_2CELL),
    );
    expect(sewnAt(r2.events)).toEqual(['1,2', '2,2']);
    expect(r2.state.turn).toBe(1);
  });

  it('賢哲のターバン: 単マス特技を欠け位置(1,1)/(1,3)に使うと invalidTarget', () => {
    const engine = buildEngine();
    const { recipes } = parseRealRecipes();
    const recipe = recipes.find((r) => r.id === 'kentetsu_turban')!;
    const { state } = engine.createSession(recipe, config, new ScriptedRng([]));
    for (const c of [1, 3]) {
      const rng = new ScriptedRng([]);
      const { state: s2, events } = engine.applyAction(
        state,
        { type: 'sew', skillId: 'nibai_nui', anchor: { r: 1, c } },
        config,
        rng,
      );
      expect(events.find((e) => e.kind === 'invalidTarget')).toBeDefined();
      expect(s2.turn).toBe(0);
    }
  });
});
