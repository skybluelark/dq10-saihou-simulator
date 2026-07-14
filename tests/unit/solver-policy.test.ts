// エキスパートポリシーv1(ルールベース)のテスト

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameState, type Power, type SimulatorConfig } from '../../src/core';
import {
  analyzeBoard,
  createSolverContext,
  pickExpert,
  rankExpert,
  type ExpertChoice,
  type SolverContext,
} from '../../src/stats';
import { buildEngine, buildEngineData } from '../fixtures/engine-helpers';

// タスク仕様どおり: DEFAULT_CONFIG + 奇跡針★3
const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'miracle', stars: 3 } };

function makeCtx(): SolverContext {
  const engine = buildEngine();
  const data = buildEngineData();
  return createSolverContext(engine, data, config);
}

/** remaining値の列から盤面セルを組み立てる(base=100固定、cumulative=100-remaining)。 */
function buildCells(remainings: number[], cols: number) {
  return remainings.map((rem, i) => {
    const r = Math.floor(i / cols) + 1;
    const c = (i % cols) + 1;
    return { r, c, base: 100, cumulative: 100 - rem, shitsuke: false };
  });
}

/** remaining値の列から GameState を組み立てる(既定: currentPower=normal・集中200・turnStarted済み)。 */
function makeState(ctx: SolverContext, remainings: number[], cols: number, overrides: Record<string, unknown> = {}): GameState {
  const cells = buildCells(remainings, cols);
  const rows = Math.ceil(remainings.length / cols);
  return ctx.engine.createStateFromSnapshot({
    recipeId: 'policy-test',
    category: 'test',
    rows,
    cols,
    cells,
    massCount: remainings.length,
    powerCycle: ['normal'],
    currentPower: 'normal',
    concentration: 200,
    turnStarted: true,
    hissatsuUsed: true,
    ...overrides,
  });
}

function findChoice(choices: ExpertChoice[], skillId: string, r: number, c: number): ExpertChoice | undefined {
  return choices.find(
    (ch) => ch.scored.candidate.skillId === skillId && ch.scored.candidate.targetCells.some((t) => t.r === r && t.c === c),
  );
}

describe('analyzeBoard: 局面判定・マス分類', () => {
  it('残り≥carveMin(28)のマスがあれば carve', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [40, 10, 5, 0], 2);
    const a = analyzeBoard(ctx, state);
    expect(a.phase).toBe('carve');
    expect(a.bigCount).toBe(1);
  });

  it('bigCountが0でmidCount(approachMin=14以上carveMin未満)があれば approach', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [20, 10, 5, 0], 2);
    const a = analyzeBoard(ctx, state);
    expect(a.phase).toBe('approach');
    expect(a.midCount).toBe(1);
  });

  it('bigCount=0・midCount=0なら adjust(fineCount/overCountの分類も検証)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [10, 5, 0, -5], 2);
    const a = analyzeBoard(ctx, state);
    expect(a.phase).toBe('adjust');
    expect(a.fineCount).toBe(2); // 10, 5 (3<=r<14)
    expect(a.overCount).toBe(1); // -5 (<=-3)
  });

  it('弱パワー固定中(lockPowerRemaining>0)は big/mid があっても常に adjust', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [40, 10, 5, 0], 2, {
      currentPower: 'weak',
      lockedPower: 'weak',
      lockPowerRemaining: 2,
    });
    const a = analyzeBoard(ctx, state);
    expect(a.phase).toBe('adjust');
    expect(a.weakLocked).toBe(true);
  });
});

