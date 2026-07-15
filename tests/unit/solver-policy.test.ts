// エキスパートポリシーv1(ルールベース)のテスト

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameState, type Power, type SimulatorConfig } from '../../src/core';
import {
  actionDistribution,
  adjustLookup,
  adjustScoreForCandidate,
  analyzeBoard,
  composeStar3Prob,
  createSolverContext,
  pickExpert,
  predictRegenTarget,
  rankExpert,
  regenImpactDelta,
  star3ErrorLimit,
  tierForRegenPush,
  type ActionDistribution,
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

// v3a(§10.8): adjustフェーズの同tier内タイブレークを、厳密DPのexpErr最小化(旧§10.4/2)から
// ★3確率合成スコア(pStar3降順→expErr昇順。adjustScoreForCandidate)へ置換。
describe('調整フェーズ★3確率合成スコアリング(§10.8/v3a)', () => {
  it('盤面[3,0,0,0]・弱(集中30)では先頭候補がkagen_nui(調整DPのfirstOpと一致)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [3, 0, 0, 0], 2, { currentPower: 'weak', concentration: 30 });
    const picked = pickExpert(ctx, state);
    expect(picked.candidate.skillId).toBe('kagen_nui');
    // solver-adjust-dp.test.ts の「E1定石一致」ケースと同条件(b=30)。
    expect(adjustLookup(ctx.adjustDp, 3, 30, false).firstOp).toBe('kagen_nui');
  });

  // v3a+償却校正(3.5。§10.8②)後の関係: ライン系(yoko_nui: 11,9を1手で処置)が単マス(ねらい)を
  // pStar3で上回る。ロック維持償却は「1手あたり」に乗るため、1手で2マス進むライン系は維持費を
  // 折半でき、残りマスへ回せる集中も増える(§10.5「1手で2マス進む」の利点が償却に比例して増す。
  // 償却2時代は単マス優位に反転していたが、統一7÷純増2手=3.5への校正でライン優位に戻った)。
  // pStar3の直接比較と、rankExpertの順位がその大小と整合することを検証する。
  it('盤面[11,9,7,5]・弱(集中60)ではライン系(yoko_nui@(1,1)(1,2))のpStar3が単マス(ねらい@(1,1))を上回り、順位も上位に来る', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [11, 9, 7, 5], 2, { currentPower: 'weak', concentration: 60 });
    const choices = rankExpert(ctx, state);

    const lineChoice = choices.find(
      (ch) =>
        ch.scored.candidate.skillId === 'yoko_nui' &&
        ch.scored.candidate.targetCells.some((t) => t.r === 1 && t.c === 1) &&
        ch.scored.candidate.targetCells.some((t) => t.r === 1 && t.c === 2),
    )!;
    const singleChoice = choices.find(
      (ch) =>
        ch.scored.candidate.skillId === 'nerai_nui' &&
        ch.scored.candidate.targetCells.length === 1 &&
        ch.scored.candidate.targetCells[0].r === 1 &&
        ch.scored.candidate.targetCells[0].c === 1,
    )!;
    expect(lineChoice).toBeDefined();
    expect(singleChoice).toBeDefined();
    expect(lineChoice.tier).toBe(singleChoice.tier); // 同tier内のタイブレークであることを前提にする

    const lineScore = adjustScoreForCandidate(ctx, state, lineChoice.scored.candidate);
    const singleScore = adjustScoreForCandidate(ctx, state, singleChoice.scored.candidate);
    expect(lineScore.pStar3).toBeGreaterThan(singleScore.pStar3);

    const lineIdx = choices.indexOf(lineChoice);
    const singleIdx = choices.indexOf(singleChoice);
    expect(lineIdx).toBeLessThan(singleIdx);
  });
});

