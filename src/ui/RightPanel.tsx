// 右パネル (F2/F3): ターン数・現在ぬいパワー・サイクル表示・集中力・
// 布特性の次回発動・必殺チャージ/無我バッジ。

import { isTraitTurn, rainbowMode } from '../core';
import type { GameParams, GameState, NeedleDef } from '../core';
import { CLOTH_LABELS, POWER_LABELS } from './format';
import { nextTraitTurn } from './helpers';
import styles from './App.module.css';

interface RightPanelProps {
  game: GameState;
  params: GameParams;
  needle: NeedleDef;
  levelBase: number; // Lv80基礎 207
  initialConcentration: number;
  showCyclePreview: boolean;
}

export function RightPanel({
  game,
  params,
  needle,
  levelBase,
  initialConcentration,
  showCyclePreview,
}: RightPanelProps) {
  // 進行中ターン番号(beginTurn 済みのため turn+1)。終了後は使用ターン数。
  const currentTurn = game.finished ? game.turn : game.turn + 1;
  const concMax = Math.max(initialConcentration, game.concentration);
  const openingBonus = initialConcentration - levelBase - needle.concentration;

  const traitInfo = (): string => {
    if (game.clothType === 'normal') {
      return 'なし(通常布)';
    }
    const next = nextTraitTurn(currentTurn, params);
    const now = !game.finished && isTraitTurn(currentTurn, params);
    let content: string;
    switch (game.clothType) {
      case 'regen':
        content = 'マス回復';
        break;
      case 'light':
        content = '1マス発光';
        break;
      case 'rainbow':
        content = rainbowMode(next, params) === 'half' ? '消費半減' : '会心UP(消費1.5倍)';
        break;
      default:
        content = '';
    }
    return now ? `このターン(T${next}): ${content}` : `次回 T${next}: ${content}`;
  };

  return (
    <aside className={styles.panel}>
      <div className={styles.statRow}>
        <span className={styles.statLabel}>ターン</span>
        <span className={styles.statValue}>{currentTurn}</span>
      </div>

      <div className={styles.statRow}>
        <span className={styles.statLabel}>ぬいパワー</span>
        <span className={`${styles.powerBadge} ${styles[`power_${game.currentPower}`] ?? ''}`}>
          {POWER_LABELS[game.currentPower]}
        </span>
        {game.lockPowerRemaining > 0 && (
          <span className={styles.lockNote}>精神統一固定中(残{game.lockPowerRemaining})</span>
        )}
      </div>

      <div className={styles.cycleBlock}>
        <span className={styles.statLabel}>サイクル</span>
        {showCyclePreview ? (
          <div className={styles.cycleRow}>
            {game.powerCycle.map((p, i) => (
              <span
                key={i}
                className={`${styles.cycleItem} ${i === game.cycleIndex ? styles.cycleCurrent : ''}`}
              >
                {POWER_LABELS[p]}
              </span>
            ))}
          </div>
        ) : (
          <span className={styles.cycleHidden}>(予告OFF: 現在のみ表示)</span>
        )}
      </div>

      <div className={styles.concBlock}>
        <span className={styles.statLabel}>集中力</span>
        <span className={styles.statValue}>
          {game.concentration} / {concMax}
        </span>
        <div className={styles.concBar}>
          <div
            className={styles.concBarFill}
            style={{ width: `${Math.max(0, Math.min(100, (game.concentration / concMax) * 100))}%` }}
          />
        </div>
        <span className={styles.concDetail}>
          内訳: Lv80基礎{levelBase} + 針集中度{needle.concentration}
          {openingBonus > 0 ? ` + 開幕${openingBonus}` : ''}
        </span>
      </div>

      <div className={styles.statRow}>
        <span className={styles.statLabel}>布特性</span>
        <span className={styles.traitInfo}>
          {CLOTH_LABELS[game.clothType] ?? game.clothType}: {traitInfo()}
        </span>
      </div>

      {game.hissatsuCharged && <div className={styles.chargeBadge}>必殺チャージ中</div>}
      {game.mugaActive && <div className={styles.mugaBadge}>無我の境地(会心率×2)</div>}
    </aside>
  );
}
