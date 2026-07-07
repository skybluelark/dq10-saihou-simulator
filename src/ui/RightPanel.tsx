// 状態表示パネル (F2/F3。布グリッド上部に配置: SPEC §4.3 v1.21):
// ターン数・現在ぬいパワー・サイクル表示・集中力・布特性の次回発動・
// 必殺チャージ/無我バッジ。

import { isTraitTurn, peekNextPower, rainbowMode } from '../core';
import type { GameParams, GameState, NeedleDef, Power } from '../core';
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

  const nextPower: Power = peekNextPower(game);

  // サイクルエントリ i の下線判定に使うターン(SPEC §4.3)。
  //   非現在エントリ: 次に実行されるターン = 現在ターン + ((i − 現在index + 長さ) mod 長さ)
  //     (精神統一固定中は固定残ターン−1 を後ろへずらす=サイクル停止分)
  //   現在エントリ: 固定中は残り固定期間 [現在ターン, 現在ターン+残−1] に発動ターンが
  //     含まれればそのターン(固定中にイベントターンが来るケースの予告)。非固定時は現在ターン。
  const cycleExecTurn = (i: number): number => {
    const len = game.powerCycle.length;
    if (len === 0) return currentTurn;
    const offset = (i - game.cycleIndex + len) % len;
    if (offset === 0) {
      const span = Math.max(1, game.lockPowerRemaining); // 固定中はその残り期間、非固定は当ターンのみ
      for (let k = 0; k < span; k++) {
        if (isTraitTurn(currentTurn + k, params)) return currentTurn + k;
      }
      return currentTurn; // 期間内に発動ターンなし(下線なしになる)
    }
    const lockPush = game.lockPowerRemaining > 0 ? game.lockPowerRemaining - 1 : 0;
    return currentTurn + offset + lockPush;
  };

  // 布特性の発動ターンに当たるパワーへ付す下線色クラス(通常布・終了後は付さない)。
  const traitUnderlineClass = (execTurn: number): string => {
    if (game.finished || game.clothType === 'normal') return '';
    if (!isTraitTurn(execTurn, params)) return '';
    switch (game.clothType) {
      case 'rainbow':
        return rainbowMode(execTurn, params) === 'half'
          ? styles.traitUnderlineHalf
          : styles.traitUnderlineUp;
      case 'regen':
        return styles.traitUnderlineRegen;
      case 'light':
        return styles.traitUnderlineLight;
      default:
        return '';
    }
  };

  // エントリ i の下線クラス。発動ターンへ次の周回(サイクル一巡後)で到達するエントリ
  // (=現在位置より前のエントリ)は点線で描画する(SPEC §4.3 v1.19)。
  const cycleUnderlineClass = (i: number): string => {
    const base = traitUnderlineClass(cycleExecTurn(i));
    if (base === '') return '';
    const nextCycle = i < game.cycleIndex;
    return nextCycle ? `${base} ${styles.traitUnderlineNextCycle}` : base;
  };

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
        <span
          className={`${styles.powerBadge} ${styles[`power_${game.currentPower}`] ?? ''}`}
        >
          {POWER_LABELS[game.currentPower]}
        </span>
        {showCyclePreview && (
          <>
            <span className={styles.powerArrow}>→</span>
            <span className={`${styles.powerBadge} ${styles[`power_${nextPower}`] ?? ''}`}>
              {POWER_LABELS[nextPower]}
            </span>
          </>
        )}
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
                className={`${styles.cycleItem} ${i === game.cycleIndex ? styles.cycleCurrent : ''} ${cycleUnderlineClass(i)}`}
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
