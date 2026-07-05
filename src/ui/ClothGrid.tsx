// 布グリッド (F1): rows×cols 描画・残り数値・状態色・しつけ/発光/選択プレビュー・
// 誤差評価値(常時表示)・凡例。

import type { GameState } from '../core';
import styles from './App.module.css';

interface ClothGridProps {
  game: GameState;
  yellowRange: number; // 黄色ゲージ幅(±4)
  anchor: { r: number; c: number } | null;
  targets: { r: number; c: number }[];
  selectingTarget: boolean; // 対象あり特技を選択中か
  totalError: number; // 現在の誤差評価値(ゲージ外9換算)
  star3Line: number;
  onCellClick: (r: number, c: number) => void;
}

export function ClothGrid({
  game,
  yellowRange,
  anchor,
  targets,
  selectingTarget,
  totalError,
  star3Line,
  onCellClick,
}: ClothGridProps) {
  const rows = Array.from({ length: game.rows }, (_, i) => i + 1);
  const cols = Array.from({ length: game.cols }, (_, i) => i + 1);

  const stateClass = (remaining: number): string => {
    if (remaining === 0) return styles.cellDone; // 緑
    if (remaining <= -(yellowRange + 1)) return styles.cellOver; // 赤
    if (Math.abs(remaining) <= yellowRange) return styles.cellYellow; // 黄
    return styles.cellNormal; // 白
  };

  return (
    <div className={styles.gridWrap}>
      <div
        className={styles.grid}
        style={{ gridTemplateColumns: `repeat(${game.cols}, 96px)` }}
      >
        {rows.map((r) =>
          cols.map((c) => {
            const cell = game.cells.find((x) => x.r === r && x.c === c);
            if (!cell) {
              return <div key={`${r}-${c}`} className={styles.cellEmpty} />;
            }
            const remaining = cell.base - cell.cumulative;
            const isGlow = game.glowCell?.r === r && game.glowCell?.c === c;
            const isAnchor = anchor?.r === r && anchor?.c === c;
            const isTarget = targets.some((t) => t.r === r && t.c === c);
            const classes = [
              styles.cell,
              stateClass(remaining),
              cell.shitsuke ? styles.cellShitsuke : '',
              isGlow ? styles.cellGlow : '',
              isTarget ? styles.cellTarget : '',
              isAnchor ? styles.cellAnchor : '',
              selectingTarget && !game.finished ? styles.cellClickable : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={`${r}-${c}`}
                type="button"
                className={classes}
                onClick={() => onCellClick(r, c)}
              >
                <span className={styles.remaining}>{remaining}</span>
                <span className={styles.baseVal}>/{cell.base}</span>
                {cell.shitsuke && <span className={styles.shitsukeTag}>しつけ</span>}
                {isGlow && <span className={styles.glowTag}>発光</span>}
              </button>
            );
          }),
        )}
      </div>

      <div className={styles.errorLine}>
        誤差評価値: <strong>{totalError}</strong>
        <span className={styles.errorNote}>(ゲージ外は9換算)</span>
        <span className={styles.star3Line}>★3ライン: ≤{star3Line}</span>
      </div>

      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <i className={`${styles.swatch} ${styles.swatchDone}`} />
          残り0
        </span>
        <span className={styles.legendItem}>
          <i className={`${styles.swatch} ${styles.swatchYellow}`} />
          黄(|残り|≤{yellowRange})
        </span>
        <span className={styles.legendItem}>
          <i className={`${styles.swatch} ${styles.swatchOver}`} />
          赤(縫いすぎ)
        </span>
        <span className={styles.legendItem}>
          <i className={`${styles.swatch} ${styles.swatchShitsuke}`} />
          しつけがけ
        </span>
        <span className={styles.legendItem}>
          <i className={`${styles.swatch} ${styles.swatchGlow}`} />
          発光
        </span>
        <span className={styles.legendItem}>
          <i className={`${styles.swatch} ${styles.swatchTarget}`} />
          対象プレビュー
        </span>
      </div>
    </div>
  );
}
