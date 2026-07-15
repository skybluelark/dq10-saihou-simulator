// 調整厳密DP(adjust-dp.ts)のテスト。SOLVER_POLICY.md §10.4(B2)の「弱ロック後はルールでは
// なく厳密DP」を検証する。6章「終盤定石」(E1)との一致状況もあわせて確認し、乖離があれば
// 数値付きでテストに残す(暗記定石と厳密計算の差分はこのプロジェクトの重要な発見)。

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SimulatorConfig } from '../../src/core';
import {
  buildAdjustDp,
  adjustLookup,
  allocateAdjustBudget,
  DEFAULT_ADJUST_DP_PARAMS,
  type AdjustDp,
} from '../../src/stats';
import { buildEngineData } from '../fixtures/engine-helpers';

// 奇跡のさいほう針★3(needleCritRate=0.043)。SOLVER_POLICY.md の「37.8%(奇跡針)」記述と
// 同条件(kotsu=true・passiveCritUp=trueのDEFAULT_CONFIG)。
const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'miracle', stars: 3 } };

function makeDp(): AdjustDp {
  const data = buildEngineData();
  return buildAdjustDp(data, config);
}

describe('buildAdjustDp: 構築時間', () => {
  it('テーブル構築は200ms以内(実測は概ね30ms前後)', () => {
    const data = buildEngineData();
    const t0 = performance.now();
    buildAdjustDp(data, config);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200);
  });
});

describe('E1定石一致(十分な予算 b=30)', () => {
  // SOLVER_POLICY.md §6「終盤定石」: 3〜5=かげん / 6=半かげん / 7・8・10=ぬう(弱パワー基準)。
  it('r=3,4,5 → kagen_nui', () => {
    const dp = makeDp();
    for (const r of [3, 4, 5]) {
      expect(adjustLookup(dp, r, 30, false).firstOp).toBe('kagen_nui');
    }
  });

  it('r=6 → han_kagen_nui', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, 6, 30, false).firstOp).toBe('han_kagen_nui');
  });

  // r=7,8: DPの厳密最適はb=18以降 nerai_nui(37.8%会心)に切り替わる(b=7〜17はnuu)。
  // E1定石(ぬう)は「実戦で18集中も1マスに割けない」場面の現実的近似と解釈できるため、
  // 期待値上の最適が割れる場合はテストを緩める(タスク仕様の指示どおり)。
  it('r=7,8 → nuu または nerai_nui(b=30ではnerai_nuiが厳密最適。判断は報告参照)', () => {
    const dp = makeDp();
    for (const r of [7, 8]) {
      expect(['nuu', 'nerai_nui']).toContain(adjustLookup(dp, r, 30, false).firstOp);
    }
  });

  // r=10: b=30の厳密最適(償却3.5校正後)はhan_kagen_nui(b=29〜32帯。b=33〜43はkagen_nui)。
  // E1「10=ぬう」との乖離は§10.8で解決済み: 乖離はexpErr目的関数と償却の問題であり、
  // pLe1表・素の集中では定石(かげんスタート)と一致する(scripts/solver-dp-dump.ts 参照)。
  it('r=10 → han_kagen_nui(b=30の厳密最適。償却3.5校正後の記録)', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, 10, 30, false).firstOp).toBe('han_kagen_nui');
  });
});

describe('刻み: r=11〜13(集中余剰時の2手刻み)', () => {
  // ぬう(実コスト7=5+upkeep2)を打てる最小予算帯でnuuが最適。b=17はタスク仕様が示す閾値。
  // 注: b=17を超えると r=11 は nerai_nui(b=18)→nuu(b=19〜25)→kagen/han_kagen(b>=26)と
  // 何度も入れ替わる(r=12,13はより高い予算までnuuを維持)。この揺れは「判断に迷った点」参照。
  it('r=11〜13, b=17 → firstOp=nuu', () => {
    const dp = makeDp();
    for (const r of [11, 12, 13]) {
      expect(adjustLookup(dp, r, 17, false).firstOp).toBe('nuu');
    }
  });
});

