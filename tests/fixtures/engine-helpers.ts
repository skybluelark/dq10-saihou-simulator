// テスト用ヘルパ: エンジン生成・制御可能なRNG・レシピ組み立て。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  Engine,
  type EngineData,
  type Rng,
  Mulberry32,
} from '../../src/core';
import {
  loadGameParams,
  loadNeedles,
  loadSkills,
  loadConcentration,
  parseRecipesCsv,
  type RecipeDef,
  type RecipeParseResult,
} from '../../src/data';

const here = dirname(fileURLToPath(import.meta.url));
const projectDataDir = resolve(here, '../../data');

export function buildEngineData(): EngineData {
  return {
    params: loadGameParams(),
    needles: loadNeedles(),
    skills: loadSkills(),
    concentration: loadConcentration(),
  };
}

export function buildEngine(): Engine {
  return new Engine(buildEngineData());
}

export function realRecipesCsv(): string {
  // src/data の JSON ではなく data/recipes.csv を fs で読む(パーサは純関数)
  return readFileSync(resolve(projectDataDir, 'recipes.csv'), 'utf8');
}

export function parseRealRecipes(): RecipeParseResult {
  return parseRecipesCsv(realRecipesCsv());
}

/**
 * 指定した数列を順に返す決定論RNG(next())。nextInt は floor(next()*max)。
 * 数列を使い切ったら例外を投げる(消費順検証に有用)。
 */
export class ScriptedRng implements Rng {
  private i = 0;
  constructor(private readonly values: number[]) {}
  next(): number {
    if (this.i >= this.values.length) {
      throw new Error(`ScriptedRng: 乱数を使い切りました (index=${this.i})`);
    }
    return this.values[this.i++];
  }
  nextInt(max: number): number {
    return Math.floor(this.next() * max);
  }
  getState(): number {
    return this.i;
  }
  consumed(): number {
    return this.i;
  }
}

/** mulberry32 の生成器。 */
export function seededRng(seed: number): Rng {
  return new Mulberry32(seed);
}

/**
 * 基礎値(12〜18)を狙って出すための next() 値。
 * nextInt(7) = floor(x*7) = baseValue-12 になる x を返す。
 */
export function baseValueRoll(baseValue: number): number {
  const k = baseValue - 12; // 0..6
  return (k + 0.5) / 7;
}

/** 糸ほぐし基礎値(-6〜-9)。nextInt(4)=floor(x*4)=(-base-6)。 */
export function hogushiRoll(recovery: number): number {
  const k = recovery - 6; // 0..3 (|6|→|9|)
  return (k + 0.5) / 4;
}

/** 会心を必ず出す/出さない値(rate<1 前提)。 */
export const CRIT_YES = 0.0;
export const CRIT_NO = 0.9999999;

/** ターン終了の必殺チャージ判定を発動させない値。 */
export const HISSATSU_NO = 0.9999999;

/** 単一マスのテストレシピ。 */
export function singleCellRecipe(base: number, powerCycle: RecipeDef['powerCycle'] = ['normal']): RecipeDef {
  return {
    id: 'test_single',
    name: 'テスト単一',
    category: 'head',
    clothType: 'normal',
    rows: 2,
    cols: 2,
    cells: [{ r: 1, c: 1, base }],
    powerCycle,
  };
}
