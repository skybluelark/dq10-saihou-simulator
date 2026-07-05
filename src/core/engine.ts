// ゲームエンジン (SPEC §3 の実装)
//
// 乱数消費順 (ARCHITECTURE A4、確定版 v1.1):
//   ターン開始時: [「？」の抽選] → [布特性: 光布の発光対象選定 / 再生布の回復(対象タイブレーク→回復量)]
//                 → [集中力自動回復判定(成功するまで条件成立ターンごとに毎回判定)]
//   縫い(通常):   マスごとに [基礎値ロール] → [会心判定](対象順に独立)
//   みだれぬい:    [対象4マス選択] → 各打ちごとに [基礎値] → [会心] ×4 → ソート適用(表示順のみ)
//   ターン終了時:  [必殺チャージ判定]
//
// createSession の開幕効果(奇跡+30 / 光チャージ)は、最初のターン開始の抽選より前
// (セッション生成時)に消費する。詳細は README/報告参照。

import type {
  GameParams,
  NeedlesFile,
  SkillsFile,
  ConcentrationFile,
  Power,
  RecipeDef,
  SkillDef,
  NeedleDef,
} from './data-types';
import type {
  GameState,
  SimulatorConfig,
  Action,
  ApplyResult,
  TurnEvent,
  CellState,
  JudgeResult,
} from './types';
import type { Rng } from './rng';
import { sewDamage, hogushiDamage } from './damage';
import { computeCritRate, type CritContext } from './crit';
import { judge as judgeState } from './judge';

// 「？」の抽選候補(5種等確率)
const UNKNOWN_CANDIDATES: Power[] = ['weak', 'normal', 'strong', 'strongest', 'critx2'];
// ぬいパワーシフトの候補(？含まず、使用ターンのパワーを除く)
const SHIFT_CANDIDATES: Power[] = ['weak', 'normal', 'strong', 'strongest', 'critx2'];

export interface EngineData {
  params: GameParams;
  needles: NeedlesFile;
  skills: SkillsFile;
  concentration: ConcentrationFile;
}

/** エンジン。データを束ねて createSession / applyAction を提供する。 */
export class Engine {
  private readonly params: GameParams;
  private readonly needles: NeedlesFile;
  private readonly skills: SkillsFile;
  private readonly concentrationBase: number[];
  private readonly skillMap: Map<string, SkillDef>;

  constructor(data: EngineData) {
    this.params = data.params;
    this.needles = data.needles;
    this.skills = data.skills;
    this.concentrationBase = data.concentration.base;
    this.skillMap = new Map(data.skills.skills.map((s) => [s.id, s]));
  }

  /** レベル別集中力基礎値(Lv80=207)。 */
  private concBase(level: number): number {
    const idx = level - 1;
    if (idx < 0 || idx >= this.concentrationBase.length) {
      throw new Error(`レベル ${level} は集中力テーブル範囲外です。`);
    }
    return this.concentrationBase[idx];
  }

  private needle(config: SimulatorConfig): NeedleDef {
    const n = this.needles.needles.find((x) => x.id === config.needle.type);
    if (!n) throw new Error(`不明な針: ${config.needle.type}`);
    return n;
  }

  private needleCritRate(config: SimulatorConfig): number {
    return this.needle(config).critRate[config.needle.stars];
  }

  // ---- セッション生成 ----

