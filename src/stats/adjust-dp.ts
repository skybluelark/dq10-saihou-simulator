// 調整厳密DP (SOLVER_POLICY.md §10.4 B2)
//
// 弱パワー固定(精神統一で着地後)の最終調整フェーズについて、「マスの残り数値 r × そのマスに
// 使える集中力 b(× しつけがけ有無 s)」から最適特技列と期待誤差を厳密に計算する。
// トップ勢が暗記している定石(E1「6.終盤定石」)は本DPの近似解にあたる — 一致するかどうかは
// テスト(tests/unit/solver-adjust-dp.test.ts)で検証する。
//
// 状態: r∈[rMin,rMax](域外クランプ) × b∈[0,budgetMax] × s∈{0,1}(しつけ補正の有無)。
// 値 = 期待最終誤差評価値の最小。予算 b は各手で厳密に減るため、b昇順の1パスで
// 厳密に計算できる(反復不要。V(r,b,s) = min(V(r,b-1,s), 各特技候補, 打ち止め))。
// 「打ち止め」は b=0 の値(=cellErrorScore(r))が V(r,b-1,s) の連鎖を通じて常に候補に
// 含まれるため、b>=1 側で改めて比較する必要はない(Vはbについて単調非増加)。
//
// 内部の予算格子は 0.5集中刻み(half単位): lockUpkeep=3.5(精神統一7÷純増2手。§10.8②)の
// ような半端な償却を正確に扱うため、配列インデックスは bh = 集中×2 で持つ。
// 外部API(adjustLookup / AdjustDpParams)は従来どおり集中単位のまま。

import { sewDamage, hogushiDamage, computeCritRate, cellErrorScore } from '../core';
import type { EngineData, SimulatorConfig, SkillDef } from '../core';
import { DEFAULT_ADJUST_DP_PARAMS } from './types';
import type { AdjustDpParams, AdjustEntry } from './types';

/**
 * DPの目的関数(§10.10 A1)。目標が誤差0か誤差1以内かで最適手が分岐する
 * (例: r=7はpZeroならねらい、pLe1ならぬう→ほぐし連鎖)ため、目的を選べるようにする。
 * 既定は従来どおり expErr(期待誤差評価値の最小化)。
 */
export type AdjustObjective = 'expErr' | 'pZero' | 'pLe1';

/** 調整DPテーブル本体(build結果)。 */
export interface AdjustDp {
  params: AdjustDpParams;
  objective: AdjustObjective;
  size: number; // rMax - rMin + 1
  /** entries[しつけ有無(0|1)][b*size + (r-rMin)] */
  entries: [AdjustEntry[], AdjustEntry[]];
}

type EvalResult = { expE: number; pZero: number; pLe1: number };

