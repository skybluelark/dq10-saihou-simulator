// エキスパートポリシーv1(ルールベース)のテスト

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameState, type Power, type SimulatorConfig } from '../../src/core';
import {
  actionDistribution,
  adjustLookup,
  analyzeBoard,
  createSolverContext,
  pickExpert,
  predictRegenTarget,
  rankExpert,
  tierForRegenPush,
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

// v2(§10.1/10.2): 精神統一は「延長がデフォルト」に反転。残り作業手数の見積もり
// (estimateAdjustMoves相当。3〜10または≤-3=1手、11〜13または≥14=2手、|r|≤2=0手)を基準に、
// 弱着地(初回)・弱延長(デフォルト)・弱→強例外・最強ロック/再ロックを検証する。
describe('精神統一(v2: 延長デフォルト。§10.1/10.2)', () => {
  it('(a) 弱着地(初回): 未ロック・残り作業2手以上(r=11の1マスのみでも2手)でpickExpertが選ぶ(tier0)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [11, 0, 0, 0], 2, {
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

  it('strongest×carve×残りロック2(再ロック)でも上位(tier1)に入る(旧: 残1限定を緩和。§10.2)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [40, 0, 0, 0], 2, {
      currentPower: 'strongest',
      lockPowerRemaining: 2,
      lockedPower: 'strongest',
    });
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

  it('(b) 弱延長(デフォルト): ロック残1×残り作業2手以上(r=5が2マス)では延長がtier0', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [5, 5, 0, 0], 2, {
      currentPower: 'weak',
      lockPowerRemaining: 1,
      lockedPower: 'weak',
    });
    const choices = rankExpert(ctx, state);
    const seishin = choices.find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishin?.tier).toBe(0);
  });

  it('(c) 放棄: ロック残2×残り作業1手(r=7一つ)では現ロック内で仕上げまで届くため延長しない(候補に出ない)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [7, 0, 0, 0], 2, {
      currentPower: 'weak',
      lockPowerRemaining: 2,
      lockedPower: 'weak',
    });
    const choices = rankExpert(ctx, state);
    const seishin = choices.find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishin).toBeUndefined();
  });

  it('(d) 弱→強例外: powerCycle上でロック明け直後がstrong・11≤r≤13のマスがあるときは延長がtier2に下がる', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [12, 0, 0, 0], 2, {
      currentPower: 'weak',
      lockPowerRemaining: 2,
      lockedPower: 'weak',
      powerCycle: ['weak', 'strong'],
      cycleIndex: 0, // (cycleIndex+1)%2=1 → 'strong' がロック明け直後に来る
    });
    const choices = rankExpert(ctx, state);
    const seishin = choices.find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishin?.tier).toBe(2);
  });
});