  /**
   * レシピ・設定・シードからセッション初期状態を作る。
   * 開幕効果(奇跡=30%集中+30 / 光=10%必殺チャージ)をここで抽選する。
   */
  createSession(recipe: RecipeDef, config: SimulatorConfig, rng: Rng): ApplyResult {
    const events: TurnEvent[] = [];
    const cells: CellState[] = recipe.cells.map((c) => ({
      r: c.r,
      c: c.c,
      base: c.base,
      cumulative: 0,
      shitsuke: false,
    }));

    const massCount = cells.length;
    const needle = this.needle(config);

    // 開始集中力 = レベル基礎値(Lv80=207) + 針集中度 + 開幕(奇跡+30、発動時)
    let concentration = this.concBase(config.level) + needle.concentration;

    let hissatsuCharged = false;

    // 開幕特殊効果(針依存)。奇跡系=集中、光系=必殺チャージ。
    const opening = needle.openingEffect;
    if (opening) {
      const roll = rng.next();
      if (roll < opening.chance) {
        if (opening.type === 'concentration') {
          concentration += opening.amount ?? 0;
        } else if (opening.type === 'hissatsuCharge') {
          hissatsuCharged = true;
          events.push({ kind: 'hissatsuCharge', source: 'opening' });
        }
      }
    }

    const state: GameState = {
      recipeId: recipe.id,
      category: recipe.category,
      clothType: recipe.clothType,
      rows: recipe.rows,
      cols: recipe.cols,
      cells,
      massCount,
      powerCycle: [...recipe.powerCycle],
      cycleIndex: 0,
      turn: 0,
      concentration,
      currentPower: 'normal',
      lockPowerRemaining: 0,
      lockedPower: null,
      forcedNextPower: null,
      shiftCritThisTurn: false,
      randomCritThisTurn: false,
      hissatsuCharged,
      hissatsuUsed: false,
      mugaActive: false,
      concRecoveryUsed: false,
      finished: false,
      turnStarted: false,
      glowCell: null,
    };

    return { state, events };
  }

  /**
   * 任意の途中状態から GameState を構築(ARCHITECTURE A3、W3計算機モード用)。
   * 与えられた部分状態を既定値に重ねる。ターン開始処理は未実施状態で返す。
   */
  createStateFromSnapshot(snapshot: Partial<GameState> & {
    recipeId: string;
    cells: CellState[];
    powerCycle: Power[];
  }): GameState {
    const massCount = snapshot.massCount ?? snapshot.cells.length;
    return {
      recipeId: snapshot.recipeId,
      category: snapshot.category ?? '',
      clothType: snapshot.clothType ?? 'normal',
      rows: snapshot.rows ?? 3,
      cols: snapshot.cols ?? 3,
      cells: snapshot.cells.map((c) => ({ ...c })),
      massCount,
      powerCycle: [...snapshot.powerCycle],
      cycleIndex: snapshot.cycleIndex ?? 0,
      turn: snapshot.turn ?? 0,
      concentration: snapshot.concentration ?? 0,
      currentPower: snapshot.currentPower ?? 'normal',
      lockPowerRemaining: snapshot.lockPowerRemaining ?? 0,
      lockedPower: snapshot.lockedPower ?? null,
      forcedNextPower: snapshot.forcedNextPower ?? null,
      shiftCritThisTurn: snapshot.shiftCritThisTurn ?? false,
      randomCritThisTurn: snapshot.randomCritThisTurn ?? false,
      hissatsuCharged: snapshot.hissatsuCharged ?? false,
      hissatsuUsed: snapshot.hissatsuUsed ?? false,
      mugaActive: snapshot.mugaActive ?? false,
      concRecoveryUsed: snapshot.concRecoveryUsed ?? false,
      finished: snapshot.finished ?? false,
      turnStarted: snapshot.turnStarted ?? false,
      glowCell: snapshot.glowCell ?? null,
    };
  }

  judge(state: GameState): JudgeResult {
    return judgeState(state, this.params);
  }

  /**
   * ターン開始処理(？抽選・布特性・集中力自動回復)を実行した状態とイベントを返す(公開API)。
   * UIが行動前に当ターンのぬいパワー・光布の発光・自動回復を表示するために使う。
   *
   * applyAction は turnStarted ガードによりターン開始処理を再実行しないため、
   * beginTurn→applyAction の順で呼んでも applyAction 単独と乱数消費・結果が完全一致する。
   * すでに開始済み・終了済みの状態では何もしない(乱数消費なし)。
   */
  beginTurn(state: GameState, rng: Rng): ApplyResult {
    const next = cloneState(state);
    const events: TurnEvent[] = [];
    if (next.finished) {
      return { state: next, events };
    }
    this.startTurn(next, rng, events);
    return { state: next, events };
  }

  // ---- ターン開始処理 ----

