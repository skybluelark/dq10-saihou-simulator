// 布グリッド (F1): rows×cols 描画・残り数値・状態色・しつけ/発光/選択プレビュー・
// 誤差評価値(常時表示)・凡例。布タイプ別のグリッド背景色・ダメージ/回復バルーン表示。

import type { GameState } from '../core';
import type { Balloon } from './helpers';
import { CLOTH_LABELS } from './format';
import styles from './App.module.css';

interface ClothGridProps {
  game: GameState;
  yellowRange: number; // 黄色ゲージ幅(±4)
  anchor: { r: number; c: number } | null;
  targets: { r: number; c: number }[];
  selectingTarget: boolean; // 対象あり特技を選択中か
  totalError: number; // 現在の誤差評価値(ゲージ外9換算)
  star3Line: number;
  balloons: Balloon[]; // ダメージ/回復の一時表示
  hissatsuFx: number | null; // 必殺チャージの一時演出キー(null = 非表示)
  onCellClick: (r: number, c: number) => void;
}

const CLOTH_BG_CLASS: Record<string, string> = {
  normal: styles.clothBgNormal,
  regen: styles.clothBgRegen,
  rainbow: styles.clothBgRainbow,
  light: styles.clothBgLight,
};

const BALLOON_CLASS: Record<Balloon['kind'], string> = {
  damage: styles.balloonDamage,
  crit: styles.balloonCrit,
  heal: styles.balloonHeal,
};

export function ClothGrid({
  game,
  yellowRange,
  anchor,
  targets,
  selectingTarget,
  totalError,
  star3Line,
  balloons,
  hissatsuFx,
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

  const clothBgClass = CLOTH_BG_CLASS[game.clothType] ?? '';

  return (
    <div className={styles.gridWrap}>
      <div
        className={`${styles.grid} ${clothBgClass}`}
        style={{ gridTemplateColumns: `repeat(${game.cols}, var(--cell-w, 96px))` }}
      >
        {rows.map((r) =>
          cols.map((c) => {
            const cell = game.cells.find((x) => x.r === r && x.c === c);
            if (!cell) {
              // 空きマス(頭・ぬいぐるみの欠け位置)もアンカーとしてタップできる(SPEC §3.1)。
              // 対象0件となるタップの無効化は App 側(handleCellClick)で行う。
              // 対象範囲の青枠は空きマスにも表示する(ダメージが入るのは存在するマスのみ)。
              const isEmptyAnchor = anchor?.r === r && anchor?.c === c;
              const isEmptyTarget = targets.some((t) => t.r === r && t.c === c);
              const emptyClasses = [
                styles.cellEmpty,
                isEmptyTarget ? styles.cellTarget : '',
                isEmptyAnchor ? styles.cellAnchor : '',
                selectingTarget && !game.finished ? styles.cellClickable : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  className={emptyClasses}
                  onClick={() => onCellClick(r, c)}
                  aria-label={`空きマス (${r},${c})`}
                />
              );
            }
            const remaining = cell.base - cell.cumulative;
            const isGlow = game.glowCell?.r === r && game.glowCell?.c === c;
            const isAnchor = anchor?.r === r && anchor?.c === c;
            const isTarget = targets.some((t) => t.r === r && t.c === c);
            const cellBalloons = balloons.filter((b) => b.r === r && b.c === c);
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
                {cellBalloons.map((b) => (
                  <span key={b.id} className={`${styles.balloon} ${BALLOON_CLASS[b.kind]}`}>
                    {b.text}
                  </span>
                ))}
              </button>
            );
          }),
        )}
        {hissatsuFx !== null && (
          // 必殺チャージの一時演出(グリッドコンテナ基準の absolute オーバーレイ)
          <div key={hissatsuFx} className={styles.hissatsuOverlay} aria-hidden="true">
            必殺チャージ!
          </div>
        )}
      </div>

      <div className={styles.clothTypeNote}>
        布タイプ: <strong>{CLOTH_LABELS[game.clothType] ?? game.clothType}</strong>
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