describe('しつけがけ', () => {
  it('adjustで残り1のマスへのしつけは候補に出ない(連打抑止)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [1, 0, 0, 0], 2, { currentPower: 'weak' });
    const choices = rankExpert(ctx, state);
    expect(findChoice(choices, 'shitsuke_gake', 1, 1)).toBeUndefined();
  });

  it('adjustで残り7のマスへのしつけは候補に出る(tier1。v2: 旧r===7限定→r≥5一律tier1)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [7, 0, 0, 0], 2, { currentPower: 'weak' });
    const choices = rankExpert(ctx, state);
    const choice = findChoice(choices, 'shitsuke_gake', 1, 1);
    expect(choice?.tier).toBe(1);
  });

  it('adjustで残り5未満のマスへのしつけは候補に出ない(r≥5ゲート)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [4, 0, 0, 0], 2, { currentPower: 'weak' });
    const choices = rankExpert(ctx, state);
    expect(findChoice(choices, 'shitsuke_gake', 1, 1)).toBeUndefined();
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
  // v2での挙動変更(判断に迷った点。報告参照): v1では「adjustの単マスレンジ表にr=6を拾う
  // ルールがhan_kagen_nuiのr===6限定しかなく、かつ発光マス(補正×2)ではhan_kagen_nuiがE2で
  // 失格するため、結果的にsew候補が0件になりhogushiが選ばれていた」。
  // v2はティアを合法性ゲート(E2)へ単純化したため、kagen_nui@発光マス(r=6,補正×2)がE2の
  // 境界(非会心最悪=6-10=-4=overshootFloorちょうど。黄色ゲージ|残り|≤4の範囲内)を
  // ぎりぎり満たして候補に復活する。このマスは会心(補正×2で頭打ちにより確実に残り0)と
  // 非会心bv=12(残り0)の両方で誤差0を狙える高EV手であり、D1(発光ターンの有効活用)・
  // A1(誤差0ボーナス)が最上位に押し上げる。E2が守る安全域(黄色ゲージ内)は超えないため、
  // 「縫いすぎ」ではなく「発光マスの正しい活用」と判断した。
  // 元の回帰テストの意図(E2の安全域を超える縫いすぎを選ばない)は維持しつつ、
  // 発光マスへの縫い自体は禁止しないよう assertion を更新する。
  it('光布4マス・残り[0,0,1,6]・(2,2)発光・弱パワー・未ロックではpickExpertがE2の安全域を超える縫いすぎを選ばない', () => {
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
    // v2: kagen_nui@発光マス(r=6)が選ばれる(E2境界ちょうど・高EV。上記コメント参照)。
    expect(picked.candidate.skillId).toBe('kagen_nui');
    expect(picked.candidate.targetCells).toEqual([{ r: 2, c: 2, multiplier: 0.5 }]);

    // 回帰テスト本来の意図(E2の安全域=overshootFloor=-4を超える縫いすぎを選ばない)は維持する。
    const target = picked.candidate.targetCells[0];
    const cell = ctx.engine.cellAt(state, target.r, target.c)!;
    const worstNonCrit = cell.base - cell.cumulative - 10; // kagen_nui@weak・補正2の非会心最大ダメージ=10
    expect(worstNonCrit).toBeGreaterThanOrEqual(-4);
  });
});

// v2(§10.4/2): adjustフェーズの同tier内タイブレークを厳密DP(adjust-dp.ts)のスコアへ置換。
describe('調整フェーズDPスコアリング(§10.4/2)', () => {
  it('盤面[3,0,0,0]・弱(集中30)では先頭候補がkagen_nui(調整DPのfirstOpと一致)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [3, 0, 0, 0], 2, { currentPower: 'weak', concentration: 30 });
    const picked = pickExpert(ctx, state);
    expect(picked.candidate.skillId).toBe('kagen_nui');
    // solver-adjust-dp.test.ts の「E1定石一致」ケースと同条件(b=30)。
    expect(adjustLookup(ctx.adjustDp, 3, 30, false).firstOp).toBe('kagen_nui');
  });

  it('盤面[11,9,7,5]・弱(集中60)ではライン系(11,9をまとめて処置)が単マス(片方のみ)より上位に来る', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [11, 9, 7, 5], 2, { currentPower: 'weak', concentration: 60 });
    const choices = rankExpert(ctx, state);

    const lineIdx = choices.findIndex(
      (ch) =>
        ch.scored.candidate.skillId === 'yoko_nui' &&
        ch.scored.candidate.targetCells.some((t) => t.r === 1 && t.c === 1) &&
        ch.scored.candidate.targetCells.some((t) => t.r === 1 && t.c === 2),
    );
    const singleIdx = choices.findIndex(
      (ch) =>
        ch.scored.candidate.skillId === 'nerai_nui' &&
        ch.scored.candidate.targetCells.length === 1 &&
        ch.scored.candidate.targetCells[0].r === 1 &&
        ch.scored.candidate.targetCells[0].c === 1,
    );
    expect(lineIdx).toBeGreaterThanOrEqual(0);
    expect(singleIdx).toBeGreaterThanOrEqual(0);
    // ライン(11,9両方を改善)は片方だけを改善する単マス候補より順位が高い(DPスコアが良い)。
    expect(lineIdx).toBeLessThan(singleIdx);
  });
});

