// 最善手推奨パネル(検証モード限定): 実装済みソルバーを Web Worker 上で実行し、
// ★3到達確率が高い候補と公称プラン(目安)を表示する。プレイ操作(rngRef)には触れない。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, EngineData, GameState, SimulatorConfig } from '../core';
import type { NominalPlan, PlanStep, RankedCandidate, SolveResult } from '../stats';
import type { SolveRequest, WorkerResponse } from '../stats/worker';
import { POWER_LABELS, STAR_LABELS } from './format';
import styles from './App.module.css';

interface SolverPanelProps {
  engineData: EngineData;
  config: SimulatorConfig;
  game: GameState; // beginTurn済みの現在盤面
  skillName: (id: string) => string; // 特技名の解決(App の既存関数)
}

type Status = 'idle' | 'running' | 'done' | 'error';

interface ResultData {
  result: SolveResult;
  plan: NominalPlan | null;
}

/** 特技名+対象(sew なら座標)の表示文字列。 */
function describeAction(action: Action, skillId: string | null, skillName: (id: string) => string): string {
  const name = skillId === null ? 'しあげる' : skillName(skillId);
  return action.type === 'sew' ? `${name} (${action.anchor.r},${action.anchor.c})` : name;
}

export function SolverPanel({ engineData, config, game, skillName }: SolverPanelProps) {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const latestRequestIdRef = useRef(-1); // 有効な最新リクエストID(-1=応答を受け付けない)

  const [status, setStatus] = useState<Status>('idle');
  const [data, setData] = useState<ResultData | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 盤面が変わったら表示をクリアして idle に戻す(実行中の古い応答は無視させる)
  useEffect(() => {
    latestRequestIdRef.current = -1;
    setStatus('idle');
    setData(null);
    setErrorMsg(null);
  }, [game]);

  // アンマウント時に Worker を終了
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const ensureWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      const worker = new Worker(new URL('../stats/worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        if (msg.requestId !== latestRequestIdRef.current) return; // 古い盤面への応答は無視
        if (msg.type === 'result') {
          setData({ result: msg.result, plan: msg.plan });
          setStatus('done');
        } else {
          setErrorMsg(msg.message);
          setStatus('error');
        }
      };
      workerRef.current = worker;
    }
    return workerRef.current;
  }, []);

  const runSolve = useCallback(() => {
    const worker = ensureWorker();
    const requestId = ++requestIdRef.current;
    latestRequestIdRef.current = requestId;
    setStatus('running');
    setErrorMsg(null);
    const req: SolveRequest = { type: 'solve', requestId, engineData, config, state: game };
    worker.postMessage(req);
  }, [ensureWorker, engineData, config, game]);

  return (
    <section className={styles.solverPanel}>
      <h2 className={styles.sectionTitle}>最善手推奨(検証)</h2>
      <p className={styles.solverNote}>★3到達確率の最大化。出目により結果は変わります</p>

      {status === 'idle' && (
        <button type="button" className={styles.undoButton} onClick={runSolve}>
          推奨を計算
        </button>
      )}
      {status === 'running' && <div className={styles.solverRunning}>計算中…</div>}
      {status === 'error' && <div className={styles.solverError}>エラー: {errorMsg}</div>}
      {status === 'done' && data && (
        <SolverResultView data={data} skillName={skillName} onImprove={runSolve} />
      )}
    </section>
  );
}

function SolverResultView({
  data,
  skillName,
  onImprove,
}: {
  data: ResultData;
  skillName: (id: string) => string;
  onImprove: () => void;
}) {
  const { result, plan } = data;
  const top3 = result.ranked.slice(0, 3);

  return (
    <div>
      {result.certain && <div className={styles.solverCertain}>今しあげると★3確定</div>}

      <table className={styles.resultTable}>
        <thead>
          <tr>
            <th>順位</th>
            <th>候補</th>
            <th>★3率</th>
            <th>試行数</th>
          </tr>
        </thead>
        <tbody>
          {top3.map((rc: RankedCandidate, i: number) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{describeAction(rc.scored.candidate.action, rc.scored.candidate.skillId, skillName)}</td>
              <td>
                {(rc.ci.lo * 100).toFixed(1)}〜{(rc.ci.hi * 100).toFixed(1)}%
              </td>
              <td>{rc.stats.n}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.solverMeta}>
        累計試行数 {result.totalRollouts} / 経過 {result.elapsedMs}ms
      </div>

      <button type="button" className={styles.undoButton} onClick={onImprove}>
        精度を上げる
      </button>

      {plan && (
        <details className={styles.solverDetails}>
          <summary>公称プラン(目安)</summary>
          <table className={styles.resultTable}>
            <thead>
              <tr>
                <th>ターン</th>
                <th>パワー</th>
                <th>行動</th>
                <th>残り集中力</th>
              </tr>
            </thead>
            <tbody>
              {plan.steps.map((step: PlanStep) => (
                <tr key={step.turn}>
                  <td>{step.turn}</td>
                  <td>{POWER_LABELS[step.power]}</td>
                  <td>{describeAction(step.action, step.skillId, skillName)}</td>
                  <td>{step.concAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.solverMeta}>
            予想: {STAR_LABELS[plan.star]}・誤差合計 {plan.totalError}
            {!plan.reachedFinish && '(上限で打ち切り)'}
          </div>
          <p className={styles.solverNote}>順調に進んだ場合の目安(中央値決め打ち・乱数依存特技除外)</p>
        </details>
      )}
    </div>
  );
}