// §10.8/v3a: composeStar3Prob(純関数)・star3ErrorLimit(engine.judgeとの整合)の単体検証。
describe('composeStar3Prob(§10.8/v3a: マス独立近似のP(★3)畳み込み)', () => {
  it('手計算一致(2マス): P(0)=pZero, P(1)=pLe1-pZero, P(bust)=1-pLe1 の直接畳み込みと一致する(bust値は両マスともlimit+1へ飽和)', () => {
    // マスA: pZero=0.4, pLe1=0.9(P(1)=0.5), expErr=0.4*0+0.5*1+0.1*bustA
    // マスB: pZero=0.3, pLe1=0.8(P(1)=0.5), expErr=同様
    // bust値はA=25・B=10でいずれもlimit+1=3へ飽和する(手計算側も同じ飽和を適用して一致を確認。
    // bustが窓内に落ちる非飽和ケースは次のテストで別途カバーする)。
    const limit = 2;
    // bustValue = max(2, round((expErr-(pLe1-pZero))/(1-pLe1))) を逆算し、expErrを3に固定する。
    // A: (3 - 0.5) / 0.1 = 25 → bustはlimit+1(=3)へ確実に飽和する大きな値になる想定。
    const a = { expErr: 3, pZero: 0.4, pLe1: 0.9 };
    const b = { expErr: 2.5, pZero: 0.3, pLe1: 0.8 };

    // 手計算: 各マスの3点分布(0確率p0, 1確率p1, bust確率pBust)を直接畳み込む。
    const bustOf = (t: { expErr: number; pZero: number; pLe1: number }): number => {
      const p1 = t.pLe1 - t.pZero;
      return Math.max(2, Math.round((t.expErr - p1) / Math.max(1e-9, 1 - t.pLe1)));
    };
    const distA = [
      { v: 0, p: a.pZero },
      { v: 1, p: a.pLe1 - a.pZero },
      { v: bustOf(a), p: 1 - a.pLe1 },
    ];
    const distB = [
      { v: 0, p: b.pZero },
      { v: 1, p: b.pLe1 - b.pZero },
      { v: bustOf(b), p: 1 - b.pLe1 },
    ];
    let expected = 0;
    for (const da of distA) {
      for (const db of distB) {
        const sum = Math.min(limit + 1, da.v + db.v); // limit+1で飽和
        if (sum <= limit) expected += da.p * db.p;
      }
    }

    const actual = composeStar3Prob([a, b], limit);
    expect(actual).toBeCloseTo(expected, 9);
  });

  it('bustが窓内(2≤bust≤limit)に落ちるケース: bust同士の和だけがlimitを超える', () => {
    // 各マス: P(0)=0.5, P(1)=0.4, P(bust)=0.1, bust値=round((0.7-0.4)/0.1)=3(limit=5の窓内で飽和しない)。
    // 和の分布: 3+3=6 のみ limit=5 を超過 → P(合計≤5) = 1 - 0.1*0.1 = 0.99。
    const t = { expErr: 0.7, pZero: 0.5, pLe1: 0.9 };
    expect(composeStar3Prob([t, t], 5)).toBeCloseTo(0.99, 9);
  });

  it('bust飽和ケース: bustValueが非常に大きくても(limit+1へ飽和)確率の合計は変わらない', () => {
    // 1-pLe1がわずか(bust確率小)でもbust項は寄与し得るが、飽和により
    // 「bustのbust値が10でも1000でも合計確率は同じ」になることを確認する。
    const limit = 3;
    const t = { expErr: 5, pZero: 0.5, pLe1: 0.9 }; // bustValue = (5-0.4)/0.1 = 46(飽和域)
    const p0 = composeStar3Prob([t], limit);
    // 手計算: P(0)=0.5, P(1)=0.4, P(bust=46→飽和)=0.1。limit=3なので0と1のみが合計対象。
    expect(p0).toBeCloseTo(0.9, 9);
  });

  it('1-pLe1<1e-9のマスはbust項を省略する(P(0)+P(1)のみで畳み込む)', () => {
    const limit = 1;
    const t = { expErr: 0.1, pZero: 0.9, pLe1: 1 }; // 1-pLe1=0 → bust項省略
    const p = composeStar3Prob([t], limit);
    // bust項がなければP(合計≤1)=P(0)+P(1)=pZero+(pLe1-pZero)=pLe1=1。
    expect(p).toBeCloseTo(1, 9);
  });
});