// v2個別修正(B4/§10.5): 「全対象マスが適正レンジ」→「全対象マスが有効(レンジ内 or
// 非会心最大ダメージでも縫いすぎない大きいマス)」に緩和。
describe('ヨコぬい/滝のぼりの緩和(B4)', () => {
  it('大きいマス(r=27。非会心最悪でも縫いすぎない)+レンジ内マス(r=15)の組合せ@普通ではヨコぬいが候補に出る', () => {
    const ctx = makeCtx();
    // r=27はapproachMin(14)以上・carveMin(28)未満のためapproach局面を維持する。
    // normal・ヨコぬい(倍率1)の非会心最大ダメージ=18のため 27-18=9≥0(縫いすぎなし)。
    // 旧仕様は「全対象マスがbothInRange(14,25)」を要求するため27は対象外だった。
    const state = makeState(ctx, [27, 15, 0, 0], 2, { currentPower: 'normal' });
    const choices = rankExpert(ctx, state);
    const yoko = choices.find(
      (ch) =>
        ch.scored.candidate.skillId === 'yoko_nui' &&
        ch.scored.candidate.targetCells.some((t) => t.r === 1 && t.c === 1) &&
        ch.scored.candidate.targetCells.some((t) => t.r === 1 && t.c === 2),
    );
    expect(yoko).toBeDefined();
    // 基本tier1。PMFに誤差0を含む場合はA1ゼロボーナス(既定0.5)でさらに下がり得る。
    expect(yoko!.tier).toBeGreaterThan(0);
    expect(yoko!.tier).toBeLessThanOrEqual(1);
  });
});

// v2個別修正(§10.3簡易版): 虹布の会心ターン(turn+1がisTraitTurnかつrainbowMode==='up')は
// 多マス候補に限りE2の床をovershootFloor-2(既定-6)へ緩める。
describe('E2会心ターン緩和(§10.3簡易版)', () => {
  it('虹布の会心ターン(turn=8→turn+1=9はup)ではたすきぬい(非会心最悪-5)が候補に出る', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [0, 31, 31, 0], 2, {
      currentPower: 'strongest',
      clothType: 'rainbow',
      turn: 8,
    });
    const choices = rankExpert(ctx, state);
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'tasuki_nui')).toBe(true);
  });

  it('同じ盤面でも通常布では候補に出ない(緩和なし。floor=-4のまま)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [0, 31, 31, 0], 2, {
      currentPower: 'strongest',
      clothType: 'normal',
      turn: 8,
    });
    const choices = rankExpert(ctx, state);
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'tasuki_nui')).toBe(false);
  });

  it('虹布でも会心ターンでなければ緩和されない(turn=4→turn+1=5はhalf)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [0, 31, 31, 0], 2, {
      currentPower: 'strongest',
      clothType: 'rainbow',
      turn: 4,
    });
    const choices = rankExpert(ctx, state);
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'tasuki_nui')).toBe(false);
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

