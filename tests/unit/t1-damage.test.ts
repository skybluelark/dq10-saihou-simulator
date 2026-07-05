// T1. ダメージ計算 (SPEC §3.2)

import { describe, expect, it } from 'vitest';
import { sewDamage, hogushiDamage, roundPositive } from '../../src/core';
import {
  SEW_TABLE,
  BASE_VALUES,
  POWER_COLUMNS,
  HOGUSHI_TABLE,
  HOGUSHI_BASE_VALUES,
} from '../fixtures/spec-tables';
import type { Power } from '../../src/data/types';

describe('T1 縫いダメージテーブル全数一致 (168ケース)', () => {
  let count = 0;
  for (const multStr of Object.keys(SEW_TABLE)) {
    const mult = Number(multStr);
    for (const power of POWER_COLUMNS) {
      const expected = SEW_TABLE[mult][power];
      for (let i = 0; i < BASE_VALUES.length; i++) {
        const base = BASE_VALUES[i];
        count++;
        it(`倍率${mult} × ${power} × 基礎値${base} = ${expected[i]}`, () => {
          expect(sewDamage(base, mult, power, 1)).toBe(expected[i]);
        });
      }
    }
  }
  it('ケース数 = 168', () => {
    expect(count).toBe(6 * 4 * 7);
  });
});

describe('T1 糸ほぐしテーブル全数一致 (32ケース)', () => {
  let count = 0;
  const powers: Power[] = ['weak', 'normal', 'strong', 'strongest'];
  for (const power of powers) {
    for (let i = 0; i < HOGUSHI_BASE_VALUES.length; i++) {
      const recovery = HOGUSHI_BASE_VALUES[i]; // 6..9
      const baseValue = -recovery;
      // マス補正1
      count++;
      it(`${power} 補正1 基礎値${baseValue} = -${HOGUSHI_TABLE[power].corr1[i]}`, () => {
        expect(hogushiDamage(baseValue, power, 1)).toBe(-HOGUSHI_TABLE[power].corr1[i]);
      });
      // マス補正2
      count++;
      it(`${power} 補正2 基礎値${baseValue} = -${HOGUSHI_TABLE[power].corr2[i]}`, () => {
        expect(hogushiDamage(baseValue, power, 2)).toBe(-HOGUSHI_TABLE[power].corr2[i]);
      });
    }
  }
  it('ケース数 = 32', () => {
    expect(count).toBe(4 * 2 * 4);
  });
});

describe('T1 丸め規則', () => {
  it('正値切り上げ 3.5→4', () => {
    expect(roundPositive(3.5)).toBe(4);
  });
  it('負値も正方向 -3.5→-3', () => {
    expect(roundPositive(-3.5)).toBe(-3);
  });
  it('括弧ごとの適用: base15×0.5=7.5→8, ×0.5=4', () => {
    // 15×0.5=7.5→ceil8, 8×0.5=4→ceil4
    expect(sewDamage(15, 0.5, 'weak', 1)).toBe(4);
  });
});

describe('T1 マス補正', () => {
  it('縫いはテーブル値×2 (base12 倍率1 普通 補正2 = 24)', () => {
    expect(sewDamage(12, 1, 'normal', 2)).toBe(24);
  });
  it('縫いはテーブル値×4 (base12 倍率1 普通 補正4 = 48)', () => {
    expect(sewDamage(12, 1, 'normal', 4)).toBe(48);
  });
  it('糸ほぐし補正2は単純2倍でない (弱い base-6: 補正1=3, 補正2=6)', () => {
    // 補正1: ceil(-6×0.5×1)=ceil(-3)=-3, 補正2: ceil(-6×0.5×2)=ceil(-6)=-6
    expect(hogushiDamage(-6, 'weak', 1)).toBe(-3);
    expect(hogushiDamage(-6, 'weak', 2)).toBe(-6);
  });
  it('糸ほぐし 弱い base-9: 補正1=4 だが単純2倍=8ではなく補正2=9', () => {
    // 補正1: ceil(-9×0.5)=ceil(-4.5)=-4, 補正2: ceil(-9×1)=-9
    expect(hogushiDamage(-9, 'weak', 1)).toBe(-4);
    expect(hogushiDamage(-9, 'weak', 2)).toBe(-9);
  });
});
