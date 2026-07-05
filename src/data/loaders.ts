// JSON ローダ(バリデーション付き)と DataProvider インターフェース。
// バンドルされた JSON を型検証して返す純関数群。fetch は DataProvider 実装に分離。

import type {
  GameParams,
  NeedlesFile,
  SkillsFile,
  ConcentrationFile,
  RecipeParseResult,
} from './types';

import gameParamsRaw from './game-params.json';
import needlesRaw from './needles.json';
import skillsRaw from './skills.json';
import concentrationRaw from './concentration.json';
import { parseRecipesCsv } from './recipe-csv';

export class DataValidationError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new DataValidationError(msg);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function loadGameParams(): GameParams {
  const p = gameParamsRaw as GameParams;
  assert(p.version === '1.0', 'game-params.json: version 不一致');
  assert(isNum(p.crit.kotsuBonus), 'game-params.json: crit.kotsuBonus');
  assert(isNum(p.hissatsuCharge.baseRate), 'game-params.json: hissatsuCharge.baseRate');
  assert(Array.isArray(p.clothTrait.regenAmounts), 'game-params.json: regenAmounts');
  for (const mass of ['9', '7', '6', '4']) {
    assert(p.evaluation[mass], `game-params.json: evaluation[${mass}] 欠落`);
  }
  return p;
}

export function loadNeedles(): NeedlesFile {
  const n = needlesRaw as NeedlesFile;
  assert(n.version === '1.0', 'needles.json: version 不一致');
  assert(n.needles.length === 7, 'needles.json: 針は7種必要');
  for (const needle of n.needles) {
    assert(needle.critRate.length === 4, `needles.json: ${needle.id} critRate は4要素`);
    assert(isNum(needle.concentration), `needles.json: ${needle.id} concentration`);
  }
  return n;
}

export function loadSkills(): SkillsFile {
  const s = skillsRaw as unknown as SkillsFile;
  assert(s.version === '1.0', 'skills.json: version 不一致');
  assert(Array.isArray(s.skills) && s.skills.length > 0, 'skills.json: skills 欠落');
  assert(typeof s.targetPatterns === 'object', 'skills.json: targetPatterns 欠落');
  return s;
}

export function loadConcentration(): ConcentrationFile {
  const c = concentrationRaw as ConcentrationFile;
  assert(c.version === '1.0', 'concentration.json: version 不一致');
  assert(c.base.length === 80, 'concentration.json: base は80要素(Lv1〜80)');
  assert(c.base[79] === 207, 'concentration.json: Lv80=207');
  return c;
}

/** バンドルされた全 JSON をまとめてロード。 */
export interface GameData {
  params: GameParams;
  needles: NeedlesFile;
  skills: SkillsFile;
  concentration: ConcentrationFile;
}

export function loadGameData(): GameData {
  return {
    params: loadGameParams(),
    needles: loadNeedles(),
    skills: loadSkills(),
    concentration: loadConcentration(),
  };
}

/**
 * DataProvider: レシピCSVの取得元を抽象化(ARCHITECTURE A5)。
 * fetch / fs / IndexedDB などの取得手段をこの背後に隠す。
 */
export interface DataProvider {
  loadRecipes(): Promise<RecipeParseResult>;
}

/** fetch でCSVを取得する実装(ブラウザ用)。 */
export class FetchDataProvider implements DataProvider {
  constructor(private readonly url: string) {}

  async loadRecipes(): Promise<RecipeParseResult> {
    const res = await fetch(this.url);
    const text = await res.text();
    return parseRecipesCsv(text);
  }
}