// 再生布の再抽選ステアリング(§10.6/§5)。回復(4ターンごと・+12〜16)を「悪い数値の無料再抽選」
// として扱い、回復先を手番で誘導する手筋。predictRegenTarget(回復先予測)・押し出し
// (黄色内の悪い値を意図的に押し出し打点域へ縫う)・回復先保護(仕上げ間近のマスを回復に
// 巻き込まれないよう避難させる)の3ルールを検証する。
describe('再生布: 再抽選ターゲット予測(predictRegenTarget。§10.6/§5)', () => {
  it('(a) 比最大のマスを返す(base100でcumulative110=残-10 と cumulative90=残+10 → 前者)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [-10, 10, 0, 0], 2, { clothType: 'regen', turn: 1 });
    const pred = predictRegenTarget(ctx, state);
    expect(pred).not.toBeNull();
    expect(pred!.targets).toEqual([{ r: 1, c: 1, remaining: -10 }]);
  });

  it('(b) 黄色ゲージ内(|残り|≤4)のマスは対象外', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [3, -2, 4, -4], 2, { clothType: 'regen', turn: 1 });
    const pred = predictRegenTarget(ctx, state);
    expect(pred!.targets).toEqual([]);
  });

  it('(c) 同率タイは複数返す', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [-10, -10, 0, 0], 2, { clothType: 'regen', turn: 1 });
    const pred = predictRegenTarget(ctx, state);
    expect(pred!.targets).toEqual(
      expect.arrayContaining([
        { r: 1, c: 1, remaining: -10 },
        { r: 1, c: 2, remaining: -10 },
      ]),
    );
    expect(pred!.targets).toHaveLength(2);
  });

  it('(d) turnsUntilの計算: turn=30なら次の再生=T33(現在ターン=state.turn+1=31。規約参照)→turnsUntil=2', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [-10, 0, 0, 0], 2, { clothType: 'regen', turn: 30 });
    const pred = predictRegenTarget(ctx, state);
    expect(pred!.turnsUntil).toBe(2);
  });

  it('regen以外の布ではnullを返す', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [-10, 0, 0, 0], 2, { clothType: 'normal', turn: 30 });
    expect(predictRegenTarget(ctx, state)).toBeNull();
  });
});

describe('再生布: 押し出し(re-roll setup。§10.6/A1f)', () => {
  // carve局面(bigCount≥1)・normalパワーの単マスnuuは既存表だとtier3(デフォルトのフォールバック)。
  // 押し出し条件(turnsUntil≤regenSteerWindow・行動前残り+2/-2/+3・全出目が押し出し域)を
  // 満たす場合はこれを上書きして優先ティアが付くことを確認する。

  it('+2のマスへのnuu@普通(非会心-10〜-16、全出目が[-17,-8]。押し出し域内)はtier1でcarveのデフォルト(tier3)を上書きする', () => {
    const ctx = makeCtx();
    // turn=30 → 現在ターン31、次の再生T33 → turnsUntil=2(regenSteerWindow=3以内)
    const state = makeState(ctx, [2, 30, 0, 0], 2, { currentPower: 'normal', clothType: 'regen', turn: 30 });
    const pred = predictRegenTarget(ctx, state)!;
    expect(pred.turnsUntil).toBeLessThanOrEqual(3);

    const choices = rankExpert(ctx, state);
    const nuu = findChoice(choices, 'nuu', 1, 1);
    expect(nuu).toBeDefined();
    expect(nuu!.tier).toBe(1);
  });

  it('+3のマスへのnuu@普通(非会心-9〜-15。押し出し域内)はtier2でcarveのデフォルト(tier3)を上書きする', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [3, 30, 0, 0], 2, { currentPower: 'normal', clothType: 'regen', turn: 30 });
    const choices = rankExpert(ctx, state);
    const nuu = findChoice(choices, 'nuu', 1, 1);
    expect(nuu).toBeDefined();
    expect(nuu!.tier).toBe(2);
  });

  it(
    '-2のマスは単マス縫いがenumerateCandidates側で候補生成されない(残り≤0の単マス系は「縫う価値なし」除外。' +
      'src/stats/actions.ts buildTargetedCandidate)ため、tierForRegenPushを直接呼んで検証する: ' +
      'nuu@弱の結果は-8〜-11(タスク仕様どおり)で押し出し域[-17,-8]内 → tier1.5',
    () => {
      const ctx = makeCtx();
      const state = makeState(ctx, [-2, 0, 0, 8], 2, {
        currentPower: 'weak',
        lockedPower: 'weak',
        lockPowerRemaining: 2,
        clothType: 'regen',
        turn: 30,
      });
      const skill = ctx.engine.listSkills().find((s) => s.id === 'nuu')!;
      const candidate = {
        action: { type: 'sew' as const, skillId: 'nuu', anchor: { r: 1, c: 1 } },
        skillId: 'nuu',
        cost: ctx.engine.effectiveCost(state, skill),
        targetCells: [{ r: 1, c: 1, multiplier: 1 }],
      };
      const dist = actionDistribution(ctx.engine, state, ctx.config, candidate);
      const cellPmf = dist.cells.find((d) => d.r === 1 && d.c === 1)!.pmf;
      expect(cellPmf.map((p) => p.remaining).sort((a, b) => a - b)).toEqual([-11, -10, -9, -8]);

      const prediction = predictRegenTarget(ctx, state);
      const tier = tierForRegenPush(ctx, state, candidate, skill, dist, prediction);
      expect(tier).toBe(1.5);
    },
  );

  it('turnsUntil > regenSteerWindow(3)の場合は押し出しティアが付かない(carveのデフォルトtier3のまま)', () => {
    const ctx = makeCtx();
    // turn=28 → 現在ターン29(それ自体がT29の再生ターン=適用済み)。次の再生T33 → turnsUntil=4。
    const state = makeState(ctx, [2, 30, 0, 0], 2, { currentPower: 'normal', clothType: 'regen', turn: 28 });
    const pred = predictRegenTarget(ctx, state)!;
    expect(pred.turnsUntil).toBe(4);

    const choices = rankExpert(ctx, state);
    const nuu = findChoice(choices, 'nuu', 1, 1);
    expect(nuu).toBeDefined();
    expect(nuu!.tier).toBe(3); // 押し出し不成立: 通常のcarve/普通デフォルト
  });
});