describe('+2ルート: r=2', () => {
  // 実測の閾値(償却3.5): b=33〜34はkagen_nui(直接打ち)がito_hogushi(未着手)より優れ、
  // b=35以降でito_hogushi(expErr=0.676)が上回る。35 = 素の集中28(ほぐし16+半かげん12。
  // §10.8で定石と一致確認済み)+ 償却3.5×2手。3段階(打ち止め/kagen_nui/ito_hogushi)。
  it('小予算(b<33)では打ち止めが最適(悪化させない)', () => {
    const dp = makeDp();
    for (const b of [0, 10, 20, 27, 29, 32]) {
      expect(adjustLookup(dp, 2, b, false).firstOp).toBeNull();
    }
  });

  it('b=33〜34はkagen_nuiが最適(中間段階)', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, 2, 33, false).firstOp).toBe('kagen_nui');
    expect(adjustLookup(dp, 2, 34, false).firstOp).toBe('kagen_nui');
  });

  it('b≥35でito_hogushiが最適(素28+償却3.5×2手)', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, 2, 35, false).firstOp).toBe('ito_hogushi');
    expect(adjustLookup(dp, 2, 40, false).firstOp).toBe('ito_hogushi');
  });
});

describe('−3/−2(残り値の非対称性 A1/C5/E3)', () => {
  it('r=−3: b=19は打ち止め、b≥19.5(=ほぐし16+償却3.5)でito_hogushiが最適(0.5刻み格子の境界)', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, -3, 19, false).firstOp).toBeNull();
    expect(adjustLookup(dp, -3, 19.5, false).firstOp).toBe('ito_hogushi');
    expect(adjustLookup(dp, -3, 20, false).firstOp).toBe('ito_hogushi');
    expect(adjustLookup(dp, -3, 30, false).firstOp).toBe('ito_hogushi');
  });

  // 実用的な予算(b<19.5)ではr=−2は放置(C5「−2は放置可」と一致)。
  // ただしb>=19.5の単セルDPはito_hogushiで2.0→1.5へ改善できてしまう(C5は
  // 「複数マスへ予算を配る中で−2の優先度は低い」という機会費用の話であり、
  // 単セルを孤立させて予算を無制限に与えれば改善余地はある、という整理になる。
  it('r=−2: 実用的な予算(b<19.5)では打ち止め', () => {
    const dp = makeDp();
    for (const b of [0, 5, 10, 17, 19]) {
      expect(adjustLookup(dp, -2, b, false).firstOp).toBeNull();
    }
  });

  it('r=−2: b>=19.5では単セルDP上はito_hogushiが改善する(C5「放置可」の機会費用前提からの乖離を記録)', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, -2, 20, false).firstOp).toBe('ito_hogushi');
    expect(adjustLookup(dp, -2, 20, false).expErr).toBeCloseTo(1.5, 9);
  });
});

describe('予算単調性', () => {
  it('全rで予算bが増えるとexpErrは非増加', () => {
    const dp = makeDp();
    const { rMin, rMax, budgetMax } = dp.params;
    for (let r = rMin; r <= rMax; r++) {
      let prev = adjustLookup(dp, r, 0, false).expErr;
      for (let b = 1; b <= budgetMax; b++) {
        const cur = adjustLookup(dp, r, b, false).expErr;
        expect(cur).toBeLessThanOrEqual(prev + 1e-9);
        prev = cur;
      }
    }
  });

  it('しつけ有無(shitsuke=true)側でも同様に非増加', () => {
    const dp = makeDp();
    const { rMin, rMax, budgetMax } = dp.params;
    for (let r = rMin; r <= rMax; r += 3) {
      let prev = adjustLookup(dp, r, 0, true).expErr;
      for (let b = 1; b <= budgetMax; b++) {
        const cur = adjustLookup(dp, r, b, true).expErr;
        expect(cur).toBeLessThanOrEqual(prev + 1e-9);
        prev = cur;
      }
    }
  });
});

describe('pZero手計算照合', () => {
  // r=7・b=9: 実コスト8.5(=5+償却3.5)のnuuのみ実行可(かげん以上は実コスト>=13.5で不可)。
  // 残り予算0.5では何も打てないので後続はcellErrorScoreそのもの(=|r'|が4以下ならその値)。
  // nuuのダメージ(弱・倍率1・補正1): 基礎値12〜18 → d0=[6,7,7,8,8,9,9]。
  // r=7>0なので会心判定あり。会心後は2*d0が常に7以上のため必ず頭打ちでr'=0。
  // 非会心はr'=7-d0=[1,0,0,-1,-1,-2,-2] → 0になるのはbv=13,14の2/7のみ。
  // pZero = p(会心, 常に0) + (2/7)(1-p)(非会心でd0=7が出る2/7)。
  it('r=7・b=9(ぬうのみ) → pZero = p + (2/7)(1-p)', () => {
    const dp = makeDp();
    const needleCritRate = 0.043; // miracle★3
    const p = needleCritRate + 0.01 /* kotsuBonus */ + 0.001; /* passiveEffective(aim=falseなのでaimMultiplier適用なし) */
    const expectedPZero = p + (2 / 7) * (1 - p);

    const entry = adjustLookup(dp, 7, 9, false);
    expect(entry.firstOp).toBe('nuu');
    expect(entry.pZero).toBeCloseTo(expectedPZero, 9);
    // 独立した手計算(非会心7ロールのcellErrorScore平均)でexpErrも突き合わせる。
    // 非会心スコア=[1,0,0,1,1,2,2](|r'|がそのまま。全て黄色域4以内)、合計7。
    const expectedExpErr = (1 - p) * (1 / 7) * 7;
    expect(entry.expErr).toBeCloseTo(expectedExpErr, 9);
  });
});