  /**
   * ターン開始処理(？抽選・布特性[光発光/再生回復/虹イベント]・集中力自動回復)を
   * 1度だけ実施し、当ターンの currentPower を確定する。すでに開始済みなら何もしない。
   */
  private startTurn(state: GameState, rng: Rng, events: TurnEvent[]): void {
    if (state.turnStarted) return;

    // パワー確定: 精神統一で固定中ならそのパワー。そうでなければ強制次パワー or サイクル。
    let power: Power;
    let drawnPower: Power | undefined;
    if (state.lockPowerRemaining > 0 && state.lockedPower) {
      power = state.lockedPower;
    } else {
      if (state.forcedNextPower) {
        power = state.forcedNextPower;
        state.forcedNextPower = null;
      } else {
        power = state.powerCycle.length > 0 ? state.powerCycle[state.cycleIndex] : 'normal';
      }
      // 「？」の抽選(ターン開始時・特技選択前)
      if (power === 'unknown') {
        const idx = rng.nextInt(UNKNOWN_CANDIDATES.length);
        power = UNKNOWN_CANDIDATES[idx];
        drawnPower = power;
      }
    }

    state.currentPower = power;
    // シフト会心/ランダム会心の判定(当ターン)
    const internal = state as GameStateInternal;
    state.shiftCritThisTurn = internal.shiftFlagPending === true;
    state.randomCritThisTurn = drawnPower === 'critx2';

    // シフト会心フラグの掃除
    delete internal.shiftFlagPending;

    const nextTurn = state.turn + 1;

    // 布特性(発動ターンのみ。光布=発光対象選定 / 再生布=回復 は排他)
    state.glowCell = null;
    if (isTraitTurn(nextTurn, this.params)) {
      if (state.clothType === 'light') {
        const cell = this.pickGlowCell(state, rng);
        if (cell) {
          state.glowCell = { r: cell.r, c: cell.c };
          events.push({ kind: 'glow', r: cell.r, c: cell.c });
        }
      } else if (state.clothType === 'regen') {
        this.applyRegen(state, rng, events);
      } else if (state.clothType === 'rainbow') {
        // 虹の消費補正・会心+24%は effectiveCost / rollCrit 側で処理済み。表示用イベントのみ発行。
        const mode = rainbowMode(nextTurn, this.params);
        events.push({ kind: 'clothRainbow', mode, cost: 0 });
      }
    }

    // 集中力自動回復判定(残10以下・10%・成功するまで条件成立ターンごとに毎回判定)
    const rec = this.params.concentrationRecovery;
    if (
      !state.concRecoveryUsed &&
      state.concentration <= rec.threshold
    ) {
      const roll = rng.next();
      if (roll < rec.chance) {
        state.concentration += rec.amount;
        state.concRecoveryUsed = true;
        events.push({ kind: 'concRecovery', amount: rec.amount });
      }
      // 不発の場合はフラグを立てない → 次回条件成立ターンで再判定する。
    }

    events.push({
      kind: 'turnStart',
      turn: nextTurn,
      power: state.currentPower,
      drawnPower,
    });

    state.turnStarted = true;
  }

  /** 光布の発光候補(残り数値5以上=黄色ゲージ外かつ非赤ゲージ)から1マス選ぶ。 */
  private pickGlowCell(state: GameState, rng: Rng): CellState | null {
    const yellow = this.params.gauge.yellowRange; // 4
    const candidates = state.cells.filter((cell) => {
      const remaining = cell.base - cell.cumulative;
      // 黄色ゲージ内(|残り|≤4)除外、赤ゲージ(残り≤-5)除外 → 残り≥5
      return remaining >= yellow + 1;
    });
    if (candidates.length === 0) return null;
    const idx = rng.nextInt(candidates.length);
    return candidates[idx];
  }

  // ---- 行動適用 ----

  applyAction(state: GameState, action: Action, config: SimulatorConfig, rng: Rng): ApplyResult {
    const next = cloneState(state);
    const events: TurnEvent[] = [];

    if (next.finished) {
      return { state: next, events };
    }

    if (action.type === 'finish') {
      next.finished = true;
      const j = judgeState(next, this.params);
      events.push({ kind: 'finish', star: j.star, totalError: j.totalError });
      return { state: next, events };
    }

    // ターン開始処理(？抽選・光発光・回復)
    this.startTurn(next, rng, events);

    const skill = this.skillMap.get(action.skillId);
    if (!skill) throw new Error(`不明な特技: ${action.skillId}`);

    const cost = this.effectiveCost(next, skill);

    // 集中力チェック(必殺=無我は消費0、しあげる以外)
    if (cost > next.concentration) {
      events.push({ kind: 'insufficientConcentration', skillId: skill.id, cost });
      return { state: next, events }; // ターン消費しない(行動失敗)
    }

    let turnDamage = 0;

    switch (skill.kind) {
      case 'sew':
        turnDamage = this.doSew(next, skill, action, config, rng, events);
        break;
      case 'recover':
        turnDamage = this.doHogushi(next, skill, action, rng, events);
        break;
      case 'support':
        this.doSupport(next, skill, action, rng, events);
        break;
      case 'hissatsu':
        this.doHissatsu(next, events);
        break;
      case 'passive':
        throw new Error(`パッシブは行動として使用できません: ${skill.id}`);
    }

    next.concentration -= cost;
    events.push({ kind: 'skillUsed', skillId: skill.id, cost });

    // ターン終了処理
    this.endTurn(next, config, turnDamage, rng, events);

    return { state: next, events };
  }

