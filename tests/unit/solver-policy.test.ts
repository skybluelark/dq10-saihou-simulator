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
  DEFAULT_POLICY_PARAMS,
  passesE2,
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

  // v3e(§10.20②): 「明示指定の単発は最悪でも1回復圏(-16)まで=最強3倍は残92まで」により、
  // carve中の再生緩和floorは対象マス1つの候補(単発)ではregenCarveFloor(-34)ではなく
  // midareStopLoss(-16)になった(旧テストの期待値=regenCarveFloor境界は単発には適用されなくなった
  // ため、境界値をmidareStopLoss基準に更新する)。
  it('同条件の縫いすぎでも再生布なら緩和される(単発はv3e/§10.20②でmidareStopLoss境界に変更)', () => {
    const ctx = makeCtx();
    // 2倍ぬい@normal・残り20: 非会心最悪値=20-36=-16(単発floor=midareStopLossちょうど)。
    // 通常布は禁止(floor=overshootFloor=-4)、再生布は許可。
    const normalState = makeState(ctx, [20, 30, 0, 0], 2, { currentPower: 'normal', clothType: 'normal' });
    expect(findChoice(rankExpert(ctx, normalState), 'nibai_nui', 1, 1)).toBeUndefined();

    const regenState = makeState(ctx, [20, 30, 0, 0], 2, { currentPower: 'normal', clothType: 'regen' });
    const regenChoice = findChoice(rankExpert(ctx, regenState), 'nibai_nui', 1, 1);
    expect(regenChoice).toBeDefined();
  });

  it('残り≤0への縫いは通常布で禁止・再生布で許可', () => {
    const ctx = makeCtx();
    // 単マス特技は対象(自身のみ)が残り≤0だと enumerateCandidates 自体が除外するため、
    // 一部マスのみ残り≤0の複数マス特技(たすきぬい)で検証する。
    // (1,1)=30でcarve局面、対象は(2,1)=0・(1,2)=10(diag_up2アンカー(2,1))。
    // currentPowerはnormal(§10.16のturnPhase上書きはeff==='weak'限定。もしweakにすると
    // (1,2)=10がfineCount>0トリガーとなりこのターンがturnPhase==='adjust'に上書きされ、
    // ライン系ゲート(全対象r≥3)により対象(2,1)=0を含むこの候補自体が
    // 常にnullになってしまい、本テストが検証したいE2の再生布緩和を検証できなくなるため)。
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
      currentPower: 'normal' as const,
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
  // v3d(§10.19回答(a)): 旧仕様ではC1ストップロス(worst≥midareStopLoss)さえ満たせばcarveは
  // 常にtier1だったが、新仕様は「×2打がみだれ封じ帯の小マスを作り得るか」で格下げする。
  // この盤面(強パワー・×2打最大54)は60-54=6・55-54=1のいずれも封じ帯(0, 54+(-16)=38]内に
  // 収まるため、carveVarianceAverse既定(true)によりtier2へ格下げされる(旧テストの期待値tier1
  // から変更。§10.19①②「削りの集中効率を降順ソートすれば…みだれを打てる回数を増やすことが
  // 集中効率の改善につながる」を踏まえ、封じられるリスクがある間はワンテンポ譲る)。
  it('carve(全マス大=ストップロス充足)でも×2打がみだれ封じ帯の小マスを作り得るため、carveVarianceAverse既定でtier2に格下げされる(v3d/§10.19回答(a))', () => {
    const ctx = makeCtx();
    // C1: 2倍打の最大値(強=54)が最小マスに当たっても midareStopLoss(-16)以上になる盤面
    const state = makeState(ctx, [60, 55, 50, 45], 2, { currentPower: 'strong', clothType: 'normal' });
    const choices = rankExpert(ctx, state);
    const midare = choices.find((ch) => ch.scored.candidate.skillId === 'midare_nui');
    expect(midare).toBeDefined();
    expect(midare!.tier).toBe(2);
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

  // v3d(§10.19③④(b)。エキスパート回答=仕様の正): 「ぬいパワー2周目の最強までは精神統一は
  // せず、その時点で削れていない場合にたまに使用する」「更新は残1になってから」
  // 「基準は弱いの着地までに削れる量かどうか」。以下は powerCycle=['strongest','normal','weak']
  // (length=3)で統一。unlockedのadvanceSchedule後は cycle[1]='normal'→cycle[2]='weak' で止まる
  // ため expectedCarveToWeakLanding = CARVE_ESTIMATE.normal = 30 が共通の基準値になる。
  const SEISHIN_CYCLE: Power[] = ['strongest', 'normal', 'weak'];

  it('(e) 1周目(turn≤powerCycle.length)の最強×carve×未ロック×巨大盤面では統一が候補に出ない(§10.19③)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [200, 0, 0, 0], 2, {
      currentPower: 'strongest',
      lockPowerRemaining: 0,
      lockedPower: null,
      powerCycle: SEISHIN_CYCLE,
      cycleIndex: 0,
      turn: 0,
    });
    const choices = rankExpert(ctx, state);
    const seishin = choices.find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishin).toBeUndefined();
  });

  it('(f) 2周目(turn>powerCycle.length)の最強×carve×未ロック×削り不足大(>30)では統一がtier1に入る(§10.19③(b))', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [200, 0, 0, 0], 2, {
      currentPower: 'strongest',
      lockPowerRemaining: 0,
      lockedPower: null,
      powerCycle: SEISHIN_CYCLE,
      cycleIndex: 0,
      turn: 4,
    });
    const choices = rankExpert(ctx, state);
    const seishin = choices.find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishin?.tier).toBe(1);
  });

  it('(g) 2周目でも削り不足が僅少(remainingCarve≈expectedCarveToWeakLanding、差≤tolerance)なら統一は候補に出ない(§10.19(b))', () => {
    const ctx = makeCtx();
    // remainingCarve=40(approachMin以上のマスはこの1つのみ)。expectedCarveToWeakLanding=30。
    // 差10 ≤ seishinCarveTolerance(既定30)なので不足は僅少 → 統一しない方が安い。
    const state = makeState(ctx, [40, 0, 0, 0], 2, {
      currentPower: 'strongest',
      lockPowerRemaining: 0,
      lockedPower: null,
      powerCycle: SEISHIN_CYCLE,
      cycleIndex: 0,
      turn: 4,
    });
    const choices = rankExpert(ctx, state);
    const seishin = choices.find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishin).toBeUndefined();
  });

  it('(h) ロック中: 残2は統一の対象外・残1(+2周目+削り不足大)は統一tier1(§10.19④: 更新は残1のみ)', () => {
    const ctx = makeCtx();
    const remaining2 = makeState(ctx, [200, 0, 0, 0], 2, {
      currentPower: 'strongest',
      lockPowerRemaining: 2,
      lockedPower: 'strongest',
      powerCycle: SEISHIN_CYCLE,
      cycleIndex: 0,
      turn: 4,
    });
    const seishinAt2 = rankExpert(ctx, remaining2).find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishinAt2).toBeUndefined();

    const remaining1 = makeState(ctx, [200, 0, 0, 0], 2, {
      currentPower: 'strongest',
      lockPowerRemaining: 1,
      lockedPower: 'strongest',
      powerCycle: SEISHIN_CYCLE,
      cycleIndex: 0,
      turn: 4,
    });
    const seishinAt1 = rankExpert(ctx, remaining1).find((ch) => ch.scored.candidate.skillId === 'seishin_toitsu');
    expect(seishinAt1?.tier).toBe(1);
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

  // §10.16確認済み知見「しつけ→最強3倍の一般化」: 現行ルールの「massCount=4限定」は誤り —
  // マス数でなく巨大マス(概ね200以上。shitsukeBigCellMin)の存在が条件。
  it('①最強化の仕込み(§10.16): 6マス盤面の残253(巨大マス)へtier2が付く(massCount≠4でも)', () => {
    const ctx = makeCtx();
    const cells = [
      { r: 1, c: 1, base: 300, cumulative: 47, shitsuke: false }, // 残り253(shitsukeBigCellMin=200超)
      { r: 1, c: 2, base: 100, cumulative: 100, shitsuke: false },
      { r: 1, c: 3, base: 100, cumulative: 100, shitsuke: false },
      { r: 2, c: 1, base: 100, cumulative: 100, shitsuke: false },
      { r: 2, c: 2, base: 100, cumulative: 100, shitsuke: false },
      { r: 2, c: 3, base: 100, cumulative: 100, shitsuke: false },
    ];
    const state = ctx.engine.createStateFromSnapshot({
      recipeId: 'shitsuke-big-cell',
      category: 'test',
      rows: 2,
      cols: 3,
      cells,
      massCount: 6,
      powerCycle: ['normal'],
      currentPower: 'normal',
      concentration: 200,
      turnStarted: true,
      hissatsuUsed: true,
    });
    const choices = rankExpert(ctx, state);
    const choice = findChoice(choices, 'shitsuke_gake', 1, 1);
    expect(choice?.tier).toBe(2);
  });

  it('①最強化の仕込み(§10.16回帰): 4マス盤面の残30(旧carveMin条件は満たすがshitsukeBigCellMin未満)にはtier2が付かない', () => {
    const ctx = makeCtx();
    // 旧ルール(massCount===4 && r>=carveMin(28))ならtier2だったが、§10.16の一般化(r>=200)では
    // 対象外になる差分ケース。
    const state = makeState(ctx, [30, 0, 0, 0], 2, { currentPower: 'normal' });
    const choices = rankExpert(ctx, state);
    expect(findChoice(choices, 'shitsuke_gake', 1, 1)).toBeUndefined();
  });
});

