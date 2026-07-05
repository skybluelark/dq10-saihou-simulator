// データスキーマ型定義 (DATA_DESIGN §0〜§6)
// これらは JSON / CSV の機械可読な形。数値の正は SPEC.md。
// core が消費する型のため core 配下に置く(依存方向: data → core)。

// ---- enum ----

export type Category =
  | 'head'
  | 'body_upper'
  | 'body_lower'
  | 'arm'
  | 'leg'
  | 'doll'
  | 'rug';

export type ClothType = 'normal' | 'regen' | 'rainbow' | 'light';

export type Power =
  | 'weak'
  | 'normal'
  | 'strong'
  | 'strongest'
  | 'critx2'
  | 'unknown';

export type NeedleType =
  | 'copper'
  | 'iron'
  | 'silver'
  | 'platinum'
  | 'super'
  | 'miracle'
  | 'hikari';

export type Star = 'star3' | 'star2' | 'star1' | 'star0' | 'fail';

// ---- game-params.json ----

export interface GameParams {
  version: string;
  crit: {
    kotsuBonus: number;
    passiveEffective: number;
    aimMultiplier: number;
    hissatsuMultiplier: number;
    shiftCritMultiplier: number;
    randomCritMultiplier: number;
    fixedBonus: {
      rainbowCritTurn: number;
      lightGlowCell: number;
    };
  };
  hissatsuCharge: {
    baseRate: number;
  };
  clothTrait: {
    firstTurn: number;
    interval: number;
    regenAmounts: number[];
    rainbowCostHalfFirst: boolean;
    rainbowCostUpFactor: number;
    lightCellCorrection: number;
  };
  concentrationRecovery: {
    threshold: number;
    chance: number;
    amount: number;
    oncePerSession: boolean;
  };
  gauge: {
    yellowRange: number;
    penaltyError: number;
  };
  evaluation: Record<string, EvaluationBoundary>;
}

export interface EvaluationBoundary {
  star3: number;
  star2: number;
  star1: number;
  star0: number;
}

// ---- needles.json ----

export interface NeedleOpeningEffect {
  type: 'concentration' | 'hissatsuCharge';
  chance: number;
  amount?: number;
}

export interface NeedleDef {
  id: NeedleType;
  name: string;
  concentration: number;
  critRate: [number, number, number, number];
  openingEffect?: NeedleOpeningEffect;
}

export interface NeedlesFile {
  version: string;
  needles: NeedleDef[];
}

// ---- skills.json ----

export type SkillKind = 'sew' | 'recover' | 'support' | 'passive' | 'hissatsu';

export type TargetPattern =
  | 'single'
  | 'row2'
  | 'col2'
  | 'diag_up2'
  | 'diag_down2'
  | 'row3'
  | 'col3'
  | 'plus5'
  | 'random4';

export interface SkillDef {
  id: string;
  name: string;
  learnLv?: number;
  cost?: number;
  kind: SkillKind;
  multiplier?: number;
  multipliers?: number[] | { center: number; around: number };
  target?: TargetPattern;
  aim?: boolean;
  effect?: 'lockPower' | 'shiftPower' | 'cellCorrection';
  duration?: number;
  nominal?: number;
}

export interface SkillsFile {
  version: string;
  skills: SkillDef[];
  targetPatterns: Record<string, [number, number][]>;
}

// ---- concentration.json ----

export interface ConcentrationFile {
  version: string;
  base: number[];
}

// ---- recipes (内部モデル) ----

export interface RecipeCell {
  r: number;
  c: number;
  base: number;
}

export interface RecipeDef {
  id: string;
  name: string;
  category: Category;
  clothType: ClothType;
  rows: number;
  cols: number;
  cells: RecipeCell[];
  powerCycle: Power[];
  notes?: string;
}

// ---- CSV パース結果 ----

export interface CsvIssue {
  line: number; // 1始まり(ヘッダ行=1)
  rule: string; // V1〜V8
  message: string;
}

export interface RecipeParseResult {
  recipes: RecipeDef[];
  errors: CsvIssue[];
  warnings: CsvIssue[];
}