  /** 虹布の消費集中力補正を反映した実効コスト。 */
  private effectiveCost(state: GameState, skill: SkillDef): number {
    const baseCost = skill.cost ?? 0;
    if (skill.kind === 'hissatsu') return 0;
    if (state.clothType !== 'rainbow') return baseCost;
    // 虹布: 発動ターンのみ補正。半減/1.5倍が交互。
    const nextTurn = state.turn + 1;
    if (!isTraitTurn(nextTurn, this.params)) return baseCost;
    const mode = rainbowMode(nextTurn, this.params); // 'half' | 'up'
    const factor =
      mode === 'half' ? 0.5 : this.params.clothTrait.rainbowCostUpFactor;
    return Math.ceil(baseCost * factor); // 端数切り上げ
  }

  // ---- 縫い ----

  private doSew(
    state: GameState,
    skill: SkillDef,
    action: Action,
    config: SimulatorConfig,
    rng: Rng,
    events: TurnEvent[],
  ): number {
    if (skill.target === 'random4') {
      return this.doMidare(state, skill, config, rng, events);
    }
    if (action.type !== 'sew') throw new Error(`${skill.id} には対象マスが必要です。`);

    const targets = this.resolveTargets(skill, action.anchor);
    let total = 0;
    for (const t of targets) {
      const cell = this.cellAt(state, t.r, t.c);
      if (!cell) continue; // 布端・欠けマスへのはみ出しは無視
      const mult = t.multiplier;
      const applied = this.sewOneCell(state, cell, mult, config, rng, events, skill.aim === true);
      total += applied;
    }
    return total;
  }

  /** 1マスの縫いを実行し、適用ダメージ(正)を返す。会心判定含む。 */
  private sewOneCell(
    state: GameState,
    cell: CellState,
    skillMultiplier: number,
    config: SimulatorConfig,
    rng: Rng,
    events: TurnEvent[],
    aimOverride?: boolean,
  ): number {
    const correction = this.cellCorrection(state, cell);
    // [基礎値ロール]
    const baseValue = 12 + rng.nextInt(7); // 12..18
    let damage = sewDamage(baseValue, skillMultiplier, state.currentPower, correction);

    // [会心判定]
    const isCrit = this.rollCrit(state, cell, config, rng, aimOverride);
    let capped = false;
    if (isCrit) {
      damage *= 2;
    }
    // 累積が基準値を超える場合は基準値で頭打ち(残り0)
    const remainingBefore = cell.base - cell.cumulative;
    if (damage > remainingBefore) {
      // 会心・非会心とも縫いすぎ判定は同様だが、頭打ちフラグは会心の頭打ちのみ立てる
      if (isCrit) {
        damage = remainingBefore;
        capped = true;
      }
      // 非会心は縫いすぎ(残りマイナス)を許容 → capはしない
    }
    cell.cumulative += damage;
    events.push({
      kind: 'sewCell',
      r: cell.r,
      c: cell.c,
      damage,
      crit: isCrit,
      capped,
    });
    // しつけがけはこのマスが縫われたら解除
    if (cell.shitsuke) cell.shitsuke = false;
    return damage;
  }