/** 弱パワー調整DPテーブルを値反復(実際はb昇順1パス)で構築する。 */
export function buildAdjustDp(
  data: EngineData,
  config: SimulatorConfig,
  params: AdjustDpParams = DEFAULT_ADJUST_DP_PARAMS,
  objective: AdjustObjective = 'expErr',
): AdjustDp {
  const { rMin, rMax, budgetMax, lockUpkeep } = params;
  const size = rMax - rMin + 1;
  const gauge = data.params.gauge;

  const needle = data.needles.needles.find((n) => n.id === config.needle.type);
  if (!needle) throw new Error(`不明な針: ${config.needle.type}`);
  const needleCritRate = needle.critRate[config.needle.stars];

  // 弱調整で使う単マス縫い(ぬう・かげん・半かげん・2倍・3倍・ねらい)。
  // finishing.ts の sewOps 抽出と同じ条件(kind=sew, target=single, learnLv<=config.level)で
  // data.skills.skills から引く(コストをハードコードしない)。
  const sewOps = data.skills.skills.filter(
    (s) => s.kind === 'sew' && s.target === 'single' && (s.learnLv === undefined || s.learnLv <= config.level),
  );
  const hogushiOp = data.skills.skills.find(
    (s) => s.kind === 'recover' && (s.learnLv === undefined || s.learnLv <= config.level),
  );
  const shitsukeOp = data.skills.skills.find(
    (s) => s.effect === 'cellCorrection' && (s.learnLv === undefined || s.learnLv <= config.level),
  );

  const critRateCache = new Map<string, number>();
  const critRateFor = (aim: boolean): number => {
    const key = aim ? 'aim' : 'normal';
    const cached = critRateCache.get(key);
    if (cached !== undefined) return cached;
    const rate = computeCritRate(data.params, {
      needleCritRate,
      kotsu: config.kotsu,
      passiveCritUp: config.passives.critUp,
      aim,
      rainbowCritTurn: false,
      lightGlowCell: false,
      mugaActive: false,
      shiftCrit: false,
    });
    critRateCache.set(key, rate);
    return rate;
  };

  const clampIdx = (r: number): number => Math.max(rMin, Math.min(rMax, r)) - rMin;

  // 目的別の改善判定。expErr は従来判定(厳密<)を維持。確率最大化系は浮動小数の
  // 加算順差で同値が僅かにぶれるため ε 比較とし、同値なら expErr を副次基準にする
  // (「同じ誤差1以内率なら期待誤差が小さい方」= 打ち止め継承を不当に上書きしない)。
  const EPS = 1e-9;
  const improves = (expE: number, pZero: number, pLe1: number, cur: AdjustEntry): boolean => {
    if (objective === 'expErr') return expE < cur.expErr;
    const primary = objective === 'pZero' ? pZero : pLe1;
    const curPrimary = objective === 'pZero' ? cur.pZero : cur.pLe1;
    if (primary > curPrimary + EPS) return true;
    return Math.abs(primary - curPrimary) <= EPS && expE < cur.expErr - EPS;
  };

  // 予算格子はhalf単位(bh = 集中×2)。詳細はファイル冒頭コメント参照。
  const bhMax = budgetMax * 2;
  const toHalf = (c: number): number => Math.round(c * 2);

  const entries: [AdjustEntry[], AdjustEntry[]] = [
    new Array(size * (bhMax + 1)),
    new Array(size * (bhMax + 1)),
  ];
  const at = (s: 0 | 1, rIdx: number, bh: number): AdjustEntry => entries[s][bh * size + rIdx];
  const set = (s: 0 | 1, rIdx: number, bh: number, e: AdjustEntry): void => {
    entries[s][bh * size + rIdx] = e;
  };

  // b=0: 全特技のコストは正なので打てる手がない(=「そのまま」のみ)。
  for (let rIdx = 0; rIdx < size; rIdx++) {
    const r = rMin + rIdx;
    const e: AdjustEntry = {
      expErr: cellErrorScore(r, gauge.yellowRange, gauge.penaltyError),
      pZero: r === 0 ? 1 : 0,
      pLe1: Math.abs(r) <= 1 ? 1 : 0,
      firstOp: null,
    };
    set(0, rIdx, 0, e);
    set(1, rIdx, 0, e);
  }

  /**
   * 縫い1回の実行結果を s'=0 側の既計算テーブルへ加重集計する。
   * 会心は残り>0のマスのみ判定し、2倍後は残りちょうどで頭打ち。非会心は頭打ちなし(縫いすぎ許容)。
   */
  function evalSew(skill: SkillDef, r: number, correction: 1 | 2, bhLeft: number): EvalResult {
    const mult = skill.multiplier ?? 1;
    const aim = skill.aim === true;
    const p = critRateFor(aim);
    let expE = 0;
    let pZero = 0;
    let pLe1 = 0;
    for (let bv = 12; bv <= 18; bv++) {
      const d0 = sewDamage(bv, mult, 'weak', correction);
      if (r > 0) {
        const dCrit = Math.min(d0 * 2, r);
        const entryC = at(0, clampIdx(r - dCrit), bhLeft);
        const wC = (1 / 7) * p;
        expE += wC * entryC.expErr;
        pZero += wC * entryC.pZero;
        pLe1 += wC * entryC.pLe1;

        const entryN = at(0, clampIdx(r - d0), bhLeft);
        const wN = (1 / 7) * (1 - p);
        expE += wN * entryN.expErr;
        pZero += wN * entryN.pZero;
        pLe1 += wN * entryN.pLe1;
      } else {
        const entryN = at(0, clampIdx(r - d0), bhLeft);
        const w = 1 / 7;
        expE += w * entryN.expErr;
        pZero += w * entryN.pZero;
        pLe1 += w * entryN.pLe1;
      }
    }
    return { expE, pZero, pLe1 };
  }

  /** 糸ほぐし1回(出目6〜9・会心なし・初期状態頭打ちはfinishing.tsと同じく無視)。 */
  function evalHogushi(r: number, correction: 1 | 2, bhLeft: number): EvalResult {
    let expE = 0;
    let pZero = 0;
    let pLe1 = 0;
    for (let roll = 6; roll <= 9; roll++) {
      const d = hogushiDamage(-roll, 'weak', correction); // 負値(回復)
      const entry = at(0, clampIdx(r - d), bhLeft);
      const w = 1 / 4;
      expE += w * entry.expErr;
      pZero += w * entry.pZero;
      pLe1 += w * entry.pLe1;
    }
    return { expE, pZero, pLe1 };
  }

  for (let bh = 1; bh <= bhMax; bh++) {
    for (const s of [0, 1] as const) {
      const correction: 1 | 2 = s === 1 ? 2 : 1;
      for (let rIdx = 0; rIdx < size; rIdx++) {
        const r = rMin + rIdx;

        // 予算単調性(B2): まず「この0.5集中を使わない」= V(r,bh-1,s) を基準候補にする。
        // これにより bh が増えても expErr は非増加になり、tie(改善なし)のときは
        // firstOp/pZero/pLe1 も bh-1 の解をそのまま継承する。
        let best: AdjustEntry = at(s, rIdx, bh - 1);

        for (const skill of sewOps) {
          const realCostH = toHalf((skill.cost ?? 0) + lockUpkeep);
          if (realCostH > bh) continue;
          const { expE, pZero, pLe1 } = evalSew(skill, r, correction, bh - realCostH);
          if (improves(expE, pZero, pLe1, best)) {
            best = { expErr: expE, pZero, pLe1, firstOp: skill.id };
          }
        }

        if (hogushiOp) {
          const realCostH = toHalf((hogushiOp.cost ?? 0) + lockUpkeep);
          if (realCostH <= bh) {
            const { expE, pZero, pLe1 } = evalHogushi(r, correction, bh - realCostH);
            if (improves(expE, pZero, pLe1, best)) {
              best = { expErr: expE, pZero, pLe1, firstOp: hogushiOp.id };
            }
          }
        }

        // しつけがけ: s=0でのみ許可(s=1中の再しつけは無意味なので候補から除く)。r不変・s'=1。
        if (shitsukeOp && s === 0) {
          const realCostH = toHalf((shitsukeOp.cost ?? 0) + lockUpkeep);
          if (realCostH <= bh) {
            const entry = at(1, rIdx, bh - realCostH);
            if (improves(entry.expErr, entry.pZero, entry.pLe1, best)) {
              best = { expErr: entry.expErr, pZero: entry.pZero, pLe1: entry.pLe1, firstOp: shitsukeOp.id };
            }
          }
        }

        set(s, rIdx, bh, best);
      }
    }
  }

  return { params, objective, size, entries };
}