// §10.16確認済み: 旧「massCount===4限定」を撤廃。残りrがminD〜2×minD
// (minD=sewDamage(12,1,実効パワー,マス補正))の隙間にちょうど収まるときのみtier2
// (会心=2倍打が必ず基準値頭打ちとなり誤差0に着地するため)。
describe('ねらいぬい(§10.16: 会心頭打ちで誤差0に着地する隙間のみtier2)', () => {
  it('隙間の範囲外(残50)なら9マス通常布のcarveで候補に出ない', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, new Array(9).fill(50), 3, { currentPower: 'normal', clothType: 'normal' });
    const choices = rankExpert(ctx, state);
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'nerai_nui')).toBe(false);
  });

  it('§10.16回帰: massCount=4でも隙間の外(残50)なら旧ルールと異なりtier2は付かない', () => {
    const ctx = makeCtx();
    // 旧ルール(massCount===4なら無条件でtier2)ならtier2だったが、§10.16の一般化(隙間判定)では
    // 対象外になる差分ケース。
    const state = makeState(ctx, new Array(4).fill(50), 2, { currentPower: 'normal', clothType: 'normal' });
    const choices = rankExpert(ctx, state);
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'nerai_nui')).toBe(false);
  });

  it('虹6#21再現形: 残17・実効普通・massCount≠4(6マス)でtier2ベース(minD=12≤17≤24。§10.16)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [17, 10, 5, 0, 0, 0], 3, { currentPower: 'normal', clothType: 'normal' });
    const choices = rankExpert(ctx, state);
    const nerai = findChoice(choices, 'nerai_nui', 1, 1);
    // §10.16の隙間ゲート自体はtier2を与えるが、この残17・普通は会心頭打ち率が高く
    // (§10.16の引用どおり約37.8%。≥1/7なのでA1誤差0ボーナスが重ねて適用され、
    // 最終tierは 2 - zeroBonusTier(既定0.5) = 1.5 になる(A1は本タスクの変更対象外・既存仕様)。
    expect(nerai).toBeDefined();
    expect(nerai?.tier).toBe(2 - DEFAULT_POLICY_PARAMS.zeroBonusTier);
  });
});

