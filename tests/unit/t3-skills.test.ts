// T3. 特技 (SPEC §3.3)

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SimulatorConfig, type RecipeDef } from '../../src/core';
import { loadSkills } from '../../src/data';
import {
  buildEngine,
  ScriptedRng,
  baseValueRoll,
  CRIT_NO,
  CRIT_YES,
  HISSATSU_NO,
} from '../fixtures/engine-helpers';

const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'copper', stars: 0 } };

// SPEC §3.3 表: 消費・倍率・習得Lv
const SKILL_SPEC: Record<string, { cost?: number; learnLv?: number; multiplier?: number }> = {
  nuu: { cost: 5, learnLv: 1, multiplier: 1 },
  yoko_nui: { cost: 8, learnLv: 2, multiplier: 1 },
  kagen_nui: { cost: 10, learnLv: 3, multiplier: 0.5 },
  taki_nobori: { cost: 8, learnLv: 5, multiplier: 1 },
  tasuki_nui: { cost: 7, learnLv: 7, multiplier: 1 },
  crit_up_10: { learnLv: 10 },
  nibai_nui: { cost: 9, learnLv: 13, multiplier: 2 },
  suihei_nui: { cost: 10, learnLv: 15, multiplier: 1 },
  seishin_toitsu: { cost: 7, learnLv: 17 },
  otaki_nobori: { cost: 10, learnLv: 19, multiplier: 1 },
  crit_up_20: { learnLv: 20 },
  nerai_nui: { cost: 16, learnLv: 23, multiplier: 1 },
  gyaku_tasuki: { cost: 7, learnLv: 25, multiplier: 1 },
  ito_hogushi: { cost: 16, learnLv: 27 },
  crit_up_30: { learnLv: 30 },
  sanbai_nui: { cost: 12, learnLv: 33, multiplier: 3 },
  power_shift: { cost: 7, learnLv: 38 },
  hissatsu_up: { learnLv: 45 },
  shitsuke_gake: { cost: 13, learnLv: 47 },
  makikomi_nui: { cost: 13, learnLv: 52 },
  han_kagen_nui: { cost: 12, learnLv: 75, multiplier: 0.75 },
  midare_nui: { cost: 7, learnLv: 80 },
  muga_no_kyochi: { cost: 0 },
};

describe('T3 特技データが SPEC と一致', () => {
  const skills = loadSkills();
  const map = new Map(skills.skills.map((s) => [s.id, s]));
  for (const [id, spec] of Object.entries(SKILL_SPEC)) {
    it(`${id}`, () => {
      const s = map.get(id);
      expect(s).toBeDefined();
      if (spec.cost !== undefined) expect(s!.cost).toBe(spec.cost);
      if (spec.learnLv !== undefined) expect(s!.learnLv).toBe(spec.learnLv);
      if (spec.multiplier !== undefined) expect(s!.multiplier).toBe(spec.multiplier);
    });
  }

  it('対象オフセット: 滝のぼり=選択マスとその上 (col2 = [0,0],[-1,0])', () => {
    expect(skills.targetPatterns.col2).toEqual([[0, 0], [-1, 0]]);
  });
  it('対象オフセット: たすきぬい=右上 (diag_up2 = [0,0],[-1,1])', () => {
    expect(skills.targetPatterns.diag_up2).toEqual([[0, 0], [-1, 1]]);
  });
  it('対象オフセット: 巻きこみ plus5', () => {
    expect(skills.targetPatterns.plus5).toEqual([[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]);
  });
});

// 3×3 の再生でも虹でもない通常布レシピ
function grid3x3(base = 200): RecipeDef {
  const cells = [];
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) cells.push({ r, c, base });
  return {
    id: 'g33',
    name: 'g',
    category: 'body_upper',
    clothType: 'normal',
    rows: 3,
    cols: 3,
    cells,
    powerCycle: ['normal'],
  };
}

describe('T3 複数マス独立ロール・独立会心', () => {
  it('ヨコぬい: 2マスがそれぞれ独立に基礎値・会心を消費', () => {
    const engine = buildEngine();
    const { state } = engine.createSession(grid3x3(), config, new ScriptedRng([]));
    // アンカー(1,1) → (1,1)と(1,2)。各: 基礎値+会心。左=会心, 右=非会心
    const rng = new ScriptedRng([
      baseValueRoll(12), CRIT_YES, // (1,1) 会心 → 12*2=24
      baseValueRoll(18), CRIT_NO, // (1,2) 非会心 → 18
      HISSATSU_NO,
    ]);
    const { state: s2, events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'yoko_nui', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    const sews = events.filter((e) => e.kind === 'sewCell');
    expect(sews).toHaveLength(2);
    expect(s2.cells.find((c) => c.r === 1 && c.c === 1)!.cumulative).toBe(24);
    expect(s2.cells.find((c) => c.r === 1 && c.c === 2)!.cumulative).toBe(18);
  });
});

describe('T3 巻きこみぬい: 布端はみ出し無視', () => {
  it('角(1,1)アンカーでは中心+右+下のみ(上・左は布外で無視)', () => {
    const engine = buildEngine();
    const { state } = engine.createSession(grid3x3(500), config, new ScriptedRng([]));
    // plus5 = 中心(1,1) up(0,1)無 down(2,1) left(1,0)無 right(1,2)
    // 有効: (1,1)中心1.5, (2,1)0.75, (1,2)0.75 = 3マス
    const rng = new ScriptedRng([
      baseValueRoll(12), CRIT_NO, // 中心
      baseValueRoll(12), CRIT_NO, // (2,1)
      baseValueRoll(12), CRIT_NO, // (1,2)
      HISSATSU_NO,
    ]);
    const { events } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'makikomi_nui', anchor: { r: 1, c: 1 } },
      config,
      rng,
    );
    const sews = events.filter((e) => e.kind === 'sewCell');
    expect(sews).toHaveLength(3);
  });
});

describe('T3 しつけがけ', () => {
  it('付与→1回縫われたら解除、補正×2が乗る', () => {
    const engine = buildEngine();
    const { state } = engine.createSession(grid3x3(500), config, new ScriptedRng([]));
    // しつけがけ(消費0のダメージ, ターン消費)。support は turnDamage=0
    const { state: s1 } = engine.applyAction(
      state,
      { type: 'sew', skillId: 'shitsuke_gake', anchor: { r: 2, c: 2 } },
      config,
      new ScriptedRng([]),
    );
    expect(s1.cells.find((c) => c.r === 2 && c.c === 2)!.shitsuke).toBe(true);
    // 縫う: base12普通 補正2 = 24。会心なし
    const { state: s2 } = engine.applyAction(
      s1,
      { type: 'sew', skillId: 'nuu', anchor: { r: 2, c: 2 } },
      config,
      new ScriptedRng([baseValueRoll(12), CRIT_NO, HISSATSU_NO]),
    );
    const cell = s2.cells.find((c) => c.r === 2 && c.c === 2)!;
    expect(cell.cumulative).toBe(24); // 補正2適用
    expect(cell.shitsuke).toBe(false); // 縫われて解除
  });
});