  /** 会心発生判定。 */
  private rollCrit(
    state: GameState,
    cell: CellState,
    config: SimulatorConfig,
    rng: Rng,
    aimOverride?: boolean,
  ): boolean {
    // 「会心×2」パワーは会心確定ではなく会心率への補正(SPEC §3.4):
    //   シフト会心(シフト由来の critx2)= 会心率×2 / ランダム会心(？由来)= 補正なし
    const ctx: CritContext = {
      needleCritRate: this.needleCritRate(config),
      kotsu: config.kotsu,
      passiveCritUp: config.passives.critUp,
      aim: aimOverride ?? false,
      rainbowCritTurn: false,
      lightGlowCell: this.isGlow(state, cell),
      mugaActive: state.mugaActive,
      shiftCrit: state.currentPower === 'critx2' && state.shiftCritThisTurn,
    };
    // 虹布の会心ターン(消費1.5倍のターン)は固定+24%
    if (state.clothType === 'rainbow') {
      const nextTurn = state.turn + 1;
      if (isTraitTurn(nextTurn, this.params) && rainbowMode(nextTurn, this.params) === 'up') {
        ctx.rainbowCritTurn = true;
      }
    }
    const rate = computeCritRate(this.params, ctx);
    return rng.next() < rate;
  }

  private isGlow(state: GameState, cell: CellState): boolean {
    return state.glowCell !== null && state.glowCell.r === cell.r && state.glowCell.c === cell.c;
  }

  /** マス補正(しつけ×2, 光発光×2, 重複×4)。 */
  private cellCorrection(state: GameState, cell: CellState): number {
    let corr = 1;
    if (cell.shitsuke) corr *= 2;
    if (this.isGlow(state, cell)) corr *= this.params.clothTrait.lightCellCorrection;
    return corr;
  }

  // ---- みだれぬい ----

  private doMidare(
    state: GameState,
    skill: SkillDef,
    config: SimulatorConfig,
    rng: Rng,
    events: TurnEvent[],
  ): number {
    const multipliers = skill.multipliers as number[]; // [2,1,1,0.5]
    const n = multipliers.length;

    // [対象4マス選択] 異なるマスを重複なしで選ぶ(部分Fisher-Yates)
    const pool = state.cells.map((_, i) => i);
    const chosen: number[] = [];
    const pick = Math.min(n, pool.length);
    for (let k = 0; k < pick; k++) {
      const idx = rng.nextInt(pool.length - k);
      const j = k + idx;
      [pool[k], pool[j]] = [pool[j], pool[k]];
      chosen.push(pool[k]);
    }

    // 各打ちごとに [基礎値] → [会心] を生成し、生成したマス自身にそのまま適用する。
    // 「大きい値から順に縫う」は表示上の縫い順(イベント発行順)のみで、
    // どのマスにどの値が入るかのロジックには影響しない(SPEC §3.2 みだれぬい詳細)。
    interface Roll {
      r: number;
      c: number;
      damage: number; // 適用後の実ダメージ(頭打ち後)
      crit: boolean;
      capped: boolean;
    }
    const rolls: Roll[] = [];
    let total = 0;
    for (let k = 0; k < pick; k++) {
      const cell = state.cells[chosen[k]];
      const correction = this.cellCorrection(state, cell);
      const baseValue = 12 + rng.nextInt(7);
      let dmg = sewDamage(baseValue, multipliers[k], state.currentPower, correction);
      const isCrit = this.rollCrit(state, cell, config, rng);
      if (isCrit) dmg *= 2;

      // 会心の基準値頭打ちは各マス(生成マス)基準で適用
      const remainingBefore = cell.base - cell.cumulative;
      let capped = false;
      if (isCrit && dmg > remainingBefore) {
        dmg = remainingBefore;
        capped = true;
      }
      cell.cumulative += dmg;
      total += dmg;
      if (cell.shitsuke) cell.shitsuke = false;
      rolls.push({ r: cell.r, c: cell.c, damage: dmg, crit: isCrit, capped });
    }

    // 会心2倍適用後の値で降順ソートし、その順序でイベントのみ発行(表示上の縫い順)
    rolls.sort((a, b) => b.damage - a.damage);
    for (const roll of rolls) {
      events.push({ kind: 'sewCell', r: roll.r, c: roll.c, damage: roll.damage, crit: roll.crit, capped: roll.capped });
    }
    return total;
  }

  // ---- 糸ほぐし ----

