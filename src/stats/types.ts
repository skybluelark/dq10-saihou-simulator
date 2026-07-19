// ソルバー基盤の型定義 (候補列挙・1手の結果分布・仕上げテーブル・静的評価)
// src/stats は純TS。core からのみ import する(依存方向: ui/data/stats → core)。

import type { Action, Engine, EngineData, Power, SimulatorConfig, Star } from '../core';
import type { AdjustDp } from './adjust-dp';

/** 候補行動(列挙結果) */
export interface Candidate {
  action: Action;
  skillId: string | null; // finish は null
  cost: number;           // 実効コスト(finish=0)
  /** 対象マス(存在するマスのみ・倍率つき)。対象を取らない候補(support/finish/みだれ)は空配列 */
  targetCells: { r: number; c: number; multiplier: number }[];
}

/** 1マスの結果分布: 行動後の残り数値 → 確率(同値はマージ済み、確率合計=1) */
export type CellPmf = { remaining: number; prob: number }[];

/** 行動の結果分布(対象マスごと。マス間は独立) */
export interface ActionDistribution {
  cells: { r: number; c: number; pmf: CellPmf }[];
}

// ---- ソルバー: マス別仕上げテーブル・静的評価 (モジュール3/4) ----

/** ソルバーの調整パラメータ(既定値は DEFAULT_SOLVER_PARAMS)。 */
export interface SolverParams {
  fineLimit: number;       // 仕上げDPで扱う残り値上限(既定24)
  fineTarget: number;      // 削り工程の目標残り値(既定12)
  dpDepth: number;         // 仕上げDPの手数(既定2)
  scheduleHorizon: number; // パワースケジュール平均の先読みターン数(既定6)
  unknownCoeff: number;    // 「？」の期待係数(既定1.2)
  sigmoidScale: number;    // マージンのシグモイド尺度 s0(既定3)
  concPenalty: number;     // 集中力不足ペナルティ λ(既定0.01)
  workEfficiencyBase: number; // パワー係数1.0時の「集中力1あたりの期待削り量」(既定8)。
                              // みだれ・ライン系等の高効率特技を前提とした達成可能効率で、
                              // 削り工程(r > fineLimit)の所要集中力 = 残り作業量 ÷ (この値×係数平均)。
                              // 終盤の無駄打ち分を織り込んだ割引済みの値をM④で校正する
  rMin: number;            // DPドメイン下限(既定-30)
  rMax: number;            // DPドメイン上限(既定+30)
}

export const DEFAULT_SOLVER_PARAMS: SolverParams = {
  fineLimit: 24,
  fineTarget: 12,
  dpDepth: 2,
  scheduleHorizon: 6,
  unknownCoeff: 1.2,
  sigmoidScale: 3,
  concPenalty: 0.01,
  workEfficiencyBase: 8,
  rMin: -30,
  rMax: 30,
};

/** 仕上げテーブルの1エントリ: 残り値 r から到達できる期待値。 */
export interface FinishEntry {
  expErr: number; // 期待誤差評価値
  actions: number; // 期待手数
  conc: number; // 期待所要集中力
}

export interface SolverContext {
  engine: Engine;
  data: EngineData;
  config: SimulatorConfig;
  params: SolverParams;
  /** 事前計算済み仕上げテーブル。キー = `${correction}|${muga}`(correction∈{1,2}, muga∈{0,1})。 */
  tables: Map<string, FinishEntry[]>; // index = r - params.rMin
  /** 調整厳密DP(弱パワー固定後の最終調整。finishing.ts の createSolverContext で構築。policy.ts §10.4で使用)。
   *  目的関数=expErr(期待誤差最小化)。既定の期待値ベーススコアリングに使う。 */
  adjustDp: AdjustDp;
  /** 調整厳密DP・目的関数=pZero(誤差0率最大化)。policy.ts §10.8/v3a の★3確率合成スコアで使用。 */
  adjustDpPZero: AdjustDp;
  /** 調整厳密DP・目的関数=pLe1(誤差1以内率最大化)。policy.ts §10.8/v3a の★3確率合成スコアで使用。 */
  adjustDpPLe1: AdjustDp;
}

/** スコア付き候補(1手グリーディ選択の出力単位)。 */
export interface ScoredCandidate {
  candidate: Candidate;
  index: number;       // 列挙順(タイブレーク用)
  score: number;       // E[V](大きいほど良い)
  expTotalErr: number; // 期待誤差評価値合計
  expConcNeed: number; // 仕上げ完了までの推定所要集中力(行動コスト込み)
}