// §10.16確認済み知見「ターン単位フェーズ」: フェーズは盤面全体ではなくターン単位
// (そのターンの実効パワー)で切り替わる。弱ターン=調整品質の作業、最強ターン=削り。
// v3d(§10.19⑤)でこの昇格自体にゲートが追加された: 「まだ十分に削れていない場合(5~6ターン目
// 付近)では、残4のマスがあっても普通みだれを選択します」— 大マス(analysis.bigCount≥1)が
// 残っている間は、弱ターンでも1マス仕上げ(adjust品質)に流れず削り継続を優先する。
describe('ターン単位フェーズ(§10.16。v3dでbigCountゲート追加=§10.19⑤)', () => {
  it('虹6#12再現形が示す旧挙動はv3dのbigCountゲートで無効化される: carve級の盤面(大マスあり)+実効弱パワー+盤面にfineCount>0(残5マス)ありでも、bigCount>0の間はturnPhaseが昇格せず、糸ほぐし(+2)候補にティアが付かない(v3d/§10.19⑤で挙動反転)', () => {
    const ctx = makeCtx();
    // (1,1)=40で大マス(bigCount>0→盤面全体は'carve')。(2,1)=5がfineCount(3<=r<14)トリガー。
    // 旧仕様(v3c以前)ではcurrentPower='weak'のこのターンはturnPhase==='adjust'に上書きされ
    // 糸ほぐし(+2)にtier1が付いていたが、v3dはbigCount>0の間はこの昇格をブロックするため、
    // turnPhaseは盤面全体と同じ'carve'のまま。tierForHogushiのcarve分岐はr=2が該当ブランチなし
    // (r<=-3でもr===-2/-1でもない)でnullになり、候補自体が消える。
    const state = makeState(ctx, [40, 2, 5, 0], 2, { currentPower: 'weak' });
    const choices = rankExpert(ctx, state);
    const hogushi = findChoice(choices, 'ito_hogushi', 1, 2);
    expect(hogushi).toBeUndefined();
  });

  it('bigCount===0(大マスなし)なら旧来どおりturnPhaseが昇格し、糸ほぐし(+2)候補にtier1が付く(既存挙動維持。§10.19⑤)', () => {
    const ctx = makeCtx();
    // (1,1)=20はapproachMin(14)以上carveMin(28)未満なのでbigCount=0・midCount=1
    // (盤面全体は'approach')。(1,2)=5がfineCount(3<=r<14)トリガー。
    const state = makeState(ctx, [20, 2, 5, 0], 2, { currentPower: 'weak' });
    const analysis = analyzeBoard(ctx, state);
    expect(analysis.bigCount).toBe(0);
    const choices = rankExpert(ctx, state);
    const hogushi = findChoice(choices, 'ito_hogushi', 1, 2);
    expect(hogushi?.tier).toBe(1);
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

  // §10.18/v3c: 押し出し帯を [regenPushLo, regenPushHi] から [regenPushLo, regenPushShallowHi]
  // (既定-4)へ拡張。全出目が従来帯なら加点なし(既存テスト群で回帰確認済み)、一部が浅い側
  // (regenPushHi, regenPushShallowHi]に掛かるならティア+0.5。
  it('+2のマスへのnuu@弱(浅押し。非会心-4〜-7で従来帯[-17,-8]の外・拡張帯[-17,-4]の内)はティア1+0.5=1.5', () => {
    const ctx = makeCtx();
    // nuu@弱: damage0=roundPositive(12..18×0.5)={6,7,7,8,8,9,9}→{6,7,8,9}。残り=2-{6,7,8,9}={-4,-5,-6,-7}。
    // 会心は基準値頭打ちで0(会心率<1/7なので上振れ条件は不成立)。
    const state = makeState(ctx, [2, 0, 0, 0], 2, { currentPower: 'weak', clothType: 'regen', turn: 30 });

    const skill = ctx.engine.listSkills().find((s) => s.id === 'nuu')!;
    const candidate = {
      action: { type: 'sew' as const, skillId: 'nuu', anchor: { r: 1, c: 1 } },
      skillId: 'nuu',
      cost: ctx.engine.effectiveCost(state, skill),
      targetCells: [{ r: 1, c: 1, multiplier: 1 }],
    };
    const dist = actionDistribution(ctx.engine, state, ctx.config, candidate);
    const nonCrit = dist.cells
      .find((d) => d.r === 1 && d.c === 1)!
      .pmf.map((p) => p.remaining)
      .filter((r) => r !== 0)
      .sort((a, b) => a - b);
    expect(nonCrit).toEqual([-7, -6, -5, -4]);

    const choices = rankExpert(ctx, state);
    const nuu = findChoice(choices, 'nuu', 1, 1);
    expect(nuu).toBeDefined();
    expect(nuu!.tier).toBe(1.5);
  });

  // §10.18/v3c ライン複合押し出し(#26形): 2マス系ライン(滝のぼり=col2)の一方が押し出しマス
  // (r=+2)、他方が仕上げ寄与(r=8。全出目が黄色内|remaining|≤4)。烈風#31再現形
  // 「T29←(3,3)を滝のぼりで−7へ(同じ1手で(2,3)の8を0に仕上げる押し出し+仕上げの複合)」。
  // tierForRegenPushを直接呼んで検証する(rankExpert経由だと、仕上げ側(1,1)のPMFがA1誤差0
  // ボーナス(zeroBonusTier。既定0.5)の対象にもなり、押し出しティア自体の値が
  // tierForSewOrRecoverの他の加点/減点と混ざって読み取りにくくなるため。既存の-2直接呼び出し
  // テストと同じ方針)。
  it('滝のぼりで(2,1)を+2から押し出し(浅押し)しつつ(1,1)の8を同じ1手で黄色内に仕上げる複合は押し出しマス基準のティア1.5になる', () => {
    const ctx = makeCtx();
    // nuu@弱と同じ出目レンジ(taki_noboriのmultiplierも1): (2,1)=2→非会心{-4..-7}(浅押し)。
    // (1,1)=8→非会心{2,1,0,-1}・会心も頭打ちで0 → 全出目|remaining|≤4(黄色内)。
    const state = makeState(ctx, [8, 0, 2, 0], 2, { currentPower: 'weak', clothType: 'regen', turn: 30 });

    const skill = ctx.engine.listSkills().find((s) => s.id === 'taki_nobori')!;
    const candidate = {
      action: { type: 'sew' as const, skillId: 'taki_nobori', anchor: { r: 2, c: 1 } },
      skillId: 'taki_nobori',
      cost: ctx.engine.effectiveCost(state, skill),
      targetCells: [
        { r: 2, c: 1, multiplier: 1 },
        { r: 1, c: 1, multiplier: 1 },
      ],
    };
    const dist = actionDistribution(ctx.engine, state, ctx.config, candidate);
    const pushPmf = dist.cells.find((d) => d.r === 2 && d.c === 1)!.pmf;
    const finishPmf = dist.cells.find((d) => d.r === 1 && d.c === 1)!.pmf;
    expect(pushPmf.map((p) => p.remaining).filter((r) => r !== 0).sort((a, b) => a - b)).toEqual([-7, -6, -5, -4]);
    expect(finishPmf.every((p) => Math.abs(p.remaining) <= 4)).toBe(true);

    const prediction = predictRegenTarget(ctx, state);
    expect(tierForRegenPush(ctx, state, candidate, skill, dist, prediction)).toBe(1.5);

    // rankExpert経由でも候補自体は許可され続けることを確認する(E2で封殺されない)。
    const choices = rankExpert(ctx, state);
    const taki = choices.find(
      (ch) =>
        ch.scored.candidate.skillId === 'taki_nobori' &&
        ch.scored.candidate.targetCells.some((t) => t.r === 1 && t.c === 1) &&
        ch.scored.candidate.targetCells.some((t) => t.r === 2 && t.c === 1),
    );
    expect(taki).toBeDefined();
  });

  it('redCellCount>0では押し出しティアが付かない(§10.6「1つずつ」原則の回帰。tierForRegenPush再構成後も維持。§10.18)', () => {
    const ctx = makeCtx();
    // (1,2)=-3が既存の赤マス(redCellCount=1>0)。押し出し候補(1,1)のr=+2はpushCellTierの条件
    // (r∈{2,-2,3}かつPMFが押し出し帯内)を満たすが、tierForRegenPushの赤ゲート(既存の赤マスが
    // 0のときのみ。§10.6)によりnullになることを直接呼び出しで確認する。
    const state = makeState(ctx, [2, -3, 0, 0], 2, { currentPower: 'weak', clothType: 'regen', turn: 30 });
    const skill = ctx.engine.listSkills().find((s) => s.id === 'nuu')!;
    const candidate = {
      action: { type: 'sew' as const, skillId: 'nuu', anchor: { r: 1, c: 1 } },
      skillId: 'nuu',
      cost: ctx.engine.effectiveCost(state, skill),
      targetCells: [{ r: 1, c: 1, multiplier: 1 }],
    };
    const dist = actionDistribution(ctx.engine, state, ctx.config, candidate);
    const prediction = predictRegenTarget(ctx, state);
    expect(tierForRegenPush(ctx, state, candidate, skill, dist, prediction)).toBeNull();
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

  it('残20へのnuu@最強(同条件・§10.17訂正で許可に変わる): 誤差≤1の上振れは会心分(<1/7)しかないが、r=20≥approachMin(14)のE2深置き保険で上振れ条件なしに許可される', () => {
    const ctx = makeCtx();
    // 非会心残り=20-damage0={-4,-6,-8,-10,-12,-14,-16}(いずれも|残り|>1)。会心は同様に
    // 必ず頭打ち→残り0だが、その質量は会心率(奇跡針★3+コツ+パッシブ=4.3%+1%+0.1%=5.4%)のみで
    // 1/7(≈14.3%)未満 → 上振れ条件は満たさない。
    // §10.17訂正(E2深置き保険。v3c): 「#13の実際の判断基準は最大値216が出ても再生1回で
    // 回収可能」— 深置きの合法性は残り再生回数の予算で判定する。r=20≥approachMin(14)なので
    // 上振れ条件なしでfloor=regenOvershootFloor(-16)を適用 → 非会心最悪-16≥-16で許可される
    // (v3bでは「拒否」だったが、本仕様(v3c)では「許可」が正しい)。
    const state = makeState(ctx, [20, 0, 0, 0], 2, { currentPower: 'strongest', clothType: 'regen' });
    const choices = rankExpert(ctx, state);
    expect(findChoice(choices, 'nuu', 1, 1)).toBeDefined();
  });
});

// E2深置き保険(§10.17/v3c)。非carveフェーズ分岐で、対象マスの行動前残り r≥approachMin(14)なら
// 上振れ条件なしでregenOvershootFloor(-16)を適用する(床-16=最悪でも再生1回で回収可能な深さ、の
// 保険削り)。実例=ノクトルブーツ#13(しつけ×2の残201へ3倍@最強、出目{144..216}→残り{+57..-15})。
describe('E2深置き保険(§10.17/v3c)', () => {
  it('ブーツ#13再現形: しつけ済み(補正×2)の残201へ3倍@最強(出目{144..216}→残り{+57..-15})はphase=approachの非carveフェーズ分岐で上振れ条件なしに許可される', () => {
    // r=201(carveMin以上)の単独マスを含む盤面は analyzeBoard 上つねに bigCount≥1 となり
    // phase='carve'(regenCarveFloor=-30で無条件許可)に確定してしまい、非carveフェーズ分岐
    // (今回追加したregenOvershootFloor経路)を rankExpert 経由の統合テストでは再現できない。
    // passesE2 を直接呼び出し、phase='approach' を明示して検証する(tierForRegenPushの
    // 既存の直接呼び出しテストと同じ方針)。
    const ctx = makeCtx();
    const cells = [
      { r: 1, c: 1, base: 201, cumulative: 0, shitsuke: true }, // しつけ済み(補正×2)。残201
      { r: 1, c: 2, base: 100, cumulative: 100, shitsuke: false },
      { r: 2, c: 1, base: 100, cumulative: 100, shitsuke: false },
      { r: 2, c: 2, base: 100, cumulative: 100, shitsuke: false },
    ];
    const state = ctx.engine.createStateFromSnapshot({
      recipeId: 'e2-deep-insurance',
      category: 'test',
      clothType: 'regen',
      rows: 2,
      cols: 2,
      cells,
      massCount: 4,
      powerCycle: ['strongest'] as Power[],
      currentPower: 'strongest' as const,
      concentration: 200,
      turnStarted: true,
      hissatsuUsed: true,
    });

    const skill = ctx.engine.listSkills().find((s) => s.id === 'sanbai_nui')!;
    const candidate = {
      action: { type: 'sew' as const, skillId: 'sanbai_nui', anchor: { r: 1, c: 1 } },
      skillId: 'sanbai_nui',
      cost: ctx.engine.effectiveCost(state, skill),
      targetCells: [{ r: 1, c: 1, multiplier: 3 }],
    };
    const dist = actionDistribution(ctx.engine, state, ctx.config, candidate);
    const pmf = dist.cells.find((d) => d.r === 1 && d.c === 1)!.pmf;
    // SPEC§3.2: damage=roundPositive(roundPositive(roundPositive(12..18×3)×2)×2)
    // =roundPositive((36..54)×2)×2=roundPositive(72..108)×2=144..216。残り=201-{144..216}={57..-15}。
    const remainings = pmf.map((p) => p.remaining).sort((a, b) => a - b);
    expect(Math.min(...remainings)).toBe(-15);
    expect(Math.max(...remainings)).toBe(57);

    expect(passesE2(ctx, state, 'approach', candidate, dist)).toBe(true);
  });
});

// §10.13 詰み盤面の宝くじモード(光4#30〜34実例。2026-07-15エキスパート確認済み)。
// 盤面{0,+1,−1,+2}(massCount=4。星3境界=2)は、massCount4のevaluation境界(star3=2。
// src/data/game-params.json)に対し (1,1)=0・(1,2)=1・(2,1)=−1 の3マスが既に誤差1+1=2で
// 境界に到達済みのため、(2,2)=+2マスを誤差0ちょうどにする以外に★3の道がない「詰み」盤面。
describe('§10.13 詰み盤面の宝くじモード', () => {
  const LOTTERY_CELLS = [0, 1, -1, 2]; // (1,1)=0,(1,2)=1,(2,1)=-1,(2,2)=2。cols=2。

  function makeLotteryState(ctx: SolverContext, concentration: number) {
    return makeState(ctx, LOTTERY_CELLS, 2, { concentration });
  }

  // v3cレビューH1回帰: §10.13は盤面レベルの終盤概念。carve盤面(巨大マスあり)の弱ターンは
  // turnPhaseがadjustに昇格するが、rがDPドメイン(±30)を超える盤面ではpStar3が無意味に
  // 低くなるため、analysis.phase==='adjust' でゲートして誤発動させない。
  it('carve盤面(巨大マスあり)の弱ターンでは宝くじモードが発動しない(shiftにtier0が付かない)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [253, 5, 0, 0], 2, { currentPower: 'weak', concentration: 30 });
    const choices = rankExpert(ctx, state);
    const shift = choices.find((ch) => ch.scored.candidate.skillId === 'power_shift');
    if (shift) expect(shift.tier).toBeGreaterThan(0);
    expect(choices[0].scored.candidate.skillId).not.toBe('power_shift');
  });

  // v3cレビューM4回帰: ★3確定盤面ではfinish(tier0)が正解。宝くじは発動しない。
  it('★3確定盤面では宝くじモードが発動せずfinishが先頭', () => {
    const ctx = makeCtx();
    // 合計誤差2=4マスの★3境界ちょうど → judge=star3 → finishTier=0
    const state = makeState(ctx, [0, 1, -1, 0], 2, { currentPower: 'weak', concentration: 30 });
    const choices = rankExpert(ctx, state);
    expect(choices[0].scored.candidate.action.type).toBe('finish');
  });

  it('既定値はDEFAULT_POLICY_PARAMSに0.15として定義されている(§10.13の新パラメータ)', () => {
    expect(DEFAULT_POLICY_PARAMS.lotteryThreshold).toBe(0.15);
  });

  it('集中15(ねらい16不可): power_shiftがtier0で先頭(自動回復釣り分岐)', () => {
    const ctx = makeCtx();
    // ねらい(cost16)・糸ほぐし(cost16)とも15集中では列挙されず(enumerateCandidatesの
    // cost>concentrationフィルタ)、通常ルールで許可される非finish候補が0件になるため
    // 詰み判定のpStar3最大値は事実上0 < lotteryThreshold(0.15)。
    // power_shift: concentration(15)≥シフト実効コスト(7)かつ 集中15 < ねらい実効コスト(16)
    // (そもそも撃てない→自動回復釣り分岐)によりtier0。
    const state = makeLotteryState(ctx, 15);
    const choices = rankExpert(ctx, state);
    expect(choices[0].scored.candidate.skillId).toBe('power_shift');
    expect(choices[0].tier).toBe(0);
  });

  it('集中17(シフトは17−7=10<16で予算死守不可): nerai_nui(+2マス)がtier0.5で先頭、power_shiftは候補から外れる', () => {
    const ctx = makeCtx();
    // このconcentration17では、糸ほぐし(cost16)は列挙されるが行動後予算1(17-16)しか残らず
    // 全対象マスでpStar3=0(通常ルールで許可される候補のpStar3最大値が0<0.15)→詰み判定。
    // シフトは (17-7=10) < ねらい実効コスト16 かつ 17 ≥ 16(そもそも撃てないわけではない)ため
    // 予算死守条件を満たさずtier0を得られない(C8の旧ルールも糸ほぐし許可済みでnull)→候補から
    // 完全に外れる。ねらいぬいは使用可能(17≥16)なのでpStar3最大の単マス候補(+2マス)にtier0.5。
    const state = makeLotteryState(ctx, 17);
    const choices = rankExpert(ctx, state);

    expect(choices[0].scored.candidate.skillId).toBe('nerai_nui');
    expect(choices[0].tier).toBe(0.5);
    expect(choices[0].scored.candidate.targetCells).toEqual([{ r: 2, c: 2, multiplier: 1 }]);

    expect(findChoice(choices, 'power_shift', 0, 0)).toBeUndefined();
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'power_shift')).toBe(false);

    // 他候補(糸ほぐし)のティアは変更されない(相対的に下がるのみ。§10.13/実装コメント)。
    for (const ch of choices) {
      if (ch.scored.candidate.skillId === 'ito_hogushi') expect(ch.tier).toBe(1);
    }
  });

  it('集中23(シフトは23−7=16≥16でちょうど予算死守OKの境界): power_shiftがtier0で先頭、nerai_nuiがtier0.5で次点', () => {
    // 判断に迷った点: 仕様引用の実例は集中38(#31時点)だが、本実装のadjustDp(§10.8/v3a)で
    // 実測すると、集中38では糸ほぐし(+2マスへ。ほぐして残8〜11に戻したうえ残予算22で再度
    // 縫い直す2段構え)自体のpStar3が約0.41(≥lotteryThreshold=0.15)に達し、詰み判定
    // (非finish許可候補のpStar3最大値<0.15)が発動しない(=DPが糸ほぐし経由の別ルートを
    // 「安全手」として評価してしまい、宝くじモードの意図(§10.13「安全手は存在せず」)と
    // 食い違う。本実装のadjustDpはターン数上限をモデル化せず集中力予算のみで多段の縫い直しを
    // 許容するため、実際のリプレイでエキスパートが除外した「糸ほぐし→再度縫う」の多ターン
    // プランを許容してしまうことが原因と考えられる(要ユーザー確認事項として報告)。
    // 予算死守条件の算術自体(concentration−シフトコスト≥ねらいコスト)は集中23で
    // ちょうど境界(23−7=16)になり、かつこの集中では糸ほぐしのpStar3がまだ0.15未満に留まる
    // ため、詰み判定と予算死守分岐の両方を同時に検証できる最小の再現値として集中23を用いる。
    const ctx = makeCtx();
    const state = makeLotteryState(ctx, 23);
    const choices = rankExpert(ctx, state);

    expect(choices[0].scored.candidate.skillId).toBe('power_shift');
    expect(choices[0].tier).toBe(0);

    const nerai = choices.find((ch) => ch.scored.candidate.skillId === 'nerai_nui');
    expect(nerai).toBeDefined();
    expect(nerai!.tier).toBe(0.5);
    expect(nerai!.scored.candidate.targetCells).toEqual([{ r: 2, c: 2, multiplier: 1 }]);
  });

  it('非詰み盤面(半かげん系でpStar3高)では宝くじモードにならず従来先頭が維持される(回帰)', () => {
    const ctx = makeCtx();
    // 残6の1マスのみ(massCount4。他3マスは既に0で境界2に対し誤差0)。kagen_nui@normalの
    // 出目{6,8,8,8,8,10,10}(SPEC§3.2)は残6に対しpStar3が高く(通常ルールで既にtier0.5=
    // 単マス系tier1−zeroBonus0.5)、詰み盤面ではない → power_shiftはtierを得ず候補に出ない
    // (通常時の挙動が完全に維持されることの回帰確認。§4)。
    const state = makeState(ctx, [6, 0, 0, 0], 2, { concentration: 40 });
    const choices = rankExpert(ctx, state);

    expect(choices[0].scored.candidate.skillId).toBe('kagen_nui');
    expect(choices[0].tier).toBe(0.5);
    expect(choices.some((ch) => ch.scored.candidate.skillId === 'power_shift')).toBe(false);
  });
});

// v3cレビュー指摘の回帰テスト(M2/L6)。
describe('v3cレビュー修正の回帰', () => {
  // M2: しつけは計画レベルの行動なので盤面全体フェーズで判定する。弱ターン(turnPhase=adjust)でも
  // carve盤面では①(巨大マスのみtier2)が生き、②(r>=5一律tier1)は発動しない。
  it('carve盤面の弱ターン: しつけは巨大マス(253)のみtier2、中マス(20)・小マス(5)には付かない', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [253, 5, 20, 0], 2, { currentPower: 'weak', concentration: 200 });
    const choices = rankExpert(ctx, state);
    const big = findChoice(choices, 'shitsuke_gake', 1, 1);
    expect(big).toBeDefined();
    expect(big!.tier).toBe(2);
    expect(findChoice(choices, 'shitsuke_gake', 2, 1)).toBeUndefined(); // r=20
    expect(findChoice(choices, 'shitsuke_gake', 1, 2)).toBeUndefined(); // r=5
  });

  // L6: E2の押し出し帯例外は押し出し対象値(+2/-2/+3)に限定する。r=+1への深縫い
  // (ぬう@弱: 出目6..9 -> 残り-5..-8)は帯内でも許可しない(通常床-4で拒否)。
  it('再生布: r=+1へのぬう@弱(全出目が押し出し帯内)はE2で拒否される(押し出し対象値ではない)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [1, 20, 0, 0], 2, {
      currentPower: 'weak',
      clothType: 'regen',
      turn: 30,
      concentration: 200,
    });
    const choices = rankExpert(ctx, state);
    expect(findChoice(choices, 'nuu', 1, 1)).toBeUndefined();
  });
});