describe('E2縫いすぎ禁止プルーン', () => {
  it('残り6のマスへの3倍@strongestは候補に出ない(通常布)', () => {
    const ctx = makeCtx();
    // (1,2)=30 で carve 局面を確保。対象は(1,1)=6。残り2マスはmassCount(4/6/7/9)合わせのダミー。
    const state = makeState(ctx, [6, 30, 0, 0], 2, { currentPower: 'strongest', clothType: 'normal' });
    const choices = rankExpert(ctx, state);
    expect(findChoice(choices, 'sanbai_nui', 1, 1)).toBeUndefined();
  });

  it('同条件の縫いすぎでも再生布なら緩和される(regenCarveFloor境界)', () => {
    const ctx = makeCtx();
    // 2倍ぬい@normal・残り6: 非会心最悪値=-30(regenCarveFloorちょうど)。通常布は禁止、再生布は許可。
    const normalState = makeState(ctx, [6, 30, 0, 0], 2, { currentPower: 'normal', clothType: 'normal' });
    expect(findChoice(rankExpert(ctx, normalState), 'nibai_nui', 1, 1)).toBeUndefined();

    const regenState = makeState(ctx, [6, 30, 0, 0], 2, { currentPower: 'normal', clothType: 'regen' });
    const regenChoice = findChoice(rankExpert(ctx, regenState), 'nibai_nui', 1, 1);
    expect(regenChoice).toBeDefined();
  });

  it('残り≤0への縫いは通常布で禁止・再生布で許可', () => {
    const ctx = makeCtx();
    // 単マス特技は対象(自身のみ)が残り≤0だと enumerateCandidates 自体が除外するため、
    // 一部マスのみ残り≤0の複数マス特技(たすきぬい)で検証する。
    // (1,1)=30でcarve局面、対象は(2,1)=0・(1,2)=10(diag_up2アンカー(2,1))。
    const cells = [
      { r: 1, c: 1, base: 100, cumulative: 70, shitsuke: false }, // 残り30
      { r: 1, c: 2, base: 100, cumulative: 90, shitsuke: false }, // 残り10
      { r: 2, c: 1, base: 100, cumulative: 100, shitsuke: false }, // 残り0(対象)
      { r: 2, c: 2, base: 100, cumulative: 100, shitsuke: false }, // 残り0(ダミー)
    ];
    const base = {
      recipeId: 'e2-zero',
      category: 'test',
      rows: 2,
      cols: 2,
      cells,
      massCount: 4,
      powerCycle: ['normal'] as Power[],
      currentPower: 'weak' as const,
      concentration: 200,
      turnStarted: true,
      hissatsuUsed: true,
    };
    const normalState = ctx.engine.createStateFromSnapshot({ ...base, clothType: 'normal' });
    expect(findChoice(rankExpert(ctx, normalState), 'tasuki_nui', 2, 1)).toBeUndefined();

    const regenState = ctx.engine.createStateFromSnapshot({ ...base, clothType: 'regen' });
    expect(findChoice(rankExpert(ctx, regenState), 'tasuki_nui', 2, 1)).toBeDefined();
  });
});

describe('みだれぬい', () => {
  it('carve(全マス大=ストップロス充足)では tier1系(上位)で候補に出る', () => {
    const ctx = makeCtx();
    // C1: 2倍打の最大値(強=54)が最小マスに当たっても midareStopLoss(-16)以上になる盤面
    const state = makeState(ctx, [60, 55, 50, 45], 2, { currentPower: 'strong', clothType: 'normal' });
    const choices = rankExpert(ctx, state);
    const midare = choices.find((ch) => ch.scored.candidate.skillId === 'midare_nui');
    expect(midare).toBeDefined();
    expect(midare!.tier).toBe(1);
  });

  it('carveでも仕上がったマス(残り0)が混在するならストップロス超過で候補に出ない(C1)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [40, 0, 0, 0], 2, { currentPower: 'strong', clothType: 'normal' });
    const choices = rankExpert(ctx, state);
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'midare_nui')).toBe(false);
  });

  it('adjust(全マス13以下)では候補に出ない(通常布)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [13, 10, 5, 0], 2, { currentPower: 'strong', clothType: 'normal' });
    const choices = rankExpert(ctx, state);
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'midare_nui')).toBe(false);
  });

  it('再生布ならストップロス緩和の範囲内(弱パワー)で候補に出る(tier3)', () => {
    const ctx = makeCtx();
    // 弱の2倍打最大=18。最小マス4でも 4-18=-14 ≥ regenOvershootFloor(-16) → 許可
    const state = makeState(ctx, [13, 10, 5, 4], 2, { currentPower: 'weak', clothType: 'regen' });
    const choices = rankExpert(ctx, state);
    const midare = choices.find((ch) => ch.scored.candidate.skillId === 'midare_nui');
    expect(midare).toBeDefined();
    // 基本tier3。PMFに誤差0を含む場合はゼロボーナス(A1)で-0.5され得る
    expect(midare!.tier).toBeGreaterThanOrEqual(2.5);
    expect(midare!.tier).toBeLessThanOrEqual(3);
  });
});