  private doHogushi(
    state: GameState,
    _skill: SkillDef,
    action: Action,
    rng: Rng,
    events: TurnEvent[],
  ): number {
    if (action.type !== 'sew') throw new Error('糸ほぐしには対象マスが必要です。');
    const cell = this.cellAt(state, action.anchor.r, action.anchor.c);
    if (!cell) throw new Error('糸ほぐし: 対象マスが存在しません。');

    const correction = this.cellCorrection(state, cell); // しつけ×2は乗る(会心判定はなし)
    const baseValue = -(6 + rng.nextInt(4)); // -6..-9
    let damage = hogushiDamage(baseValue, state.currentPower, correction); // 負値

    // 回復上限: 初期状態(累積0)で頭打ち。cumulative + damage < 0 なら damage = -cumulative
    if (cell.cumulative + damage < 0) {
      damage = -cell.cumulative;
    }
    cell.cumulative += damage;
    events.push({ kind: 'sewCell', r: cell.r, c: cell.c, damage, crit: false, capped: damage === 0 });
    // 補正×2(しつけ)を適用した上で、対象マスのしつけがけを解除する(SPEC §3.3)
    if (cell.shitsuke) cell.shitsuke = false;
    return 0; // 糸ほぐしは与ダメージ0扱い(必殺チャージ判定なし)
  }

  // ---- 補助特技 ----

  private doSupport(
    state: GameState,
    skill: SkillDef,
    action: Action,
    rng: Rng,
    events: TurnEvent[],
  ): void {
    switch (skill.effect) {
      case 'lockPower': {
        // 精神統一: 当ターンの currentPower を duration ターン固定
        const dur = skill.duration ?? 3;
        state.lockedPower = state.currentPower;
        state.lockPowerRemaining = dur;
        events.push({ kind: 'powerLock', power: state.currentPower, turns: dur });
        break;
      }
      case 'shiftPower': {
        // ぬいパワーシフト: 次ターンのパワーを、使用ターンのパワーを除く5種から等確率で選ぶ
        const from = state.currentPower;
        const candidates = SHIFT_CANDIDATES.filter((p) => p !== from);
        const to = candidates[rng.nextInt(candidates.length)];
        state.forcedNextPower = to;
        const shiftCrit = to === 'critx2';
        // 次ターン開始時にシフト会心フラグを立てるためのペンディング
        (state as GameStateInternal).shiftPendingNext = shiftCrit;
        events.push({ kind: 'powerShift', from, to, shiftCrit });
        break;
      }
      case 'cellCorrection': {
        // しつけがけ: 対象マスに補正×2を付与(重ね掛け不可)
        if (action.type !== 'sew') throw new Error('しつけがけには対象マスが必要です。');
        const cell = this.cellAt(state, action.anchor.r, action.anchor.c);
        if (!cell) throw new Error('しつけがけ: 対象マスが存在しません。');
        cell.shitsuke = true;
        break;
      }
    }
  }

  private doHissatsu(state: GameState, events: TurnEvent[]): void {
    if (!state.hissatsuCharged) throw new Error('必殺チャージがありません。');
    if (state.hissatsuUsed) throw new Error('必殺はセッション1回のみです。');
    state.mugaActive = true;
    state.hissatsuUsed = true;
    state.hissatsuCharged = false;
    events.push({ kind: 'muga' });
    // ぬいパワーは次のものに移動する(このターンを消費し、次パワーへ)。
  }

  // ---- 布特性(再生) ----

  /** 再生布: 累積÷基準値が最大のマス(黄色枠内除外)を回復。 */
  private applyRegen(state: GameState, rng: Rng, events: TurnEvent[]): void {
    const yellow = this.params.gauge.yellowRange;
    const eligible = state.cells.filter((cell) => {
      const remaining = cell.base - cell.cumulative;
      return Math.abs(remaining) > yellow; // 黄色枠内(|残り|≤4)は除外
    });
    if (eligible.length === 0) return;

    let bestRatio = -Infinity;
    for (const cell of eligible) {
      const ratio = cell.cumulative / cell.base;
      if (ratio > bestRatio) bestRatio = ratio;
    }
    const tied = eligible.filter((cell) => cell.cumulative / cell.base === bestRatio);

    // [対象タイブレーク]
    const target = tied.length === 1 ? tied[0] : tied[rng.nextInt(tied.length)];
    // [回復量ロール]
    const amounts = this.params.clothTrait.regenAmounts;
    const amount = amounts[rng.nextInt(amounts.length)];
    // 回復(累積を減らす。初期状態=0 で頭打ち)
    const applied = Math.min(amount, target.cumulative);
    target.cumulative -= applied;
    events.push({ kind: 'clothRegen', r: target.r, c: target.c, amount: applied });
  }

