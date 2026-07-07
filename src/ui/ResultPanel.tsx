// 結果表示 (F4): ★数・大成功/失敗の別・誤差評価値合計と★3ライン・
// マス別誤差内訳(ゲージ外9換算の明示。検証モード時のみ)・使用ターン数・残集中力。

import { useState } from 'react';
import { cellErrorScore } from '../core';
import type { GameParams, GameState, JudgeResult } from '../core';
import { copyReplayText } from './clipboard';
import { STAR_LABELS } from './format';
import styles from './App.module.css';

interface ResultPanelProps {
  game: GameState;
  result: JudgeResult;
  params: GameParams;
  onNewSession: () => void;
  verifyMode: boolean; // 検証モード時: 1手戻すボタンとマス別誤差内訳を表示(SPEC §4.3)
  onUndo: () => void;
  onBuildReplayText: () => string | null;
}

export function ResultPanel({
  game,
  result,
  params,
  onNewSession,
  verifyMode,
  onUndo,
  onBuildReplayText,
}: ResultPanelProps) {
  const yellow = params.gauge.yellowRange;
  const penalty = params.gauge.penaltyError;
  const star3Line = params.evaluation[String(game.massCount)].star3;
  const isGreat = result.star === 'star3';
  const isFail = result.star === 'fail';

  const [copied, setCopied] = useState(false);
  const handleCopyReplay = () => {
    const text = onBuildReplayText();
    if (!text) return;
    copyReplayText(text, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section className={styles.resultCard}>
      <h2 className={styles.resultTitle}>できのよさ</h2>
      <div className={`${styles.resultStar} ${isFail ? styles.resultFail : ''}`}>
        {STAR_LABELS[result.star]}
        {isGreat && <span className={styles.resultGreat}>大成功!</span>}
        {isFail && <span className={styles.resultFailNote}>失敗…</span>}
      </div>
      <div className={styles.resultSummary}>
        誤差評価値合計 <strong>{result.totalError}</strong>(★3ライン: ≤{star3Line}) /
        使用ターン数 <strong>{game.turn}</strong> / 残集中力 <strong>{game.concentration}</strong>
      </div>
      {verifyMode && (
        <table className={styles.resultTable}>
          <thead>
            <tr>
              <th>マス</th>
              <th>残り</th>
              <th>誤差</th>
              <th>評価値</th>
            </tr>
          </thead>
          <tbody>
            {game.cells.map((cell) => {
              const remaining = cell.base - cell.cumulative;
              const err = Math.abs(remaining);
              const score = cellErrorScore(remaining, yellow, penalty);
              return (
                <tr key={`${cell.r}-${cell.c}`}>
                  <td>({cell.r},{cell.c})</td>
                  <td>{remaining}</td>
                  <td>{err}</td>
                  <td>
                    {score}
                    {score !== err && <span className={styles.penaltyNote}>(ゲージ外9換算)</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className={styles.resultActions}>
        {verifyMode && (
          <button type="button" className={styles.undoButton} onClick={onUndo}>
            1手戻す
          </button>
        )}
        <button type="button" className={styles.undoButton} onClick={handleCopyReplay}>
          {copied ? 'コピーしました' : 'リプレイをコピー'}
        </button>
        <button type="button" className={styles.newButton} onClick={onNewSession}>
          新しく始める
        </button>
      </div>
    </section>
  );
}
