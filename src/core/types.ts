// コア型定義 (ARCHITECTURE A3/A9)
// GameState は JSONシリアライズ可能なプレーンオブジェクト。

import type { Power, NeedleType, Star } from './data-types';

// ---- 設定 (ARCHITECTURE A9) ----

export interface SimulatorConfig {
  level: number; // デフォルト 80
  kotsu: boolean; // デフォルト true
  passives: { critUp: boolean; hissatsuUp: boolean }; // デフォルト true
  needle: { type: NeedleType; stars: 0 | 1 | 2 | 3 };
}

export const DEFAULT_CONFIG: SimulatorConfig = {
  level: 80,
  kotsu: true,
  passives: { critUp: true, hissatsuUp: true },
  needle: { type: 'copper', stars: 0 },
};

// ---- 盤面 ----

export interface CellState {
  r: number;
  c: number;
  base: number; // 基準値
  cumulative: number; // 累積ダメージ(0 = 初期状態)。残り = base - cumulative
  shitsuke: boolean; // しつけがけ付与中(マス補正×2)
}

// ---- GameState(シリアライズ可能) ----

export interface GameState {
  recipeId: string;
  category: string;
  clothType: string; // 'normal' | 'regen' | 'rainbow' | 'light'
  rows: number;
  cols: number;
  cells: CellState[];
  massCount: number; // 4/6/7/9

  powerCycle: Power[]; // レシピ固定のパワーサイクル
  cycleIndex: number; // 次に参照するサイクル位置

  turn: number; // 経過ターン数(行動回数)。開始時 0、最初の行動後 1
  concentration: number; // 残り集中力

  currentPower: Power; // 当ターンの実効パワー(？は抽選済みの値)

  // 精神統一によるパワー固定(残りターン数)。0 = 固定なし
  lockPowerRemaining: number;
  lockedPower: Power | null;

  // 次ターンの強制パワー(ぬいパワーシフトの結果)。null = なし
  forcedNextPower: Power | null;

  // このターンがシフト会心か(パワーシフトで critx2 になった)
  shiftCritThisTurn: boolean;
  // このターンがランダム会心か(？→critx2)
  randomCritThisTurn: boolean;

  hissatsuCharged: boolean; // 必殺チャージ保持中
  hissatsuUsed: boolean; // 無我の境地を使用済み(セッション1回制限)
  mugaActive: boolean; // 無我の境地の会心率×2が有効

  concRecoveryUsed: boolean; // 集中力自動回復を使用済み(セッション1回)

  finished: boolean; // しあげる済み

  // 内部進行フラグ
  turnStarted: boolean; // 当ターンのターン開始処理(？抽選・光発光・回復判定)が済んだか
  glowCell: { r: number; c: number } | null; // 当ターンの発光マス(光布)
}

// ---- Action(リプレイ可能) ----

export type Action =
  | { type: 'sew'; skillId: string; anchor: { r: number; c: number } } // 対象ありの縫い/糸ほぐし/しつけがけ
  | { type: 'skill'; skillId: string } // 対象不要(精神統一・シフト・みだれ・無我)
  | { type: 'finish' }; // しあげる

// ---- TurnEvent(UI/ログ用) ----

export type TurnEvent =
  | { kind: 'turnStart'; turn: number; power: Power; drawnPower?: Power }
  | { kind: 'concRecovery'; amount: number }
  | { kind: 'glow'; r: number; c: number }
  | {
      kind: 'sewCell';
      r: number;
      c: number;
      damage: number; // 適用された実ダメージ(会心・頭打ち後)。糸ほぐしは負
      crit: boolean;
      capped: boolean; // 基準値/初期状態で頭打ちされたか
    }
  | { kind: 'skillUsed'; skillId: string; cost: number }
  | { kind: 'powerLock'; power: Power; turns: number }
  | { kind: 'powerShift'; from: Power; to: Power; shiftCrit: boolean }
  | { kind: 'clothRegen'; r: number; c: number; amount: number }
  | { kind: 'clothRainbow'; mode: 'half' | 'up'; cost: number }
  | { kind: 'hissatsuCharge'; source: 'opening' | 'turnEnd' }
  | { kind: 'muga' }
  | { kind: 'insufficientConcentration'; skillId: string; cost: number }
  | { kind: 'finish'; star: Star; totalError: number };

export interface ApplyResult {
  state: GameState;
  events: TurnEvent[];
}

export interface JudgeResult {
  star: Star;
  totalError: number; // 評価値合計(ゲージ外9換算済み)
  rawTotalError: number; // 生の |残り| 合計
}