// ---- エキスパートポリシーv1 (トップ勢の判断基準のルールベース実装。SOLVER_POLICY.md) ----

/** 盤面の進行局面。carve=削り、approach=パワー→レンジ対応、adjust=最終調整。 */
export type Phase = 'carve' | 'approach' | 'adjust';

/** エキスパートポリシーの調整パラメータ(既定値は DEFAULT_POLICY_PARAMS)。 */
export interface PolicyParams {
  carveMin: number;    // 削り対象の残り値下限(既定28)。これ以上のマスがあれば carve
  approachMin: number; // アプローチ対象の下限(既定14)。carveMin未満でこれ以上があれば approach
  overshootFloor: number;      // 非会心最大ダメージで残りがこれ未満になる縫いは禁止(既定-4。E2)
  regenOvershootFloor: number; // 再生布の許容下限(既定-16。carve中は regenCarveFloor)
  regenCarveFloor: number;     // 既定-34(C1。§10.19⑤: 序盤削りの残4マスへの普通みだれ最悪-32を再生回収前提で許容)
  midareStopLoss: number; // みだれ許可条件: 「2倍打の最大値が当たっても残りがこれ以上」または carve 中
                            // (既定-16=ほぐし1回で戻せる範囲。C1/E2)
  zeroBonusTier: number;  // PMFに誤差0(確率≥1/7)を含む縫いへのティア加点(既定0.5。A1)
  shitsukeBigCellMin: number; // しつけ→最強3倍の一般化(§10.16確認済み)の対象下限(既定200)。
                               // 現行の「massCount===4限定」は誤りで、マス数ではなく巨大マス
                               // (概ね200以上)の存在が条件
  // ---- 再生布の再抽選ステアリング (§10.6/§5) ----
  regenPushLo: number;     // 押し出し後の残数値の下限(既定-17)。回復+12〜16で誤差圏に戻る設計
  regenPushHi: number;     // 同上限(既定-8)
  regenPushShallowHi: number; // 浅押しまで含めた上限(既定-4。§10.18/v3c)。(regenPushHi, regenPushShallowHi]
                               // に一部出目が掛かる押し出しはティア+0.5(浅い=回収後に再処理が要る/
                               // 対象化に失敗し得るため弱い)。全出目が[regenPushLo, regenPushHi]内なら
                               // 加点なし(従来ティア)。
  regenSteerWindow: number; // 押し出し・保護が意味を持つ「次の再生までのターン数」上限(既定2。
                            // 押してから回収までの空白ターンを最小化する — 烈風#31は2ターン前に押した)
  // ---- 再生布の回復影響スコアリング (§10.10/v3b。regenImpactDelta) ----
  regenImpactBad: number;  // 実害(仕上げ帯5/7/8/9が回復対象)のtier加点(既定+1。悪化)
  regenImpactGood: number; // 利得(悪い黄色値の再抽選・保険オーバーの回収)のtier加点(既定-0.5。改善)
  // ---- 詰み盤面の宝くじモード (§10.13/v3c) ----
  lotteryThreshold: number; // adjustフェーズで非finish許可候補のpStar3最大値がこれ未満なら
                             // 「安全手が存在せず以後はP(★3)のみ最大化する宝くじ工程」と判定する
                             // (既定0.15。光4#30〜34実例=即かげん約5.4%に対し宝くじ設計はP(★3)≈50%超)
  seishinCarveTolerance: number; // 最強ロック判定の許容不足量(既定30≈効率の悪い手1回分の削り量。
                                  // §10.19(b): 不足がこの程度なら統一7消費より安い)
  // ---- 削りフェーズの集中効率化 (§10.19/v3d) ----
  carveVarianceAverse: boolean; // §10.19回答(a)リスク予算: 成功見込みが高い基準設定(奇跡★3等)では
                                // 削り中の分散を回避する(既定true。銅針等の低見込み設定でfalse運用)
  midareReserveCellMax: number; // §10.19回答(a)-2: みだれ格下げターンの最強単発(3倍)はこの値以上の
                                // 大マスにのみ加点する(それ未満の中小マスは以後のみだれ受け持ち予約)。既定120
}

