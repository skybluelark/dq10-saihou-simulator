// ソルバー基盤の型定義 (候補列挙・1手の結果分布・仕上げテーブル・静的評価)
// src/stats は純TS。core からのみ import する(依存方向: ui/data/stats → core)。

import type { Action, Engine, EngineData, Power, SimulatorConfig, Star } from '../core';

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
}

/** スコア付き候補(1手グリーディ選択の出力単位)。 */
export interface ScoredCandidate {
  candidate: Candidate;
  index: number;       // 列挙順(タイブレーク用)
  score: number;       // E[V](大きいほど良い)
  expTotalErr: number; // 期待誤差評価値合計
  expConcNeed: number; // 仕上げ完了までの推定所要集中力(行動コスト込み)
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