describe('star3ErrorLimit(§10.8/v3a: engine.judgeとの整合)', () => {
  it('massCount=4・errorLimit=false: evaluation."4".star3=2と一致し、合計誤差=limitはstar3・limit+1はstar2以下', () => {
    const ctx = makeCtx();
    // 4マス盤面: 合計誤差評価値がちょうどlimitになるよう、1マスに残りlimit・他3マスは残り0を置く。
    const state = makeState(ctx, [0, 0, 0, 0], 2, { currentPower: 'weak' });
    const limit = star3ErrorLimit(ctx, state);
    expect(limit).toBe(ctx.data.params.evaluation['4'].star3);

    const okState = makeState(ctx, [limit, 0, 0, 0], 2, { currentPower: 'weak' });
    expect(ctx.engine.judge(okState).star).toBe('star3');

    const overState = makeState(ctx, [limit + 1, 0, 0, 0], 2, { currentPower: 'weak' });
    expect(ctx.engine.judge(overState).star).not.toBe('star3');
  });

  it('massCount=9: evaluation."9".star3=8と一致する', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, new Array(9).fill(0), 3, { currentPower: 'weak' });
    const limit = star3ErrorLimit(ctx, state);
    expect(limit).toBe(ctx.data.params.evaluation['9'].star3);
  });
});