// v3d(SOLVER_POLICY §10.19 エキスパート回答): 「アプローチに入れる段階に削るまでは集中効率を
// 最も優先すべきです」「削りの集中効率を降順ソートすれば…みだれを打てる回数を増やすことが
// 集中効率の改善につながる」。carveフェーズの同ティア内タイブレークを削り効率(§10.19①)で
// ソートし、×2打がみだれ封じ帯の小マスを作り得るときのみみだれをtier2へ格下げする(回答(a))。
describe('v3d 削りフェーズの集中効率化(§10.19)', () => {
  it('T2アンカー: 烈風のころも下・最強ターン・残[154,200,262,93,90,222]((1,1)〜(3,2))・regen・carve・未ロック → 1位はsanbai_nui(3,2)。みだれはtier2に格下げされる', () => {
    const ctx = makeCtx();
    // アンカー引用: 「D(残93)やE(残90)に2倍部分が当たると…みだれが打てなくなります。
    // …私なら、この場合、F(残222)に3倍します。Cではないのは、みだれが打てなくなった後に
    // 多マスの削りで巻き込みやすい位置のためです」(正着=3倍ぬい(3,2)=F)。
    // E(3,1)=残90は3倍@最強の非会心ダメージ表{72,78,84,90,…}にちょうど含まれ、A1誤差0
    // ボーナスの対象(残0確率≈18.9%≥1/7)になる。v3dでA1をcarve中は不適用にゲートしたため
    // (§10.19②⑤: 削り中の1マス仕上げ狙いは効率悪化)、実盤面どおり残90のままで
    // 予約規則(0.75)がボーナスに逆転されないことも本テストで保証する。
    // 追記(v3e/§10.20②): 単発の再生緩和floorがmidareStopLoss(-16)化されたため、
    // sanbai_nui@E(90)は非会心最悪90-108=-18<-16でE2自体に失格し候補から消える
    // (=A1との逆転可能性自体が本テストの実行対象から外れる)。choices[0]/みだれtierの
    // アサーションには影響しないため、本テストの期待値はそのまま維持する。
    const state = makeState(ctx, [154, 200, 262, 93, 90, 222], 2, {
      currentPower: 'strongest',
      clothType: 'regen',
      lockPowerRemaining: 0,
      lockedPower: null,
    });
    const choices = rankExpert(ctx, state);

    expect(choices[0].scored.candidate.skillId).toBe('sanbai_nui');
    expect(choices[0].scored.candidate.targetCells).toEqual([{ r: 3, c: 2, multiplier: 3 }]);

    const midare = choices.find((ch) => ch.scored.candidate.skillId === 'midare_nui');
    expect(midare).toBeDefined();
    expect(midare!.tier).toBe(2);
  });

  it('全マス残≥160の6マスregen盤面・最強・carveでは×2打が封じ帯を作らないため、みだれが首位(tier1)のまま先頭になる', () => {
    const ctx = makeCtx();
    // 強の×2打最大54を引いても 160-54=106 > 帯上限38 なので、どのマスも封じ帯に入らない。
    const state = makeState(ctx, [200, 190, 180, 170, 160, 165], 2, {
      currentPower: 'strongest',
      clothType: 'regen',
      lockPowerRemaining: 0,
      lockedPower: null,
    });
    const choices = rankExpert(ctx, state);

    const midare = choices.find((ch) => ch.scored.candidate.skillId === 'midare_nui');
    expect(midare).toBeDefined();
    expect(midare!.tier).toBe(1);
    expect(choices[0].scored.candidate.skillId).toBe('midare_nui');
  });

  // v3e(§10.20①): 「以降の手でみだれを選択し得る場合は、残が小さいところには極力手を付けない
  // ようにするべきです」。この盤面(みだれ生存中=midareAliveAtNormal)ではkagen_nui@(1,1)=4が
  // 「小残マス(0<r<midareReserveCellMax)」に該当するため、受け持ち予約の格下げ(+1)が乗り、
  // 旧tier3→tier4になる(旧テストの期待値を更新)。
  it('普通ターン・残4マスあり(他は大マス)・regenのcarveでは、regenCarveFloor(-34)によりみだれが許可され(C1: 最悪4-36=-32≥-34)、かげん系単発(tier4=旧tier3+みだれ受け持ち予約§10.20①)より上位になる', () => {
    const ctx = makeCtx();
    // 普通パワーの×2打最大=36。旧既定floor(-30)なら4-36=-32<-30で禁止だったが、
    // 新既定(-34)では -32≥-34 で許可される(§10.19⑤/types.tsコメント参照)。
    const state = makeState(ctx, [4, 200, 200, 200], 2, {
      currentPower: 'normal',
      clothType: 'regen',
      lockPowerRemaining: 0,
      lockedPower: null,
    });
    const analysis = analyzeBoard(ctx, state);
    expect(analysis.phase).toBe('carve');

    const choices = rankExpert(ctx, state);
    const midare = choices.find((ch) => ch.scored.candidate.skillId === 'midare_nui');
    expect(midare).toBeDefined();
    expect(midare!.tier).toBe(1);

    const kagen = findChoice(choices, 'kagen_nui', 1, 1);
    expect(kagen).toBeDefined();
    // v3e(§10.20①): みだれ生存中のcarveで小残マス(r=4)に手を付けるkagen_nuiは受け持ち予約
    // により+1され、旧tier3からtier4になる。
    expect(kagen!.tier).toBe(4);
    expect(choices.indexOf(midare!)).toBeLessThan(choices.indexOf(kagen!));
  });
});

