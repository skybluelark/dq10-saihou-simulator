// コアの TurnEvent → 人間可読ログ行への整形 (SPEC §4.3 / ARCHITECTURE A6 の表示側)
// 例: 「T4: 2倍ぬい → (2,2) -28 会心! (消費9)」「T5: 布特性: 消費集中力半減」

import type { Power, Star, TurnEvent } from '../core';

export const POWER_LABELS: Record<Power, string> = {
  weak: '弱い',
  normal: '普通',
  strong: '強い',
  strongest: '最強',
  critx2: '会心×2',
  unknown: '？',
};

export const STAR_LABELS: Record<Star, string> = {
  star3: '★3',
  star2: '★2',
  star1: '★1',
  star0: '★0',
  fail: '失敗',
};

export const CLOTH_LABELS: Record<string, string> = {
  normal: '通常',
  regen: '再生布',
  rainbow: '虹布',
  light: '光布',
};

type SewCellEvent = Extract<TurnEvent, { kind: 'sewCell' }>;

function formatSew(s: SewCellEvent, showRolls: boolean): string {
  const sign = s.damage < 0 ? '+' : '-';
  const crit = s.crit ? ' 会心!' : '';
  const capped = s.capped && s.damage >= 0 ? '(頭打ち)' : '';
  // 検証モード時のみ: 基礎値の出目・会心率を [] 内に付記する(SPEC §4.3)。
  let rate = '';
  if (showRolls) {
    rate =
      s.critRate !== undefined
        ? ` [出目${s.baseValue} 会心率${(s.critRate * 100).toFixed(1)}%]`
        : ` [出目${s.baseValue}]`;
  }
  return `(${s.r},${s.c}) ${sign}${Math.abs(s.damage)}${crit}${capped}${rate}`;
}

/**
 * 1回のコア呼び出し(createSession / beginTurn / applyAction)のイベント列を
 * ログ行(古い順)へ整形する。turn は当該イベントの属するターン番号。
 */
export function formatEvents(
  events: TurnEvent[],
  turn: number,
  skillName: (id: string) => string,
  opts?: { showRolls?: boolean },
): string[] {
  const showRolls = opts?.showRolls ?? false;
  const lines: string[] = [];
  const sews: SewCellEvent[] = [];
  let detail = '';

  for (const e of events) {
    switch (e.kind) {
      case 'sewCell':
        sews.push(e);
        break;
      case 'powerLock':
        detail = ` → ${POWER_LABELS[e.power]}を${e.turns}ターン固定`;
        break;
      case 'powerShift':
        detail = ` → 次ターン: ${POWER_LABELS[e.to]}${e.shiftCrit ? '(シフト会心)' : ''}`;
        break;
      case 'muga':
        detail = ' → 会心率×2(ゲーム終了まで)';
        break;
      case 'skillUsed': {
        const targets =
          sews.length > 0
            ? ` → ${sews.map((s) => formatSew(s, showRolls)).join(' / ')}`
            : '';
        lines.push(`T${turn}: ${skillName(e.skillId)}${targets}${detail} (消費${e.cost})`);
        sews.length = 0;
        detail = '';
        break;
      }
      case 'turnStart':
        if (e.drawnPower) {
          lines.push(`T${e.turn}: ぬいパワー「？」→ ${POWER_LABELS[e.drawnPower]}`);
        }
        break;
      case 'concRecovery':
        lines.push(`T${turn}: 集中力が${e.amount}回復した`);
        break;
      case 'glow':
        lines.push(`T${turn}: 布特性: (${e.r},${e.c})が発光(会心+24%・補正×2)`);
        break;
      case 'clothRegen':
        lines.push(`T${turn}: 布特性: (${e.r},${e.c})が${e.amount}回復`);
        break;
      case 'clothRainbow':
        lines.push(
          e.mode === 'half'
            ? `T${turn}: 布特性: 消費集中力半減`
            : `T${turn}: 布特性: 消費集中力1.5倍・会心率+24%`,
        );
        break;
      case 'hissatsuCharge':
        lines.push(e.source === 'opening' ? '開始時: 必殺チャージ!' : `T${turn}: 必殺チャージ!`);
        break;
      case 'insufficientConcentration':
        lines.push(`T${turn}: ${skillName(e.skillId)} は集中力不足で使用できない`);
        break;
      case 'invalidTarget':
        lines.push(`T${turn}: ${skillName(e.skillId)} は対象マスがないため使用できない`);
        break;
      case 'finish':
        lines.push(`しあげる → ${STAR_LABELS[e.star]} (誤差評価値 ${e.totalError})`);
        break;
    }
  }
  return lines;
}
