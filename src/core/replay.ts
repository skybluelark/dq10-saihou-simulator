// リプレイ形式 (ARCHITECTURE A6 / SPEC §4.3 F6)
// 「シード+設定+レシピid+行動列」のコンパクトJSON {v:1, seed, recipeId, config, actions, check?}。
// UI・テスト・将来の計算機モード(W3)で共用する。
//
// runReplay のコア呼び出し列は createSession → applyAction×N。UI は表示のため各行動の
// 前に beginTurn を先行呼び出しするが、ターン開始処理は冪等(turnStarted で一度きり)の
// ため乱数消費列は同一になる(ARCHITECTURE A4)。

import type { NeedleType, RecipeDef, Star } from './data-types';
import type { Action, GameState, JudgeResult, SimulatorConfig, TurnEvent } from './types';
import { Engine } from './engine';
import { Mulberry32 } from './rng';

/** 読込時の照合用チェックサム(終了済みゲームの最終結果)。 */
export interface ReplayCheck {
  star: Star;
  totalError: number;
  turn: number;
}

export interface ReplayData {
  v: 1;
  seed: number;
  recipeId: string;
  config: SimulatorConfig;
  actions: Action[];
  check?: ReplayCheck;
}

export type ParseReplayResult =
  | { ok: true; replay: ReplayData }
  | { ok: false; error: string };

const STARS: readonly Star[] = ['star3', 'star2', 'star1', 'star0', 'fail'];
const NEEDLE_TYPES: readonly NeedleType[] = [
  'copper',
  'iron',
  'silver',
  'platinum',
  'super',
  'miracle',
  'hikari',
];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isValidAction(x: unknown): x is Action {
  if (!isRecord(x)) return false;
  switch (x.type) {
    case 'finish':
      return true;
    case 'skill':
      return typeof x.skillId === 'string';
    case 'sew':
      return (
        typeof x.skillId === 'string' &&
        isRecord(x.anchor) &&
        Number.isInteger(x.anchor.r) &&
        Number.isInteger(x.anchor.c)
      );
    default:
      return false;
  }
}

function isValidConfig(x: unknown): x is SimulatorConfig {
  if (!isRecord(x)) return false;
  if (typeof x.level !== 'number' || typeof x.kotsu !== 'boolean') return false;
  if (
    !isRecord(x.passives) ||
    typeof x.passives.critUp !== 'boolean' ||
    typeof x.passives.hissatsuUp !== 'boolean'
  ) {
    return false;
  }
  if (!isRecord(x.needle) || !NEEDLE_TYPES.includes(x.needle.type as NeedleType)) return false;
  const s = x.needle.stars;
  return s === 0 || s === 1 || s === 2 || s === 3;
}

/** リプレイテキスト(JSON)を検証つきで解釈する。 */
export function parseReplay(text: string): ParseReplayResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSONとして解釈できません' };
  }
  if (!isRecord(raw)) return { ok: false, error: 'リプレイ形式ではありません' };
  if (raw.v !== 1) return { ok: false, error: `未対応のリプレイバージョンです (v=${String(raw.v)})` };
  if (typeof raw.seed !== 'number' || !Number.isFinite(raw.seed)) {
    return { ok: false, error: 'seed が不正です' };
  }
  if (typeof raw.recipeId !== 'string' || raw.recipeId === '') {
    return { ok: false, error: 'recipeId が不正です' };
  }
  if (!isValidConfig(raw.config)) return { ok: false, error: 'config が不正です' };
  if (!Array.isArray(raw.actions) || !raw.actions.every(isValidAction)) {
    return { ok: false, error: 'actions が不正です' };
  }
  let check: ReplayCheck | undefined;
  if (raw.check !== undefined) {
    const c = raw.check;
    if (
      !isRecord(c) ||
      !STARS.includes(c.star as Star) ||
      typeof c.totalError !== 'number' ||
      typeof c.turn !== 'number'
    ) {
      return { ok: false, error: 'check が不正です' };
    }
    check = { star: c.star as Star, totalError: c.totalError, turn: c.turn };
  }
  return {
    ok: true,
    replay: {
      v: 1,
      seed: raw.seed,
      recipeId: raw.recipeId,
      config: raw.config,
      actions: raw.actions as Action[],
      check,
    },
  };
}

/** リプレイをテキスト(コンパクトJSON)へ変換する。 */
export function serializeReplay(replay: ReplayData): string {
  return JSON.stringify(replay);
}

/** 終了済みゲームからチェックサムを作る。 */
export function makeReplayCheck(judge: JudgeResult, state: GameState): ReplayCheck {
  return { star: judge.star, totalError: judge.totalError, turn: state.turn };
}

/** 再実行結果がチェックサムと一致するか。 */
export function matchesReplayCheck(
  check: ReplayCheck,
  judge: JudgeResult,
  state: GameState,
): boolean {
  return check.star === judge.star && check.totalError === judge.totalError && check.turn === state.turn;
}

export interface ReplayRunResult {
  /** [0]=createSession後の開始状態、以降は各行動後の状態。 */
  states: GameState[];
  /** states と同じ添字のイベント列([0]=開幕イベント)。 */
  allEvents: TurnEvent[][];
  final: GameState;
}

/** リプレイを再実行する。recipe は replay.recipeId と一致していること。 */
export function runReplay(engine: Engine, recipe: RecipeDef, replay: ReplayData): ReplayRunResult {
  if (recipe.id !== replay.recipeId) {
    throw new Error(`レシピidがリプレイと一致しません: ${recipe.id} != ${replay.recipeId}`);
  }
  const rng = new Mulberry32(replay.seed);
  const session = engine.createSession(recipe, replay.config, rng);
  const states: GameState[] = [session.state];
  const allEvents: TurnEvent[][] = [session.events];
  let state = session.state;
  for (const action of replay.actions) {
    const res = engine.applyAction(state, action, replay.config, rng);
    state = res.state;
    states.push(res.state);
    allEvents.push(res.events);
  }
  return { states, allEvents, final: state };
}
