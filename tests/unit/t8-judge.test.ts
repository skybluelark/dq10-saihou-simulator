// T8. できのよさ判定 (SPEC §3.7)

import { describe, expect, it } from 'vitest';
import { cellErrorScore, starForError } from '../../src/core';
import { loadGameParams } from '../../src/data';
import { EVALUATION_BOUNDARY } from '../fixtures/spec-tables';
import { buildEngine } from '../fixtures/engine-helpers';

const params = loadGameParams();

describe('T8 マス誤差の評価値', () => {
  const score = (remaining: number) => cellErrorScore(remaining, params.gauge.yellowRange, params.gauge.penaltyError);

  it('誤差≤4 はそのまま (0,1,4)', () => {
    expect(score(0)).toBe(0);
    expect(score(1)).toBe(1);
    expect(score(4)).toBe(4);
  });
  it('5〜8 は 9 に引き上げ', () => {
    expect(score(5)).toBe(9);
    expect(score(6)).toBe(9);
    expect(score(8)).toBe(9);
  });
  it('誤差≥9 はそのまま (9,10,50)', () => {
    expect(score(9)).toBe(9);
    expect(score(10)).toBe(10);
    expect(score(50)).toBe(50);
  });
  it('負の残り数値(縫いすぎ)も絶対値で同じ扱い', () => {
    expect(score(-3)).toBe(3);
    expect(score(-4)).toBe(4);
    expect(score(-5)).toBe(9); // 赤ゲージ相当もゲージ外9換算
    expect(score(-8)).toBe(9);
    expect(score(-9)).toBe(9);
    expect(score(-12)).toBe(12);
  });
});

describe('T8 評価境界(マス数4種×境界の両側)', () => {
  for (const [massStr, b] of Object.entries(EVALUATION_BOUNDARY)) {
    const mass = Number(massStr);
    describe(`${mass}マス`, () => {
      it(`★3境界: ${b.star3}→star3, ${b.star3 + 1}→star2`, () => {
        expect(starForError(b.star3, mass, params)).toBe('star3');
        expect(starForError(b.star3 + 1, mass, params)).toBe('star2');
      });
      it(`★2境界: ${b.star2}→star2, ${b.star2 + 1}→star1`, () => {
        expect(starForError(b.star2, mass, params)).toBe('star2');
        expect(starForError(b.star2 + 1, mass, params)).toBe('star1');
      });
      it(`★1境界: ${b.star1}→star1, ${b.star1 + 1}→star0`, () => {
        expect(starForError(b.star1, mass, params)).toBe('star1');
        expect(starForError(b.star1 + 1, mass, params)).toBe('star0');
      });
      it(`★0境界: ${b.star0}→star0, ${b.star0 + 1}→fail`, () => {
        expect(starForError(b.star0, mass, params)).toBe('star0');
        expect(starForError(b.star0 + 1, mass, params)).toBe('fail');
      });
      it('誤差0 は star3', () => {
        expect(starForError(0, mass, params)).toBe('star3');
      });
    });
  }
});

describe('T8 エンジン judge (状態からの判定)', () => {
  it('残り値の混在(枠内・5〜8引き上げ・枠外実数・縫いすぎ)を合算', () => {
    const engine = buildEngine();
    // 4マス: 残り 2(→2), -6(→9), 10(→10), 0(→0) = 合計21 → 4マスで star0(16<21≤29)
    const state = engine.createStateFromSnapshot({
      recipeId: 'j',
      category: 'head',
      rows: 2,
      cols: 2,
      cells: [
        { r: 1, c: 1, base: 100, cumulative: 98, shitsuke: false }, // 残り2 → 2
        { r: 1, c: 2, base: 100, cumulative: 106, shitsuke: false }, // 残り-6 → 9
        { r: 2, c: 1, base: 100, cumulative: 90, shitsuke: false }, // 残り10 → 10
        { r: 2, c: 2, base: 100, cumulative: 100, shitsuke: false }, // 残り0 → 0
      ],
      powerCycle: ['normal'],
      concentration: 0,
    });
    const j = engine.judge(state);
    expect(j.totalError).toBe(2 + 9 + 10 + 0);
    expect(j.rawTotalError).toBe(2 + 6 + 10 + 0);
    expect(j.star).toBe('star0');
  });

  it('全マス残り0 は star3 (誤差0)', () => {
    const engine = buildEngine();
    const state = engine.createStateFromSnapshot({
      recipeId: 'j',
      category: 'head',
      rows: 2,
      cols: 2,
      cells: [
        { r: 1, c: 1, base: 50, cumulative: 50, shitsuke: false },
        { r: 1, c: 2, base: 50, cumulative: 50, shitsuke: false },
        { r: 2, c: 1, base: 50, cumulative: 50, shitsuke: false },
        { r: 2, c: 2, base: 50, cumulative: 50, shitsuke: false },
      ],
      powerCycle: ['normal'],
      concentration: 0,
    });
    const j = engine.judge(state);
    expect(j.totalError).toBe(0);
    expect(j.star).toBe('star3');
  });
});
