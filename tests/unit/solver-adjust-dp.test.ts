// 調整厳密DP(adjust-dp.ts)のテスト。SOLVER_POLICY.md §10.4(B2)の「弱ロック後はルールでは
// なく厳密DP」を検証する。6章「終盤定石」(E1)との一致状況もあわせて確認し、乖離があれば
// 数値付きでテストに残す(暗記定石と厳密計算の差分はこのプロジェクトの重要な発見)。

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SimulatorConfig } from '../../src/core';
import { buildAdjustDp, adjustLookup, allocateAdjustBudget, type AdjustDp } from '../../src/stats';
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

  // r=10: b=30の厳密最適はnuuでもnerai_nuiでもなくkagen_nui(expErr=0.660)。
  // nuu(b=7〜17,expErr=2.162)・nerai_nui(b=18のみ一時的にexpErr=1.422)・
  // han_kagen_nui(b=26〜29,expErr=0.676)より僅差で上回る。E1「10=ぬう」との明確な乖離。
  it('r=10 → kagen_nui(b=30の厳密最適。E1「ぬう」からの乖離を記録)', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, 10, 30, false).firstOp).toBe('kagen_nui');
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
  // タスク仕様は「b≥28でito_hogushiが最適」と想定するが、実測の閾値はb=32。
  // b=30〜31はkagen_nui(直接打ち。expErr=1.081)がito_hogushi(未着手)より優れ、
  // b=32以降でようやくito_hogushi(expErr=0.676)が上回る。3段階(打ち止め/kagen_nui/
  // ito_hogushi)であり、タスク仕様の二値(打ち止め or ito_hogushi)より1段階多い。
  it('小予算(b<30)では打ち止めが最適(悪化させない)', () => {
    const dp = makeDp();
    for (const b of [0, 10, 20, 27, 29]) {
      expect(adjustLookup(dp, 2, b, false).firstOp).toBeNull();
    }
  });

  it('b=30〜31はkagen_nuiが最適(タスク仕様が想定しない中間段階)', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, 2, 30, false).firstOp).toBe('kagen_nui');
    expect(adjustLookup(dp, 2, 31, false).firstOp).toBe('kagen_nui');
  });

  it('b≥32でito_hogushiが最適', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, 2, 32, false).firstOp).toBe('ito_hogushi');
    expect(adjustLookup(dp, 2, 40, false).firstOp).toBe('ito_hogushi');
  });
});

describe('−3/−2(残り値の非対称性 A1/C5/E3)', () => {
  it('r=−3: b=17は打ち止め、b≥18でito_hogushiが最適(タスク仕様の閾値と一致)', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, -3, 17, false).firstOp).toBeNull();
    expect(adjustLookup(dp, -3, 18, false).firstOp).toBe('ito_hogushi');
    expect(adjustLookup(dp, -3, 30, false).firstOp).toBe('ito_hogushi');
  });

  // 実用的な予算(b<=17)ではr=−2は放置(C5「−2は放置可」と一致)。
  // ただしb>=18の単セルDPはito_hogushiで2.0→1.5へ改善できてしまう(C5は
  // 「複数マスへ予算を配る中で−2の優先度は低い」という機会費用の話であり、
  // 単セルを孤立させて予算を無制限に与えれば改善余地はある、という整理になる。
  it('r=−2: 実用的な予算(b<=17)では打ち止め', () => {
    const dp = makeDp();
    for (const b of [0, 5, 10, 17]) {
      expect(adjustLookup(dp, -2, b, false).firstOp).toBeNull();
    }
  });

  it('r=−2: b>=18では単セルDP上はito_hogushiが改善する(C5「放置可」の機会費用前提からの乖離を記録)', () => {
    const dp = makeDp();
    expect(adjustLookup(dp, -2, 18, false).firstOp).toBe('ito_hogushi');
    expect(adjustLookup(dp, -2, 18, false).expErr).toBeCloseTo(1.5, 9);
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
  // r=7・b=7: 実コスト7(=5+upkeep2)のnuuのみ実行可(かげん以上は実コスト>=11で不可)。
  // budgetLeft=0なので後続はcellErrorScoreそのもの(=|r'|が4以下ならその値)。
  // nuuのダメージ(弱・倍率1・補正1): 基礎値12〜18 → d0=[6,7,7,8,8,9,9]。
  // r=7>0なので会心判定あり。会心後は2*d0が常に7以上のため必ず頭打ちでr'=0。
  // 非会心はr'=7-d0=[1,0,0,-1,-1,-2,-2] → 0になるのはbv=13,14の2/7のみ。
  // pZero = p(会心, 常に0) + (2/7)(1-p)(非会心でd0=7が出る2/7)。
  it('r=7・b=7(ぬうのみ) → pZero = p + (2/7)(1-p)', () => {
    const dp = makeDp();
    const needleCritRate = 0.043; // miracle★3
    const p = needleCritRate + 0.01 /* kotsuBonus */ + 0.001; /* passiveEffective(aim=falseなのでaimMultiplier適用なし) */
    const expectedPZero = p + (2 / 7) * (1 - p);

    const entry = adjustLookup(dp, 7, 7, false);
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

    // 実測: perCell=[7,13](conc全量を消費)。
    expect(perCell).toEqual([7, 13]);
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