  // ---- ターン終了 ----

  private endTurn(
    state: GameState,
    config: SimulatorConfig,
    turnDamage: number,
    rng: Rng,
    events: TurnEvent[],
  ): void {
    // 必殺チャージ判定(与ダメージ>0のターン終了時のみ、保持中は再判定なし)
    if (turnDamage > 0 && !state.hissatsuCharged && !state.hissatsuUsed) {
      const rate =
        this.params.hissatsuCharge.baseRate * turnDamage * this.needleCritRate(config);
      if (rng.next() < rate) {
        state.hissatsuCharged = true;
        events.push({ kind: 'hissatsuCharge', source: 'turnEnd' });
      }
    }

    // 精神統一の残りターン数を減らす
    if (state.lockPowerRemaining > 0) {
      state.lockPowerRemaining -= 1;
      if (state.lockPowerRemaining === 0) state.lockedPower = null;
    }

    // シフトのペンディングを次ターンのフラグへ移す
    const internal = state as GameStateInternal;
    if (internal.shiftPendingNext !== undefined) {
      internal.shiftFlagPending = internal.shiftPendingNext;
      delete internal.shiftPendingNext;
    }

    // サイクル前進(精神統一の固定中は前進しない)
    if (state.lockPowerRemaining === 0 && state.powerCycle.length > 0) {
      state.cycleIndex = (state.cycleIndex + 1) % state.powerCycle.length;
    }

    state.turn += 1;
    state.turnStarted = false;
    state.shiftCritThisTurn = false;
    state.randomCritThisTurn = false;
    state.glowCell = null;
  }

  // ---- 対象解決 ----

  /** アンカーからオフセット配列で対象マスを解決(倍率つき)。 */
  private resolveTargets(
    skill: SkillDef,
    anchor: { r: number; c: number },
  ): { r: number; c: number; multiplier: number }[] {
    const pattern = skill.target!;
    const offsets = this.skills.targetPatterns[pattern];
    if (!offsets) throw new Error(`対象パターン未定義: ${pattern}`);

    if (pattern === 'plus5') {
      // 巻きこみぬい: 中心1.5倍、周囲0.75倍
      const m = skill.multipliers as { center: number; around: number };
      return offsets.map(([dr, dc], i) => ({
        r: anchor.r + dr,
        c: anchor.c + dc,
        multiplier: i === 0 ? m.center : m.around,
      }));
    }

    const mult = skill.multiplier ?? 1;
    return offsets.map(([dr, dc]) => ({
      r: anchor.r + dr,
      c: anchor.c + dc,
      multiplier: mult,
    }));
  }

  private cellAt(state: GameState, r: number, c: number): CellState | undefined {
    return state.cells.find((cell) => cell.r === r && cell.c === c);
  }
}

// ---- 内部拡張(シリアライズ対象外の一時フラグ) ----

interface GameStateInternal extends GameState {
  shiftPendingNext?: boolean; // シフト使用ターンで立て、endTurnでshiftFlagPendingへ
  shiftFlagPending?: boolean; // 次ターン開始時にシフト会心として扱う
}

// ---- ヘルパ ----

function cloneState(state: GameState): GameState {
  // 内部一時フラグ(shiftPendingNext / shiftFlagPending)もスプレッドで引き継がれる。
  return {
    ...state,
    cells: state.cells.map((c) => ({ ...c })),
    powerCycle: [...state.powerCycle],
    glowCell: state.glowCell ? { ...state.glowCell } : null,
  };
}

/** 布特性の発動ターンか(5, 9, 13, … = firstTurn 以降 interval ごと)。 */
export function isTraitTurn(turn: number, params: GameParams): boolean {
  const { firstTurn, interval } = params.clothTrait;
  if (turn < firstTurn) return false;
  return (turn - firstTurn) % interval === 0;
}

/** 虹布の当該発動ターンのモード(初回=half、以降交互)。 */
export function rainbowMode(turn: number, params: GameParams): 'half' | 'up' {
  const { firstTurn, interval } = params.clothTrait;
  const occurrence = (turn - firstTurn) / interval; // 0,1,2,...
  return occurrence % 2 === 0 ? 'half' : 'up';
}