// §10.11(A3回答=Q3解決)の一般化検証: 「集中≥19: 精神統一→半かげんで確定」
// (統一7+半かげん12=19)。v2は「かげん@発光6」をD1(発光マス補正)・A1(誤差0ボーナス)で
// tier-0.5まで押し上げるため、tier0の精神統一よりも常にtierで上回ってしまい、rankExpertの
// 順位だけでは§10.11の「統一して待つ」判断を再現できない(集中閾値の梯子はv3の別タスクとして
// 明示的に将来へ送られている。§10.11本文末尾「集中閾値の梯子として実装する(v3)」参照)。
// そのためタスク仕様の指示どおり、adjustScoreForCandidate の pStar3 を直接比較して検証する
// (判断に迷った点: ctx はDEFAULT_ADJUST_DP_PARAMS(lockUpkeep=2)で構築されるため、
// 半かげんの実コストは12+2=14になる。§10.11本文の「19=統一7+半かげん12」はlockUpkeepを
// 含まない生コスト表記のため、本実装での等価な閾値は21(=統一7+半かげん実コスト14)になる。
// 集中21はタスク仕様の「集中19以上」の範囲内であり、かつ半かげんがちょうど選ばれる閾値で
// 丸め誤差の影響を受けない安定点なのでこれを使う)。
describe('§10.11の一般化検証: 光布・発光マスr=+6・弱パワー・集中≥19での精神統一 vs かげん@発光', () => {
  // 4マス盤面: 発光マス(r=6)以外は残り0(既に仕上げ済み)。massCount=4のstar3誤差上限は
  // 2(evaluation."4".star3)とタイトなため、pStar3の差が明瞭に出る。
  function makeGlowState(ctx: SolverContext, concentration: number): GameState {
    const cells = [
      { r: 1, c: 1, base: 30, cumulative: 30, shitsuke: false }, // 残り0
      { r: 1, c: 2, base: 30, cumulative: 24, shitsuke: false }, // 残り6(発光)
      { r: 2, c: 1, base: 30, cumulative: 30, shitsuke: false }, // 残り0
      { r: 2, c: 2, base: 30, cumulative: 30, shitsuke: false }, // 残り0
    ];
    return ctx.engine.createStateFromSnapshot({
      recipeId: 'test_light_1011',
      clothType: 'light',
      rows: 2,
      cols: 2,
      massCount: 4,
      cells,
      powerCycle: ['normal'],
      currentPower: 'weak',
      lockPowerRemaining: 0,
      lockedPower: null,
      glowCell: { r: 1, c: 2 },
      turnStarted: true,
      hissatsuUsed: true,
      concentration,
    });
  }

  it('集中21(=統一7+半かげん実コスト14)では精神統一のpStar3がかげん@発光マスを上回る', () => {
    const ctx = makeCtx();
    const state = makeGlowState(ctx, 21);
    const choices = rankExpert(ctx, state);

    const kagenGlow = choices.find(
      (ch) => ch.scored.candidate.skillId === 'kagen_nui' && ch.scored.candidate.targetCells.some((t) => t.r === 1 && t.c === 2),
    );
    expect(kagenGlow).toBeDefined();
    // v2のtier設計(D1/A1)により、かげん@発光は精神統一(未実装の候補ゲート次第で登場有無が
    // 変わるためここでは確認しない)より低いtier(=優先)に来る。rankExpertの先頭がかげん@発光に
    // なること自体は既存のtier設計の帰結であり、本テストの主張(pStar3ベースでは統一の方が
    // 優れる)とは矛盾しない。
    const picked = pickExpert(ctx, state);
    expect(picked.candidate.skillId).toBe('kagen_nui'); // 現状のtier設計での実際の選択(参考記録)

    const kagenSkill = ctx.engine.listSkills().find((s) => s.id === 'kagen_nui')!;
    const kagenCandidate = {
      action: { type: 'sew' as const, skillId: 'kagen_nui', anchor: { r: 1, c: 2 } },
      skillId: 'kagen_nui',
      cost: ctx.engine.effectiveCost(state, kagenSkill),
      targetCells: [{ r: 1, c: 2, multiplier: 0.5 }],
    };
    const seishinSkill = ctx.engine.listSkills().find((s) => s.id === 'seishin_toitsu')!;
    const seishinCandidate = {
      action: { type: 'skill' as const, skillId: 'seishin_toitsu' },
      skillId: 'seishin_toitsu',
      cost: ctx.engine.effectiveCost(state, seishinSkill),
      targetCells: [],
    };

    const kagenScore = adjustScoreForCandidate(ctx, state, kagenCandidate);
    const seishinScore = adjustScoreForCandidate(ctx, state, seishinCandidate);
    // 実測: kagenGlow pStar3≈0.798(発光×2補正でも会心率が低く誤差1超のリスクが残る)、
    // seishin pStar3≈1.0(統一後、素の半かげん{5,5,6,6,6,7,7}でp≤1=100%。§10.11本文どおり)。
    expect(seishinScore.pStar3).toBeGreaterThan(kagenScore.pStar3);
    expect(seishinScore.pStar3).toBeGreaterThan(0.99);
    expect(kagenScore.pStar3).toBeLessThan(0.9);
  });

  it('集中13(=統一7のみ・半かげん実コスト14に届かない)では精神統一のpStar3が0になり、かげん@発光を下回る(閾値の妥当性確認)', () => {
    const ctx = makeCtx();
    const state = makeGlowState(ctx, 13);

    const kagenSkill = ctx.engine.listSkills().find((s) => s.id === 'kagen_nui')!;
    const kagenCandidate = {
      action: { type: 'sew' as const, skillId: 'kagen_nui', anchor: { r: 1, c: 2 } },
      skillId: 'kagen_nui',
      cost: ctx.engine.effectiveCost(state, kagenSkill),
      targetCells: [{ r: 1, c: 2, multiplier: 0.5 }],
    };
    const seishinSkill = ctx.engine.listSkills().find((s) => s.id === 'seishin_toitsu')!;
    const seishinCandidate = {
      action: { type: 'skill' as const, skillId: 'seishin_toitsu' },
      skillId: 'seishin_toitsu',
      cost: ctx.engine.effectiveCost(state, seishinSkill),
      targetCells: [],
    };

    const kagenScore = adjustScoreForCandidate(ctx, state, kagenCandidate);
    const seishinScore = adjustScoreForCandidate(ctx, state, seishinCandidate);
    expect(seishinScore.pStar3).toBeLessThan(kagenScore.pStar3);
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

  it('押し出しはapproach局面でもE2に封殺されない(上振れなしでも全出目が押し出し帯なら床=regenPushLo。§10.10レビューM1回帰)', () => {
    const ctx = makeCtx();
    // [2, 20]: bigCount=0・midCount=1 → approach局面(carveのregenCarveFloor経路を通らない)。
    // nuu@普通 on +2 の非会心出目は-10〜-16で全て押し出し帯[-17,-8]内だが、上振れ(|残り|≤1)は
    // 会心頭打ちの0(≈5%)しかなく1/7未満 → 上振れ条件だけだと床がovershootFloor(-4)に戻り
    // E2で失格してしまう。押し出し設計の例外(床=regenPushLo)で通ることを確認する。
    const state = makeState(ctx, [2, 20, 0, 0], 2, { currentPower: 'normal', clothType: 'regen', turn: 30 });
    const choices = rankExpert(ctx, state);
    const nuu = findChoice(choices, 'nuu', 1, 1);
    expect(nuu).toBeDefined();
    expect(nuu!.tier).toBe(1); // tierForRegenPush: r=+2 → tier1
  });

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

// 再生布の回復影響スコアリング(§10.10/v3b。regenProtectionDeltaの一般化=regenImpactDelta)。
// 「回復を受けるマスをあえて用意する」のではなく「再生前提で悪い数字リスクを保険で抑えつつ
// 有利な乱数を取りに行く」が本質(§10.10)。行動後盤面(dist)を直組みして4分類
// (実害/利得/中立/eligibleなし)を検証する。turnsUntil===1になる turn=31 を使う
// (predictRegenTargetのテストと同じ規約: state.turn=31→現在ターン32→次の再生T33)。
describe('再生布: 回復影響スコアリング(regenImpactDelta。§10.10/v3b)', () => {
  /** 対象マス(r,c)のみが現れる単一出目(確率1)の合成distを組み立てる(行動後残りを直接指定)。 */
  function singlePointDist(r: number, c: number, remaining: number): ActionDistribution {
    return { cells: [{ r, c, pmf: [{ remaining, prob: 1 }] }] };
  }

  it('実害: 行動後の予測対象残りが仕上げ帯r∈{5,7,8,9}ならregenImpactBad(既定+1)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [0, 0, 0, 0], 2, { clothType: 'regen', turn: 31 });
    const prediction = predictRegenTarget(ctx, state);
    expect(prediction!.turnsUntil).toBe(1);

    // (1,1)以外は行動後も残り0(黄色内・非対象)のまま。(1,1)の行動後残りを8に固定
    // (base100→cumulative92>4なのでeligible・単独対象)。§10.10「仕上げ帯のマスが回復を
    // 受ける=実害(+12〜16戻され実質2手+10集中の損失)」。
    const dist = singlePointDist(1, 1, 8);
    expect(regenImpactDelta(ctx, state, dist, prediction)).toBe(1);
  });

  it('利得: 行動後の予測対象残りが押し出し域[regenPushLo,regenPushHi]=[-17,-8]内ならregenImpactGood(既定-0.5)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [0, 0, 0, 0], 2, { clothType: 'regen', turn: 31 });
    const prediction = predictRegenTarget(ctx, state);

    // (1,1)の行動後残りを-12に固定(押し出し打点域内)。§10.10「悪い黄色値の再抽選・保険
    // オーバーの回収=利得」。
    const dist = singlePointDist(1, 1, -12);
    expect(regenImpactDelta(ctx, state, dist, prediction)).toBe(-0.5);
  });

  it('中立: 行動後の予測対象残りがr=6(再抽選許容値。実害/利得のいずれでもない)なら0', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [0, 0, 0, 0], 2, { clothType: 'regen', turn: 31 });
    const prediction = predictRegenTarget(ctx, state);

    // §10.6: 6・10〜13は再抽選が許容される値(保護対象外)。§10.10「それ以外(…6/10〜13など)」。
    const dist = singlePointDist(1, 1, 6);
    expect(regenImpactDelta(ctx, state, dist, prediction)).toBe(0);
  });

  it('eligibleなし: 行動後の全マスが黄色内(|残り|≤4)なら予測対象が存在せず0', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [0, 0, 0, 0], 2, { clothType: 'regen', turn: 31 });
    const prediction = predictRegenTarget(ctx, state);

    const dist = singlePointDist(1, 1, 2); // |2|≤yellowRange(4) → 非eligible
    expect(regenImpactDelta(ctx, state, dist, prediction)).toBe(0);
  });

  it('対象が複数(比タイ)で実害と中立が混在する場合は実害を優先する', () => {
    const ctx = makeCtx();
    // ratio=cumulative/baseが同値になるよう base を作り分ける: (1,1) base100・行動後残り8
    // (ratio=92/100=0.92)、(1,2) base75・行動後残り6(ratio=69/75=0.92。中立値)。
    // 正の残りを持つマス同士は base を調整すれば比を一致させられる(負の残り[cumulative>base
    // →ratio>1]は正の残り[ratio<1]と原理的にタイし得ないため、本テストは正の残り同士で構成する。
    // 判断に迷った点として報告参照)。
    const cells = [
      { r: 1, c: 1, base: 100, cumulative: 0, shitsuke: false },
      { r: 1, c: 2, base: 75, cumulative: 0, shitsuke: false },
      { r: 2, c: 1, base: 100, cumulative: 100, shitsuke: false },
      { r: 2, c: 2, base: 100, cumulative: 100, shitsuke: false },
    ];
    const state = ctx.engine.createStateFromSnapshot({
      recipeId: 'regen-impact-tie',
      category: 'test',
      clothType: 'regen',
      rows: 2,
      cols: 2,
      cells,
      massCount: 4,
      powerCycle: ['normal'] as Power[],
      currentPower: 'normal' as const,
      concentration: 200,
      turnStarted: true,
      hissatsuUsed: true,
      turn: 31,
    });
    const prediction = predictRegenTarget(ctx, state);

    const dist: ActionDistribution = {
      cells: [
        { r: 1, c: 1, pmf: [{ remaining: 8, prob: 1 }] },
        { r: 1, c: 2, pmf: [{ remaining: 6, prob: 1 }] },
      ],
    };
    // 事前確認: 両マスがタイで予測対象になる(regenTargetsFromCellsの内部規則を
    // predictRegenTarget経由で間接確認する代わりに、boardAfterAction相当の手計算で検算)。
    expect((100 - 8) / 100).toBeCloseTo((75 - 6) / 75, 9);

    expect(regenImpactDelta(ctx, state, dist, prediction)).toBe(1);
  });

  it('turnsUntil!==1では常に0(適用条件外)', () => {
    const ctx = makeCtx();
    // turn=30 → turnsUntil=2
    const state = makeState(ctx, [0, 0, 0, 0], 2, { clothType: 'regen', turn: 30 });
    const prediction = predictRegenTarget(ctx, state);
    expect(prediction!.turnsUntil).toBe(2);

    const dist = singlePointDist(1, 1, 8); // 実害値だが適用条件外なので0のまま
    expect(regenImpactDelta(ctx, state, dist, prediction)).toBe(0);
  });
});