describe('精神統一', () => {
  it('弱ターン×adjust×未ロック(誤差マス2以上)ではpickExpertが精神統一を選ぶ(tier0)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [5, 5, 0, 0], 2, {
      currentPower: 'weak',
      lockPowerRemaining: 0,
      lockedPower: null,
    });
    const choices = rankExpert(ctx, state);
    const seishin = choices.find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishin?.tier).toBe(0);
    expect(pickExpert(ctx, state).candidate.skillId).toBe('seishin_toitsu');
  });

  it('strongest×carve×未ロックでは上位(tier1)に入る', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [40, 0, 0, 0], 2, { currentPower: 'strongest', lockPowerRemaining: 0, lockedPower: null });
    const choices = rankExpert(ctx, state);
    const seishin = choices.find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishin?.tier).toBe(1);
  });

  it('approach局面でmidCount<3・strong以外では候補に出ない', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [20, 0, 0, 0], 2, { currentPower: 'normal', lockPowerRemaining: 0, lockedPower: null });
    const choices = rankExpert(ctx, state);
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'seishin_toitsu')).toBe(false);
  });

  it('ロック残1×weak×adjust(誤差マス2以上)では延長が候補に出る(tier1)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [5, 5, 0, 0], 2, {
      currentPower: 'weak',
      lockPowerRemaining: 1,
      lockedPower: 'weak',
    });
    const choices = rankExpert(ctx, state);
    const seishin = choices.find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishin?.tier).toBe(1);
  });
});

describe('しつけがけ', () => {
  it('adjustで残り1のマスへのしつけは候補に出ない(連打抑止)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [1, 0, 0, 0], 2, { currentPower: 'weak' });
    const choices = rankExpert(ctx, state);
    expect(findChoice(choices, 'shitsuke_gake', 1, 1)).toBeUndefined();
  });

  it('adjustで残り7のマスへのしつけは候補に出る(tier2)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [7, 0, 0, 0], 2, { currentPower: 'weak' });
    const choices = rankExpert(ctx, state);
    const choice = findChoice(choices, 'shitsuke_gake', 1, 1);
    expect(choice?.tier).toBe(2);
  });
});

describe('ねらいぬい(v1簡易判定)', () => {
  it('9マス通常布のcarveでは候補に出ない', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, new Array(9).fill(50), 3, { currentPower: 'normal', clothType: 'normal' });
    const choices = rankExpert(ctx, state);
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'nerai_nui')).toBe(false);
  });

  it('4マスでは(phaseによらず)候補に出る(tier2)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, new Array(4).fill(50), 2, { currentPower: 'normal', clothType: 'normal' });
    const choices = rankExpert(ctx, state);
    const nerai = choices.find((ch) => ch.scored.candidate.skillId === 'nerai_nui');
    expect(nerai?.tier).toBe(2);
  });
});

describe('ユーザー報告事例の回帰(光布・発光マスへの縫いすぎ)', () => {
  it('光布4マス・残り[0,0,1,6]・(2,2)発光・弱パワー・未ロックではpickExpertが発光マスへの縫いを選ばない', () => {
    const ctx = makeCtx();
    const cells = [
      { r: 1, c: 1, base: 30, cumulative: 30, shitsuke: false }, // 残り0
      { r: 1, c: 2, base: 30, cumulative: 30, shitsuke: false }, // 残り0
      { r: 2, c: 1, base: 30, cumulative: 29, shitsuke: false }, // 残り1
      { r: 2, c: 2, base: 30, cumulative: 24, shitsuke: false }, // 残り6(発光中)
    ];
    const state = ctx.engine.createStateFromSnapshot({
      recipeId: 'test_light',
      clothType: 'light',
      rows: 2,
      cols: 2,
      massCount: 4,
      cells,
      powerCycle: ['normal'],
      currentPower: 'weak',
      lockPowerRemaining: 0,
      lockedPower: null,
      glowCell: { r: 2, c: 2 },
      turnStarted: true,
      hissatsuUsed: true,
      concentration: 100,
    });

    const picked = pickExpert(ctx, state);
    const sewSkillIds = new Set(ctx.engine.listSkills().filter((s) => s.kind === 'sew').map((s) => s.id));
    const isSewOnGlowCell =
      picked.candidate.skillId !== null &&
      sewSkillIds.has(picked.candidate.skillId) &&
      picked.candidate.targetCells.some((t) => t.r === 2 && t.c === 2);
    expect(isSewOnGlowCell).toBe(false);
  });
});

describe('フォールバック(ルールの穴)', () => {
  it('集中力がほぼ尽きた盤面(縫い候補が全部コスト超過)でもpickExpertが何かを返す', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [50, 50, 50, 50], 2, { currentPower: 'normal', concentration: 3 }); // 最安nuu(cost5)未満
    const choices = rankExpert(ctx, state);
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.every((ch) => ch.tier === 99)).toBe(true);

    const picked = pickExpert(ctx, state);
    expect(picked.candidate.action.type).toBe('finish');
  });
});

describe('決定論', () => {
  it('同一入力で2回呼んでもrankExpertが同一', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [40, 20, 10, 5, 0, -5], 3, { currentPower: 'strong', clothType: 'normal' });
    const r1 = rankExpert(ctx, state);
    const r2 = rankExpert(ctx, state);
    expect(r2).toEqual(r1);
  });
});