describe('allocateAdjustBudget', () => {
  it('2マス(r=7, r=13)にconc=20を割ると、改善の大きいマスへ優先配分され合計はconc以下', () => {
    const dp = makeDp();
    const cells = [
      { r: 7, shitsuke: false },
      { r: 13, shitsuke: false },
    ];
    const { perCell, totalExpErr } = allocateAdjustBudget(dp, cells, 20);

    const sum = perCell.reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(20);

    // 割当なしの基準値(9+13=22)より必ず改善する。
    expect(totalExpErr).toBeLessThan(22);

    // r=13の方が伸びしろが大きい(cellErrorScore(13)=13 > cellErrorScore(7)=9 かつ
    // 到達可能な最良値もr=13の方が下がり幅が大きい)ため、より多く配分される。
    expect(perCell[1]).toBeGreaterThan(perCell[0]);

    // 実測(償却3.5): perCell=[9,11](conc全量を消費。r=7はぬう実コスト8.5が乗る9)。
    expect(perCell).toEqual([9, 11]);
  });

  it('割当を増やしても悪化しない(conc=0では何も配分しない)', () => {
    const dp = makeDp();
    const cells = [{ r: 7, shitsuke: false }];
    const { perCell, totalExpErr } = allocateAdjustBudget(dp, cells, 0);
    expect(perCell).toEqual([0]);
    expect(totalExpErr).toBe(adjustLookup(dp, 7, 0, false).expErr);
  });
});

describe('決定論', () => {
  it('同一入力で2回buildしても同一テーブル', () => {
    const data = buildEngineData();
    const dp1 = buildAdjustDp(data, config);
    const dp2 = buildAdjustDp(data, config);
    expect(dp2).toEqual(dp1);
  });

  it('adjustLookupの域外クランプ(r・budgetともにドメイン端へ)', () => {
    const dp = makeDp();
    const { rMin, rMax, budgetMax } = dp.params;
    expect(adjustLookup(dp, rMin - 100, budgetMax + 100, false)).toEqual(adjustLookup(dp, rMin, budgetMax, false));
    expect(adjustLookup(dp, rMax + 100, -100, false)).toEqual(adjustLookup(dp, rMax, 0, false));
  });
});