// 保護の後方互換(§10.10/v3b): 「予測対象r∈{5,7,8,9}を黄色内(全出目|残り|≤4)に収める縫いが、
// 放置する手より相対的に上位になる」ことが新実装でも成立するかを rankExpert で検証する
// (旧 regenProtectionDelta 前提の厳密な「-1」比較テストは、対象を持たない候補にも
// regenImpactDelta を適用する新実装では意味が変わるため §10.10 に従って書き換えた)。
describe('再生布: 回復先保護の後方互換(§10.6/§10.10)', () => {
  it('nuu@weak(r=8を黄色内へ収める)がseishin_toitsu(何もしない=放置)より上位tierになる', () => {
    const ctx = makeCtx();
    // turn=31→turnsUntil=1。盤面[8,3,0,0]・weak・未ロック:
    // - (1,1)=8: estimateAdjustMoves 1手(3≤8≤10)。predictRegenTarget唯一の対象(|8|>4)。
    // - (1,2)=3: 黄色内(|3|≤4。非eligible)だが estimateAdjustMoves では1手(3≤3≤10)扱い
    //   → 合計2手以上になり、精神統一「弱着地」(§10.1。未ロック・残り作業2手以上)がtier0で成立する。
    // - bigCount=0・midCount=0(全マス<14)→ phase='adjust'。
    const state = makeState(ctx, [8, 3, 0, 0], 2, {
      currentPower: 'weak',
      clothType: 'regen',
      turn: 31,
      lockPowerRemaining: 0,
      lockedPower: null,
    });
    const prediction = predictRegenTarget(ctx, state)!;
    expect(prediction.turnsUntil).toBe(1);
    expect(prediction.targets).toEqual([{ r: 1, c: 1, remaining: 8 }]);

    const choices = rankExpert(ctx, state);
    const nuuChoice = findChoice(choices, 'nuu', 1, 1);
    const seishinChoice = choices.find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(nuuChoice).toBeDefined();
    expect(seishinChoice).toBeDefined();

    // nuu@weak・r=8のPMF(SPEC§3.2): 非会心remaining∈{2,1,1,0,0,-1,-1}(各1/7)・会心は必ず
    // 基準値頭打ちでremaining=0(頭打ち仕様上つねに0。会心率の値によらない)。
    // 期待値=(1-cr)*2/7∈[0, 2/7](cr=会心率)→四捨五入で常に0(黄色内)になる
    // → 行動後(1,1)はeligible外になり、(1,2)も黄色内でeligible外 → 予測対象なし(中立0)。
    // 一律tier1(adjust単マス系。§10.4/2)からA1誤差0ボーナス(P(0)≥2/7≥1/7で常に成立。既定0.5)を
    // 引いた0.5が最終tier。
    expect(nuuChoice!.tier).toBe(0.5);

    // seishin_toitsu(対象なし)は行動後盤面=現盤面のまま→(1,1)のr=8がそのまま予測対象
    // (実害)。弱着地の基本tier0 + regenImpactBad(既定+1) = 1。
    expect(seishinChoice!.tier).toBe(1);

    expect(nuuChoice!.tier).toBeLessThan(seishinChoice!.tier);
  });
});