describe('再生布: 回復先保護(§10.6)', () => {
  it('turnsUntil===1のとき、予測回復対象(r=8。安い仕上げ値)を仕上げる候補のティアが1下がる(turnsUntil=2の同一盤面と比較)', () => {
    const ctx = makeCtx();
    // turn=31 → 現在ターン32、次の再生T33 → turnsUntil=1(保護対象)
    const protectedState = makeState(ctx, [8, 30, 0, 0], 2, { currentPower: 'weak', clothType: 'regen', turn: 31 });
    // turn=30 → turnsUntil=2(保護対象外。押し出し対象値でもない=r8のためpushも不成立)
    const unprotectedState = makeState(ctx, [8, 30, 0, 0], 2, { currentPower: 'weak', clothType: 'regen', turn: 30 });

    const predProtected = predictRegenTarget(ctx, protectedState)!;
    expect(predProtected.turnsUntil).toBe(1);
    expect(predProtected.targets).toEqual([{ r: 1, c: 1, remaining: 8 }]);

    const predUnprotected = predictRegenTarget(ctx, unprotectedState)!;
    expect(predUnprotected.turnsUntil).toBe(2);

    const tierProtected = findChoice(rankExpert(ctx, protectedState), 'nuu', 1, 1)!.tier;
    const tierUnprotected = findChoice(rankExpert(ctx, unprotectedState), 'nuu', 1, 1)!.tier;

    // 保護による-1のみを厳密に切り出す(A1誤差0ボーナス等の他補正は両ケースで同一のため相殺される)。
    expect(tierProtected).toBe(tierUnprotected - 1);
  });

  it('r=6(再抽選許容値。保護対象外)では回復1手前でもティアが変わらない', () => {
    const ctx = makeCtx();
    const protectedState = makeState(ctx, [6, 30, 0, 0], 2, { currentPower: 'weak', clothType: 'regen', turn: 31 });
    const unprotectedState = makeState(ctx, [6, 30, 0, 0], 2, { currentPower: 'weak', clothType: 'regen', turn: 30 });

    expect(predictRegenTarget(ctx, protectedState)!.turnsUntil).toBe(1);

    const tierProtected = findChoice(rankExpert(ctx, protectedState), 'nuu', 1, 1)?.tier;
    const tierUnprotected = findChoice(rankExpert(ctx, unprotectedState), 'nuu', 1, 1)?.tier;
    expect(tierProtected).toBe(tierUnprotected);
  });
});