// §10.8(A1回答=Q1解決。2026-07-15): objective='pLe1'の決定表を検証する。
// タスク仕様に記載の「検証済み事実」5点(2026-07-15、scripts/solver-dp-dump.ts相当の実測値)。
// AdjustDpParams={rMin:-30,rMax:30,budgetMax:60,lockUpkeep:0}を明示する(§10.8「+2ほぐしルート
// の損益分岐: 素の集中ではb=28」の「素の集中」= lockUpkeep=0 に対応)。
describe('objective=pLe1の決定表(§10.8。検証済み事実5点)', () => {
  const adjParams = { ...DEFAULT_ADJUST_DP_PARAMS, rMin: -30, rMax: 30, budgetMax: 60, lockUpkeep: 0 };

  function makePLe1Dp(): AdjustDp {
    const data = buildEngineData();
    return buildAdjustDp(data, config, adjParams, 'pLe1');
  }

  it('r=+2: firstOpが\'ito_hogushi\'になる最小予算はb=28', () => {
    const dp = makePLe1Dp();
    expect(adjustLookup(dp, 2, 27, false).firstOp).not.toBe('ito_hogushi');
    expect(adjustLookup(dp, 2, 28, false).firstOp).toBe('ito_hogushi');
  });

  it('r=+8, b=40: firstOp=\'nuu\'(pLe1≈0.991)', () => {
    const dp = makePLe1Dp();
    const entry = adjustLookup(dp, 8, 40, false);
    expect(entry.firstOp).toBe('nuu');
    expect(entry.pLe1).toBeCloseTo(0.991, 3);
  });

  it('r=+6: b=12以降firstOpが\'han_kagen_nui\'(pLe1=1.0近傍)', () => {
    const dp = makePLe1Dp();
    for (const b of [12, 13, 20, 40]) {
      const entry = adjustLookup(dp, 6, b, false);
      expect(entry.firstOp).toBe('han_kagen_nui');
      expect(entry.pLe1).toBeCloseTo(1, 6);
    }
    // b=11以前はhan_kagen_nui(実コスト12=cost12+upkeep0)がまだ打てない。
    expect(adjustLookup(dp, 6, 11, false).firstOp).not.toBe('han_kagen_nui');
  });

  it('r=+7: b=16〜20は\'nerai_nui\'、b=21〜31は\'nuu\'', () => {
    const dp = makePLe1Dp();
    for (const b of [16, 17, 18, 19, 20]) {
      expect(adjustLookup(dp, 7, b, false).firstOp).toBe('nerai_nui');
    }
    for (const b of [21, 22, 25, 28, 31]) {
      expect(adjustLookup(dp, 7, b, false).firstOp).toBe('nuu');
    }
  });

  it('r=-3: b=16以降\'ito_hogushi\'', () => {
    const dp = makePLe1Dp();
    for (const b of [16, 17, 20, 30]) {
      expect(adjustLookup(dp, -3, b, false).firstOp).toBe('ito_hogushi');
    }
  });
});

// §10.8 確定パターン(読み切り。エキスパート確認済み 2026-07-15):
// 「しつけ→(半)かげん→(−3が出たら)ほぐし」で誤差1以内が確定する(pLe1=1)。
// 残7: しつけ13+かげん10+ほぐし16=39(実戦は精神統一+7を含め集中46で判断)。
// 残11: しつけ13+半かげん12+ほぐし16=41(同48)。しつけ×2補正でかげん出目は{6,8,8,8,8,10,10}、
// 半かげん出目は{10,10,12,12,12,14,14}になり、外れの−3を糸ほぐし{+3,+3,+4,+4}が確実に0/1へ戻す。
describe('objective=pLe1の確定パターン(§10.8。エキスパート確認済み)', () => {
  const adjParams = { ...DEFAULT_ADJUST_DP_PARAMS, lockUpkeep: 0 };

  it('r=+7: b=39以降firstOp=しつけがけ(しつけ→かげん→(−3)ほぐしの読み切り。pLe1=1)', () => {
    const data = buildEngineData();
    const dp = buildAdjustDp(data, config, adjParams, 'pLe1');
    expect(adjustLookup(dp, 7, 38, false).firstOp).not.toBe('shitsuke_gake');
    const entry = adjustLookup(dp, 7, 39, false);
    expect(entry.firstOp).toBe('shitsuke_gake');
    expect(entry.pLe1).toBeCloseTo(1, 6);
  });

  it('r=+11: b=41以降firstOp=しつけがけ(しつけ→半かげん→(−3)ほぐしの読み切り。pLe1=1)', () => {
    const data = buildEngineData();
    const dp = buildAdjustDp(data, config, adjParams, 'pLe1');
    expect(adjustLookup(dp, 11, 40, false).firstOp).not.toBe('shitsuke_gake');
    const entry = adjustLookup(dp, 11, 41, false);
    expect(entry.firstOp).toBe('shitsuke_gake');
    expect(entry.pLe1).toBeCloseTo(1, 6);
  });
});

// §10.8「objective省略時(既定'expErr')は従来挙動と完全一致(既存テストが担保。壊さないこと)」の
// 明示的な回帰確認: 3つの目的関数(expErr/pZero/pLe1)を同一パラメータで構築しても、既定
// (objective省略)がexpErr指定と完全一致することを確認する。
describe('objective省略時はexpErrと完全一致(§10.8。既存挙動の保護)', () => {
  it('全rMin〜rMaxで既定引数とexpErr明示引数のテーブルが一致', () => {
    const data = buildEngineData();
    const dpDefault = buildAdjustDp(data, config);
    const dpExplicit = buildAdjustDp(data, config, DEFAULT_ADJUST_DP_PARAMS, 'expErr');
    expect(dpDefault).toEqual(dpExplicit);
  });
});
