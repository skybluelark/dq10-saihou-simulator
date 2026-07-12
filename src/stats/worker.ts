/// <reference lib="webworker" />
// ソルバー実行用 Web Worker(検証モード限定の推奨パネル用)。
// src/ui からのメッセージで盤面を受け取り solve/nominalPlan を実行して結果を返す。
// core と stats 内部のみに依存する(依存方向: ESLintの import/no-restricted-paths で
// src/ui・src/data への依存を禁止)。

import { Engine } from '../core';
import type { EngineData, GameState, SimulatorConfig } from '../core';
import { createSolverContext, nominalPlan, solve } from './index';
import type { NominalPlan, SolveResult, SolverContext } from './types';

export interface SolveRequest {
  type: 'solve';
  requestId: number;
  engineData: EngineData;
  config: SimulatorConfig;
  state: GameState;
  options?: { timeBudgetMs?: number };
}

export type WorkerResponse =
  | { type: 'result'; requestId: number; result: SolveResult; plan: NominalPlan | null }
  | { type: 'error'; requestId: number; message: string };

// SolverContext は構築が重い(仕上げテーブル事前計算)ためモジュール変数へキャッシュし、
// キー(config の JSON = 針・レベル等)が変わったときのみ作り直す。engineData は不変前提。
let cachedCtx: SolverContext | null = null;
let cachedCtxKey: string | null = null;

// 直近の SolveResult(anytime合算用)。盤面が変わっても常に prior として渡してよい
// (stateKey が不一致なら solve 側が無視するため)。
let lastResult: SolveResult | null = null;

function getContext(engine: Engine, engineData: EngineData, config: SimulatorConfig): SolverContext {
  const key = JSON.stringify({ config });
  if (cachedCtx && cachedCtxKey === key) return cachedCtx;
  cachedCtx = createSolverContext(engine, engineData, config);
  cachedCtxKey = key;
  return cachedCtx;
}

self.onmessage = (ev: MessageEvent<SolveRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'solve') return;
  const { requestId, engineData, config, state, options } = msg;

  try {
    const engine = new Engine(engineData);
    const ctx = getContext(engine, engineData, config);
    const result = solve(ctx, state, { ...options, prior: lastResult ?? undefined });
    lastResult = result;

    const top = result.ranked[0];
    let plan: NominalPlan | null = null;
    if (top) {
      try {
        plan = nominalPlan(ctx, state, top.scored.candidate.action);
      } catch {
        plan = null; // 公称プランの計算失敗は致命的でないため結果のみ返す
      }
    }

    const response: WorkerResponse = { type: 'result', requestId, result, plan };
    self.postMessage(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const response: WorkerResponse = { type: 'error', requestId, message };
    self.postMessage(response);
  }
};