// v3e(SOLVER_POLICY §10.20 コーチング第2ラウンド): 「以降の手でみだれを選択し得る場合は、
// 残が小さいところには極力手を付けないようにするべきです」(①受け持ち予約の一般化)。
// 「最強3倍を使っていいのは実質残92まで」(②単発縫いすぎ床=-16)。carve中の糸ほぐしは
// 「貴重にならないぬいパワー(弱)」限定で、1回復圏は再生任せ(③④⑤)。盤面は既存ヘルパに
// 従い6マスregen((1,1)〜(3,2)の順)で統一する。
describe('v3e コーチング第2ラウンド(§10.20)', () => {
  /** skillId + アンカー座標で候補を一意に特定する(makikomi_nui等、同じマスが複数アンカーの
   *  対象に重複して現れ得る候補をfindChoice(targetCells一致)より厳密に区別するためのヘルパ)。 */
  function findByAnchor(choices: ExpertChoice[], skillId: string, r: number, c: number): ExpertChoice | undefined {
    return choices.find(
      (ch) =>
        ch.scored.candidate.skillId === skillId &&
        ch.scored.candidate.action.type === 'sew' &&
        ch.scored.candidate.action.anchor.r === r &&
        ch.scored.candidate.action.anchor.c === c,
    );
  }

  it('T8アンカー: 残[101,192,175,54,33,138]((1,1)〜(3,2))・最強・carve・未ロック → 1位はsanbai_nui(1,2)(=B192)。makikomi_nui(3,1)とsanbai_nui(1,1)は受け持ち予約(§10.20①)で格下げされる(tier>1)', () => {
    const ctx = makeCtx();
    // アンカー引用(§10.20①): 「以降の手でみだれを選択し得る場合は、残が小さいところには
    // 極力手を付けないようにするべきです。」(T8巻きこみ@33が悪手、正着=3倍@B192)。
    const state = makeState(ctx, [101, 192, 175, 54, 33, 138], 2, {
      currentPower: 'strongest',
      clothType: 'regen',
      lockPowerRemaining: 0,
      lockedPower: null,
    });
    const choices = rankExpert(ctx, state);

    expect(choices[0].scored.candidate.skillId).toBe('sanbai_nui');
    expect(choices[0].scored.candidate.targetCells).toEqual([{ r: 1, c: 2, multiplier: 3 }]);

    // 巻きこみ@(3,1)(=E=33を中心に含む): みだれ生存中(midareAliveAtNormal)のcarveで
    // 小残マス(E=33)に手を付けるため受け持ち予約(+1)が乗り格下げされる。
    const makikomi31 = findByAnchor(choices, 'makikomi_nui', 3, 1);
    expect(makikomi31).toBeDefined();
    expect(makikomi31!.tier).toBeGreaterThan(1);

    // 3倍@(1,1)(=A=101。r0<midareReserveCellMax=120のため0.75分岐に入らずbase tier1→
    // 受け持ち予約で+1され2になる)。
    const sanbaiA = findByAnchor(choices, 'sanbai_nui', 1, 1);
    expect(sanbaiA).toBeDefined();
    expect(sanbaiA!.tier).toBeGreaterThan(1);
  });

  it('T12アンカー: 残[76,177,159,24,0,112]((1,1)〜(3,2))・最強・carve → sanbai_nui(1,1)は候補に出ない(単発床§10.20②: 76-108=-32<-16)。1位はotaki_nobori(1,2)(=B,D,F列。D=24を含む大滝が効率首位)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [76, 177, 159, 24, 0, 112], 2, {
      currentPower: 'strongest',
      clothType: 'regen',
      lockPowerRemaining: 0,
      lockedPower: null,
    });
    const choices = rankExpert(ctx, state);

    // §10.20②: 単発(対象マス1つ)の再生緩和floorはmidareStopLoss(-16)。
    // A=76への3倍@最強は非会心最悪76-108=-32<-16でE2失格。
    expect(findByAnchor(choices, 'sanbai_nui', 1, 1)).toBeUndefined();

    expect(choices[0].scored.candidate.skillId).toBe('otaki_nobori');
    expect(choices[0].scored.candidate.targetCells).toEqual(
      expect.arrayContaining([
        { r: 1, c: 2, multiplier: 1 },
        { r: 2, c: 2, multiplier: 1 },
        { r: 3, c: 2, multiplier: 1 },
      ]),
    );
  });

  it('T13アンカー: 残[-10,177,159,24,0,112]((1,1)〜(3,2))・critx2・carve → ito_hogushi(1,1)は候補に出ない(carve中ほぐしは弱パワー限定。§10.20③)', () => {
    const ctx = makeCtx();
    const state = makeState(ctx, [-10, 177, 159, 24, 0, 112], 2, {
      currentPower: 'critx2',
      clothType: 'regen',
      lockPowerRemaining: 0,
      lockedPower: null,
    });
    const choices = rankExpert(ctx, state);
    // critx2はeffPowerで'normal'に畳まれる(B4)。§10.20③「調整は貴重にならないぬいパワー
    // (弱)で行う」によりcarve中のほぐしは弱パワー限定 → normal(critx2)では候補に出ない。
    expect(findChoice(choices, 'ito_hogushi', 1, 1)).toBeUndefined();
  });

  it('T16アンカー: 残[5,137,159,-3,0,86]((1,1)〜(3,2))・弱・carve → midare_nuiは候補に出ない(C1仕上げ済みガード§10.20④: 0がある)。1位はito_hogushi(2,2)(tier0.5)', () => {
    const ctx = makeCtx();
    // アンカー引用(§10.20④): 「0がある状況で打つ手ではない。この盤面なら-3の糸ほぐし
    // (弱ほぐし+3〜4で0/+1着地)」。
    const state = makeState(ctx, [5, 137, 159, -3, 0, 86], 2, {
      currentPower: 'weak',
      clothType: 'regen',
      lockPowerRemaining: 0,
      lockedPower: null,
    });
    const choices = rankExpert(ctx, state);

    expect(choices.some((ch) => ch.scored.candidate.skillId === 'midare_nui')).toBe(false);

    expect(choices[0].scored.candidate.skillId).toBe('ito_hogushi');
    expect(choices[0].scored.candidate.targetCells).toEqual([{ r: 2, c: 2, multiplier: 1 }]);
    expect(choices[0].tier).toBe(0.5);
  });

  it('弱・carve・再生布・残-16のマスへのito_hogushiは候補に出ない(1回復圏は再生任せ。§10.20⑤)', () => {
    const ctx = makeCtx();
    // アンカー引用(§10.20相当): 「-16は再生に任せる」。carve局面を確保するため他マスは
    // 大マス(200)で埋める(bigCount>0によりv3dのturnPhase弱ハイジャックゲートも維持されcarveのまま)。
    const state = makeState(ctx, [-16, 200, 200, 200, 200, 200], 2, {
      currentPower: 'weak',
      clothType: 'regen',
      lockPowerRemaining: 0,
      lockedPower: null,
    });
    const analysis = analyzeBoard(ctx, state);
    expect(analysis.phase).toBe('carve');

    const choices = rankExpert(ctx, state);
    expect(findChoice(choices, 'ito_hogushi', 1, 1)).toBeUndefined();
  });

  describe('単発床境界(§10.20②): 最強・carve・regenへのsanbai_nuiは残92まで許可(92-108=-16)、残91は不許可', () => {
    function makeBoundaryState(ctx: SolverContext, r: number): GameState {
      return makeState(ctx, [r, 200, 200, 200, 200, 200], 2, {
        currentPower: 'strongest',
        clothType: 'regen',
        lockPowerRemaining: 0,
        lockedPower: null,
      });
    }

    it('残92: 非会心最悪92-108=-16=midareStopLossちょうどで許可される', () => {
      const ctx = makeCtx();
      const state = makeBoundaryState(ctx, 92);
      const choices = rankExpert(ctx, state);
      expect(findByAnchor(choices, 'sanbai_nui', 1, 1)).toBeDefined();
    });

    it('残91: 非会心最悪91-108=-17<-16で不許可(E2失格)', () => {
      const ctx = makeCtx();
      const state = makeBoundaryState(ctx, 91);
      const choices = rankExpert(ctx, state);
      expect(findByAnchor(choices, 'sanbai_nui', 1, 1)).toBeUndefined();
    });
  });
});