// E2の再生緩和・上振れ条件(§10.10/v3b): 「PMFに誤差0または誤差1以内の上振れがあること」を
// 非carve局面の再生緩和(regenOvershootFloor)の結合条件にする。carve局面(regenCarveFloor)は
// 対象外(変更しない)。
describe('E2の再生緩和: 上振れ条件(§10.10/v3b)', () => {
  it('残27へのnuu@最強(approach・再生布・赤0): 誤差≤1の上振れ(非会心のみで2/7≥1/7)があるため緩和され候補に出る', () => {
    const ctx = makeCtx();
    // SPEC§3.2: damage0=roundPositive(roundPositive(12..18 × 1) × 2)=24,26,28,30,32,34,36
    // (最強係数2・倍率1・補正1)。非会心残り=27-damage0={3,1,-1,-3,-5,-7,-9}。会心は
    // critDamage=damage0*2≥48>27で必ず頭打ち→残り0。|残り|≤1の質量は非会心の{1,-1}
    // (2/7)+会心の{0}(会心率分)≥2/7≥1/7(会心率0でも成立するため会心率の実値によらず頑健)。
    const state = makeState(ctx, [27, 0, 0, 0], 2, { currentPower: 'strongest', clothType: 'regen' });
    const choices = rankExpert(ctx, state);
    expect(findChoice(choices, 'nuu', 1, 1)).toBeDefined();
  });

  it('残20へのnuu@最強(同条件): 誤差≤1の上振れが会心分(<1/7)しかないため緩和が不適用になり候補から外れる', () => {
    const ctx = makeCtx();
    // 非会心残り=20-damage0={-4,-6,-8,-10,-12,-14,-16}(いずれも|残り|>1)。会心は同様に
    // 必ず頭打ち→残り0だが、その質量は会心率(奇跡針★3+コツ+パッシブ=4.3%+1%+0.1%=5.4%)のみで
    // 1/7(≈14.3%)未満 → 上振れ条件を満たさず緩和不適用 → floor=overshootFloor(-4)。
    // 非会心最悪-16 < -4 でE2に抵触し禁止される。
    const state = makeState(ctx, [20, 0, 0, 0], 2, { currentPower: 'strongest', clothType: 'regen' });
    const choices = rankExpert(ctx, state);
    expect(findChoice(choices, 'nuu', 1, 1)).toBeUndefined();
  });
});