/** 調整DPテーブルの参照(rMin/rMax・0〜budgetMax の域外はドメイン端にクランプ)。budgetは集中単位(0.5刻み対応)。 */
export function adjustLookup(dp: AdjustDp, r: number, budget: number, shitsuke: boolean): AdjustEntry {
  const { rMin, rMax, budgetMax } = dp.params;
  const rClamped = Math.max(rMin, Math.min(rMax, Math.round(r)));
  const bClamped = Math.max(0, Math.min(budgetMax * 2, Math.round(budget * 2)));
  const s: 0 | 1 = shitsuke ? 1 : 0;
  return dp.entries[s][bClamped * dp.size + (rClamped - rMin)];
}

/**
 * 「そのマスに使える集中力」の割当(B2)。全マス b_i=0 から開始し、δ=1 集中ずつ
 * expErr の限界改善が最大のマスへ割り当てる貪欲法(各 f_i は単調だが同時最適化ではないため
 * 厳密解ではない実用近似)。conc を使い切るか、どのマスも改善しなくなったら停止する。
 */
export function allocateAdjustBudget(
  dp: AdjustDp,
  cells: { r: number; shitsuke: boolean }[],
  conc: number,
): { perCell: number[]; totalExpErr: number } {
  const perCell: number[] = new Array(cells.length).fill(0);
  let remaining = Math.max(0, Math.floor(conc));
  const valueAt = (i: number, b: number): number => adjustLookup(dp, cells[i].r, b, cells[i].shitsuke).expErr;

  while (remaining > 0) {
    // 1集中先(δ=1)の限界改善が最大のマスを優先する。
    let bestIdx = -1;
    let bestGain = 0;
    for (let i = 0; i < cells.length; i++) {
      const gain = valueAt(i, perCell[i]) - valueAt(i, perCell[i] + 1);
      if (gain > bestGain) {
        bestGain = gain;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      // フォールバック: このDPの各特技はコスト5〜18の塊で効くため、多くの区間で
      // 「あと1集中」では expErr が動かない(次の特技の閾値に届くまで平坦)。
      // δ=1の限界改善だけで停止判定すると、どのマスも閾値未満のときに貪欲法が
      // 即座に止まってしまう(実際に conc=20・2マスの検証中に確認)。
      // そこで1手先の改善が全マス0のときに限り、上限予算(budgetMax)まで使い切った
      // 場合の到達可能改善量(このマスの伸びしろ)が最大のマスへ1集中を先行投資する。
      let bestPotential = 0;
      for (let i = 0; i < cells.length; i++) {
        const potential = valueAt(i, perCell[i]) - valueAt(i, dp.params.budgetMax);
        if (potential > bestPotential) {
          bestPotential = potential;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break; // どのマスにも改善余地がない
    }
    perCell[bestIdx] += 1;
    remaining -= 1;
  }

  let totalExpErr = 0;
  for (let i = 0; i < cells.length; i++) {
    totalExpErr += valueAt(i, perCell[i]);
  }
  return { perCell, totalExpErr };
}