export const DEFAULT_POLICY_PARAMS: PolicyParams = {
  carveMin: 28,
  approachMin: 14,
  overshootFloor: -4,
  regenOvershootFloor: -16,
  regenCarveFloor: -34,
  midareStopLoss: -16,
  zeroBonusTier: 0.5,
  shitsukeBigCellMin: 200,
  regenPushLo: -17,
  regenPushHi: -8,
  regenPushShallowHi: -4,
  regenSteerWindow: 2,
  regenImpactBad: 1,
  regenImpactGood: -0.5,
  lotteryThreshold: 0.15,
  seishinCarveTolerance: 30,
  carveVarianceAverse: true,
  midareReserveCellMax: 120,
};

/** 盤面分析結果(局面判定・マス分類)。 */
export interface BoardAnalysis {
  phase: Phase;
  bigCount: number;  // 残り ≥ carveMin
  midCount: number;  // approachMin ≤ 残り < carveMin
  fineCount: number; // 3 ≤ 残り < approachMin(誤差3以上は放置しない: E3)
  overCount: number; // 残り ≤ -3(要ほぐし)
  weakLocked: boolean; // 弱パワーで固定中(着地済み)
}

/** ティア付き候補(エキスパートポリシーの出力単位)。tier昇順が優先度高。 */
export interface ExpertChoice {
  scored: ScoredCandidate;
  tier: number;
}

// ---- モンテカルロ・ロールアウト / anytime集計 / 公称プラン / solve統括 (モジュール6〜9) ----

/** 候補ごとのロールアウト集計(anytime合算可能)。 */
export interface CandidateStats {
  n: number;
  wins: number;
  sumErr: number;
  sumConc: number;
}

/** ロールアウト集計つき候補(racing対象)。 */
export interface RankedCandidate {
  scored: ScoredCandidate; // 静的スコア(Stage A)
  stats: CandidateStats;
  rate: number; // ★3率点推定(n=0なら0)
  ci: { lo: number; hi: number }; // Wilson 95%
  eliminated: boolean; // racingで打ち切られたか
}

export interface SolveOptions {
  timeBudgetMs?: number; // 既定1000。maxRollouts と併用可(先に達した方で停止)
  maxRollouts?: number;  // 総ロールアウト数上限(テスト・再現用)。既定 Infinity
  topK?: number;         // ロールアウト対象の候補数(既定8)
  minSamples?: number;   // racing開始前の候補あたり最低試行数(既定30)
  batchSize?: number;    // 1ラウンドの候補あたり追加試行数(既定25)
  baseSeed?: number;     // 探索シード(既定 0x5EED)
  prior?: SolveResult;   // 前回結果(stateKey一致時に合算)
}

export interface SolveResult {
  stateKey: string;
  ranked: RankedCandidate[]; // 推奨順ソート済み
  totalRollouts: number;
  elapsedMs: number;
  certain: boolean; // finishで★3確定のため探索省略した場合 true
}

/** 公称プランの1手。 */
export interface PlanStep {
  turn: number;         // 実行ターン番号(1始まり)
  power: Power;          // そのターンの実効パワー
  action: Action;
  skillId: string | null; // finish は null
  concAfter: number;      // 実行後の残り集中力
  cells: { r: number; c: number; remaining: number }[]; // 実行後の全マス残り
}

export interface NominalPlan {
  steps: PlanStep[];
  star: Star; // 最終判定
  totalError: number;
  reachedFinish: boolean; // 上限内に finish へ到達したか
}

// ---- 調整厳密DP (SOLVER_POLICY.md §10.4 B2: 弱パワー固定後の最終調整は厳密計算の対象) ----

/** 調整DPの1エントリ(数字r×予算b×しつけ有無の最適値)。 */
export interface AdjustEntry {
  expErr: number; // 期待最終誤差評価値
  pZero: number; // P(最終誤差0)
  pLe1: number; // P(最終誤差≤1)
  firstOp: string | null; // 最適初手の特技id(null=打ち止めが最適)
}

/** 調整厳密DPの調整パラメータ(既定値は DEFAULT_ADJUST_DP_PARAMS)。 */
export interface AdjustDpParams {
  rMin: number; // DPドメイン下限(既定-30)
  rMax: number; // DPドメイン上限(既定+30)
  budgetMax: number; // DPドメインの集中力上限(既定60)
  lockUpkeep: number; // 1手あたりのロック維持償却コスト(既定3.5 = 精神統一7÷純増2手。
                      // 統一は「残り1手」を「3手」に増やすので純増は2手分(§10.8②。
                      // 2026-07-15エキスパート回答による校正。0.5刻み対応)
}

export const DEFAULT_ADJUST_DP_PARAMS: AdjustDpParams = {
  rMin: -30,
  rMax: 30,
  budgetMax: 60,
  lockUpkeep: 3.5,
};
